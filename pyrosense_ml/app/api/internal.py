"""Internal ML API — called ONLY by the Node BFF, never by the browser.

Contract (Phase 3 / PDF §9): every response carries model_version,
feature_schema_version and a data_timestamp so the frontend can honestly
display freshness ("as of 14:32") instead of implying live certainty
(PDF §17 mitigation).

Routes (all mounted under the /internal prefix by app.api.router):
  GET  /internal/risk/{h3_cell}      latest stored 1/3/7-day risk + overall
  POST /internal/risk/batch          { h3_cells: [...] } batched (map viewport)
  GET  /internal/hotspots            persistent + recent clusters, bbox filter
  GET  /internal/hotspots/{uid}      full detail incl. contextual type
  POST /internal/classify            live/manual point → contextual type
  GET  /internal/health              model + DB + last pipeline runs

Design notes:
- Risk reads come from risk_predictions (the stored nightly run) — the API
  never runs GRU inference per request. An unknown cell returns
  status="insufficient_history" rather than an error so the map can render
  it distinctly.
- Batch endpoint caps at 5000 cells (a pan-India viewport's worth) to bound
  response size; larger requests get 413.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.health import get_db
from app.config import settings
from app.db.models import FacilityRiskCache, HotspotCluster, RiskPrediction
from app.feature_schema import (
    CLASSIFIER_CLASSES,
    CLASSIFIER_FEATURES,
    CLASSIFIER_MODEL_VERSION,
    DATASET_VERSION,
    RISK_MODEL_VERSION,
    RISK_THRESHOLDS,
    SCHEMA_VERSION,
)

logger = logging.getLogger("pyrosense.api.internal")

router = APIRouter(prefix="/internal")

BATCH_MAX_CELLS = 5000
INSUFFICIENT_HISTORY = "insufficient_history"


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Risk ─────────────────────────────────────────────────────────────────────


async def _risk_for_cells(session: AsyncSession, cells: list[str]) -> dict[str, dict]:
    rows = (
        (
            await session.execute(
                select(RiskPrediction).where(RiskPrediction.h3_cell.in_(cells))
            )
        )
        .scalars()
        .all()
    )
    by_cell: dict[str, dict] = {}
    for r in rows:
        entry = by_cell.setdefault(r.h3_cell, {"horizons": {}, "data_timestamp": None})
        entry["horizons"][r.horizon] = {
            "probability": r.probability,
            "level": r.level,
            "threshold": RISK_THRESHOLDS[r.horizon],
        }
        ts = r.data_timestamp.isoformat() if r.data_timestamp else None
        if ts and (entry["data_timestamp"] is None or ts > entry["data_timestamp"]):
            entry["data_timestamp"] = ts
        entry["overall"] = r.overall
        entry["model_version"] = r.model_version
        entry["feature_schema_version"] = r.feature_schema_version
    for cell, entry in by_cell.items():
        entry["status"] = "ok" if len(entry["horizons"]) == 3 else "partial"
    return by_cell


@router.get("/risk/{h3_cell}")
async def risk_for_cell(h3_cell: str, session: AsyncSession = Depends(get_db)):
    result = await _risk_for_cells(session, [h3_cell])
    if h3_cell not in result:
        raise HTTPException(
            status_code=404,
            detail={
                "error": "no stored risk for this cell",
                "h3_cell": h3_cell,
                "status": INSUFFICIENT_HISTORY,
            },
        )
    entry = result[h3_cell]
    entry["h3_cell"] = h3_cell
    return entry


# (constant defined above, next to BATCH_MAX_CELLS)


class RiskBatchRequest(BaseModel):
    h3_cells: list[str] = Field(min_length=1)


@router.post("/risk/batch")
async def risk_batch(body: RiskBatchRequest, session: AsyncSession = Depends(get_db)):
    cells = list(dict.fromkeys(body.h3_cells))  # dedupe, preserve order
    if len(cells) > BATCH_MAX_CELLS:
        raise HTTPException(
            status_code=413,
            detail=f"batch too large: {len(cells)} cells (max {BATCH_MAX_CELLS})",
        )
    found = await _risk_for_cells(session, cells)
    missing = [c for c in cells if c not in found]
    return {
        "risks": {c: found[c] for c in cells if c in found},
        "missing": [
            {"h3_cell": c, "status": INSUFFICIENT_HISTORY} for c in missing
        ],
        "count": len(found),
        "model_version": RISK_MODEL_VERSION,
        "feature_schema_version": SCHEMA_VERSION,
        "data_timestamp": _now().isoformat(),
    }


# ── Hotspots ─────────────────────────────────────────────────────────────────


def _cluster_summary(c: HotspotCluster) -> dict:
    return {
        "cluster_id": c.cluster_uid,
        "h3_cell": c.h3_cell,
        "latitude": c.centroid_lat,
        "longitude": c.centroid_lng,
        "unique_fire_days": c.unique_fire_days,
        "total_detections": c.total_detections,
        "first_seen": c.first_seen.isoformat(),
        "last_seen": c.last_seen.isoformat(),
        "is_persistent": c.is_persistent,
        "class": c.predicted_class,
        "confidence": c.confidence,
        "needs_review": c.needs_review,
        "model_version": c.model_version,
    }


@router.get("/hotspots")
async def hotspots(
    min_lat: float | None = Query(default=None, ge=-90, le=90),
    max_lat: float | None = Query(default=None, ge=-90, le=90),
    min_lng: float | None = Query(default=None, ge=-180, le=180),
    max_lng: float | None = Query(default=None, ge=-180, le=180),
    type: str | None = Query(default=None),
    persistent: bool | None = Query(default=None),
    limit: int = Query(default=2000, ge=1, le=20000),
    session: AsyncSession = Depends(get_db),
):
    stmt = select(HotspotCluster).order_by(HotspotCluster.last_seen.desc()).limit(limit)
    if min_lat is not None:
        stmt = stmt.where(HotspotCluster.centroid_lat >= min_lat)
    if max_lat is not None:
        stmt = stmt.where(HotspotCluster.centroid_lat <= max_lat)
    if min_lng is not None:
        stmt = stmt.where(HotspotCluster.centroid_lng >= min_lng)
    if max_lng is not None:
        stmt = stmt.where(HotspotCluster.centroid_lng <= max_lng)
    if persistent is not None:
        stmt = stmt.where(HotspotCluster.is_persistent == persistent)
    if type is not None:
        stmt = stmt.where(HotspotCluster.predicted_class == type)

    rows = ((await session.execute(stmt)).scalars().all())
    return {
        "count": len(rows),
        "hotspots": [_cluster_summary(c) for c in rows],
        "classes": list(CLASSIFIER_CLASSES),
        "model_version": CLASSIFIER_MODEL_VERSION,
        "feature_schema_version": SCHEMA_VERSION,
        "data_timestamp": _now().isoformat(),
    }


@router.get("/hotspots/{cluster_uid}")
async def hotspot_detail(cluster_uid: str, session: AsyncSession = Depends(get_db)):
    c = (
        await session.execute(select(HotspotCluster).where(HotspotCluster.cluster_uid == cluster_uid))
    ).scalar_one_or_none()
    if c is None:
        raise HTTPException(status_code=404, detail=f"hotspot cluster {cluster_uid!r} not found")
    out = _cluster_summary(c)
    out.update(
        {
            "probabilities": c.probabilities,
            "needs_review_note": (
                "classification confidence below threshold — treat as Needs Review"
                if c.needs_review
                else None
            ),
            "feature_snapshot": c.feature_snapshot,
            "feature_count": len(c.feature_snapshot or {}),
            "expected_features": list(CLASSIFIER_FEATURES),
            "dataset_version": DATASET_VERSION,
            "data_timestamp": _now().isoformat(),
        }
    )
    return out


# ── Classify (live/manual point) ─────────────────────────────────────────────


class ClassifyRequest(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


@router.post("/classify")
async def classify(body: ClassifyRequest, session: AsyncSession = Depends(get_db)):
    """Live/manual point → contextual type, with the Needs Review path.

    Re-uses the /predict engineering + inference path but does NOT persist a
    hotspot/prediction (that is /predict's job); this is the internal
    classification primitive for the BFF.
    """
    from app.features.engineer import engineer_features
    from app.ml.inference import predict as run_inference
    from app.ml.predict_weights import compute_classification_risk_score

    engineered = await engineer_features(body.latitude, body.longitude)
    try:
        result = run_inference(engineered.features)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"classification failed: {exc}") from exc

    # Classification-derived risk component of the unified Risk Score
    # (weighted probability × category danger weights — same computation
    # /predict exposes as risk_score). The Node BFF consumes exactly this
    # field for the environment signal; keeping it here makes /internal/
    # classify the complete scoring primitive (no persistence, no GenAI).
    cls_risk_score = compute_classification_risk_score(result.probabilities)

    needs_review = result.confidence < 0.40
    return {
        "latitude": body.latitude,
        "longitude": body.longitude,
        "class": result.predicted_class,
        "confidence": result.confidence,
        "probabilities": result.probabilities,
        "risk_score": cls_risk_score,
        "needs_review": needs_review,
        "needs_review_note": (
            "confidence below threshold — treat as Needs Review" if needs_review else None
        ),
        "classes": list(CLASSIFIER_CLASSES),
        "contextual_note": (
            "Labels are context-derived (OSM/land-cover/fire evidence), not "
            "independent ground-truth ignition causes."
        ),
        "feature_provenance": engineered.provenance,
        "warnings": engineered.warnings,
        "model_version": CLASSIFIER_MODEL_VERSION,
        "feature_schema_version": SCHEMA_VERSION,
        "data_timestamp": _now().isoformat(),
    }


# ── Facility risk sync (unified Risk Score components) ──────────────────


class FacilityRef(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class FacilityRiskSyncRequest(BaseModel):
    facilities: list[FacilityRef] = Field(max_length=20000)


@router.post("/facility-risk/sync")
async def facility_risk_sync(
    body: FacilityRiskSyncRequest, session: AsyncSession = Depends(get_db)
):
    """Node pushes its exact facility set; we upsert the rows and return the
    latest computed components per facility.

    Contract (mirrors /internal/risk/batch's degradation shape):
    - Row exists + computed_at set → components returned (may contain nulls
      when a component failed on the last pass).
    - Row missing (first sync) or computed_at NULL (registered, nightly stage
      has not run yet) → "pending" entry; Node composes base-only for it.

    The ML service never derives its own facility list — it answers for
    exactly the ids Node sends (facility-set mismatch resolved structurally).
    """
    from app.pipeline.facility_risk import _cell_for, temporal_from_horizons
    from datetime import timezone

    facilities = body.facilities
    # Dedupe by id, keep order.
    unique = {f.id: f for f in facilities}

    # 1. Upsert the registry rows (idempotent; coords refresh on conflict).
    rows = {
        r.facility_id: r
        for r in (
            (await session.execute(select(FacilityRiskCache))).scalars().all()
        )
    }
    now = datetime.now(timezone.utc)
    for f in unique.values():
        r = rows.get(f.id)
        if r is None:
            r = FacilityRiskCache(
                facility_id=f.id,
                latitude=f.lat,
                longitude=f.lng,
                computed_at=None,
            )
            session.add(r)
            rows[f.id] = r
        else:
            r.latitude = f.lat
            r.longitude = f.lng
            # Not bumping computed_at: components remain until recomputed.
    await session.flush()

    # 2. Batch the stored GRU predictions for all referenced cells.
    cells = {_cell_for(float(f.lat), float(f.lng)) for f in unique.values()}
    cell_rows = (
        (
            await session.execute(
                select(RiskPrediction).where(RiskPrediction.h3_cell.in_(cells))
            )
        )
        .scalars()
        .all()
    )
    horizons_by_cell: dict[str, dict[str, dict]] = {}
    overall_by_cell: dict[str, str] = {}
    for r in cell_rows:
        horizons_by_cell.setdefault(r.h3_cell, {})[r.horizon] = {
            "probability": r.probability,
        }
        overall_by_cell[r.h3_cell] = r.overall

    # 3. Serve back what is computed; refresh temporal inline for computed
    #    rows so a fresh risk run is reflected even if the facility_risk
    #    stage has not re-run since.
    out_rows: list[dict] = []
    computed = 0
    for fid, f in unique.items():
        r = rows.get(fid)
        if r is None or r.computed_at is None:
            out_rows.append({"facility_id": fid, "status": "pending"})
            continue
        env = r.environment_signal
        cell = _cell_for(float(f.lat), float(f.lng))
        t = temporal_from_horizons(
            horizons_by_cell.get(cell), overall_by_cell.get(cell)
        )
        temporal = t[0] if t else None
        source = t[1] if t else None
        if temporal is not None:
            r.temporal_signal = temporal
            r.temporal_source = source
            r.computed_at = now
        out_rows.append(
            {
                "facility_id": fid,
                "status": "ok",
                "environment_signal": env,
                "temporal_signal": temporal,
                "temporal_source": source,
                "computed_at": r.computed_at.astimezone(timezone.utc).isoformat(),
            }
        )
        computed += 1
    await session.commit()

    return {
        "synced": computed,
        "pending": len(out_rows) - computed,
        "computed_at": now.isoformat(),
        "rows": out_rows,
    }


# ── Pipeline trigger (Node cron → FastAPI batch endpoints) ───────────────


class PipelineRunRequest(BaseModel):
    days: int = Field(default=10, ge=1, le=30)
    stages: list[str] | None = None  # None = all


@router.post("/pipeline/run")
async def pipeline_run(body: PipelineRunRequest, session: AsyncSession = Depends(get_db)):
    """Run pipeline stages in order. Node's cron calls this; it is also a
    manual ops handle. Long-running: the BFF should use a generous timeout."""
    from app.pipeline.orchestrator import run_full_pipeline

    reports = await run_full_pipeline(session, days=body.days)
    await session.commit()
    return {
        "status": "done",
        "reports": reports,
        "data_timestamp": _now().isoformat(),
    }


# ── Internal health ──────────────────────────────────────────────────────────


@router.get("/health")
async def internal_health(session: AsyncSession = Depends(get_db)):
    from app.ml.model_loader import is_loaded

    from app.pipeline.orchestrator import last_runs_per_job

    pg_ok = True
    try:
        jobs = await last_runs_per_job(session)
    except Exception:
        pg_ok = False
        jobs = {}

    return {
        "status": "ok" if (pg_ok and is_loaded()) else "degraded",
        "service": "pyrosense-ml",
        "model_loaded": is_loaded(),
        "postgres_connected": pg_ok,
        "classifier_version": CLASSIFIER_MODEL_VERSION,
        "risk_model_version": RISK_MODEL_VERSION,
        "dataset_version": DATASET_VERSION,
        "feature_schema_version": SCHEMA_VERSION,
        "classifier_features": len(CLASSIFIER_FEATURES),
        "pipeline_jobs": jobs,
        "settings_echo": {
            "seed_on_startup": settings.SEED_ON_STARTUP,
        },
        "data_timestamp": _now().isoformat(),
    }
