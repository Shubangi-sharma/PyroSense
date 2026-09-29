"""Facility-risk pipeline stage — per-facility Risk Score components.

For every facility Node pushed via POST /internal/facility-risk/sync (the
rows registered in facility_risk_cache), compute and store:

- environment_signal: the classification-derived risk (weighted probability ×
  category danger weights) from the SAME engineering + inference path the
  live /internal/classify endpoint uses. Nothing is persisted to hotspots or
  predictions — this is a scoring component, not a new hotspot record.
- temporal_signal: the facility's H3-r7 cell GRU risk — the unweighted mean
  of the stored 1/3/7-day horizon probabilities × 100 (matching Node's
  riskScoreService::temporalSignalFromCellRisk exactly). If a horizon
  probability is missing, the overall bucket maps HIGH=100 / MODERATE=55 /
  LOW=15 (the documented degraded path, identical on both sides).

Runs as a pipeline stage AFTER `risk` (it reads risk_predictions) and after
`hotspots` in stage order. Idempotent: every pass recomputes and upserts the
components with a fresh computed_at, keyed by facility_id.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import FacilityRiskCache, RiskPrediction

logger = logging.getLogger("pyrosense.ml.pipeline.facility_risk")

# Mirrors Node's riskScoreService bucket fallback exactly.
OVERALL_BUCKETS = {"HIGH": 100.0, "MODERATE": 55.0, "LOW": 15.0}
HORIZONS = ("1day", "3day", "7day")


def temporal_from_horizons(
    horizons: dict[str, dict] | None,
    overall: str | None,
) -> tuple[float, str] | None:
    """GRU horizons → (temporal signal 0-100, source tag). Pure; shared shape
    with Node's temporalSignalFromCellRisk so both sides always agree.

    Raw probabilities win (unweighted mean × 100); the overall bucket is the
    documented degraded fallback when probabilities are missing entirely.
    Returns None when there is neither a probability nor a known bucket.
    """
    probs: list[float] = []
    for h in HORIZONS:
        entry = (horizons or {}).get(h) or {}
        p = entry.get("probability")
        if isinstance(p, (int, float)) and 0.0 <= float(p) <= 1.0:
            probs.append(float(p))
    if probs:
        return (sum(probs) / len(probs)) * 100.0, "raw_probabilities"
    if overall in OVERALL_BUCKETS:
        return OVERALL_BUCKETS[overall], "overall_bucket_fallback"
    return None


async def run_facility_risk_stage(session: AsyncSession) -> dict:
    """Compute + upsert per-facility environment + temporal components."""
    from app.features.engineer import engineer_features
    from app.ml.inference import predict as run_inference
    from app.ml.predict_weights import compute_classification_risk_score

    rows = (
        (await session.execute(select(FacilityRiskCache))).scalars().all()
    )
    if not rows:
        return {"status": "success", "facilities": 0, "computed": 0}

    # One cell → many facilities (a res-7 cell is ~5 km across); batch the
    # risk_predictions read per cell instead of per facility.
    cells = {
        _cell_for(float(r.latitude), float(r.longitude)) for r in rows
    }
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

    computed = 0
    now = datetime.now(timezone.utc)
    for r in rows:
        env_signal: float | None = None
        temporal_signal: float | None = None
        temporal_source: str | None = None

        # Environment component: engineering + inference (no persistence).
        try:
            engineered = await engineer_features(float(r.latitude), float(r.longitude))
            result = run_inference(engineered.features)
            env_signal = compute_classification_risk_score(result.probabilities)
        except Exception as exc:  # noqa: BLE001 — per-facility isolation
            logger.warning(
                "facility %s: environment component failed (%s)", r.facility_id, exc
            )

        # Temporal component: stored nightly GRU prediction for the cell.
        cell = _cell_for(float(r.latitude), float(r.longitude))
        t = temporal_from_horizons(
            horizons_by_cell.get(cell), overall_by_cell.get(cell)
        )
        if t is not None:
            temporal_signal, temporal_source = t

        r.environment_signal = env_signal
        r.temporal_signal = temporal_signal
        r.temporal_source = temporal_source
        r.computed_at = now
        computed += 1

    await session.flush()
    return {
        "status": "success",
        "facilities": len(rows),
        "computed": computed,
        "cells": len(cells),
    }


def _cell_for(lat: float, lng: float) -> str:
    import h3

    return h3.latlng_to_cell(lat, lng, 7)
