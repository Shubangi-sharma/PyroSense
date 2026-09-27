"""Historical seeding — populate frozen hotspots + initial predictions.

Sources (first available wins):
1. `PYROSENSE_HISTORICAL_CSV` — an enriched CSV carrying the classifier's 43
   feature columns + latitude/longitude (+ optional label). This is the
   PREFERRED source: frozen, exact, reproducible.
2. SQLite clustering fallback — derive hotspots from the Node backend's
   detections. Fire/FRP/brightness features are computed from real detections;
   OSM/land-cover/weather context is not available in the 3-day NRT window, so
   those blocks use their documented 0.0 priors. Rows are marked
   `dataset_version=0.0.0-sqlite-fallback` so downstream consumers can tell
   these apart from a frozen dataset.

Every seeded hotspot gets an initial prediction from THIS service's classifier.
NOTE (Phase 2A): inference requires all 43 classifier features; rows missing
too many of them are skipped with a warning.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import pandas as pd
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.data.live import SOURCE_LIVE, save_prediction
from app.db.models import Hotspot
from app.feature_schema import (
    CLASSIFIER_FEATURES,
    CLASSIFIER_TRAINING_MEDIANS,
    DATASET_VERSION,
    validate_classifier_features,
)
from app.ml.inference import predict as run_inference

logger = logging.getLogger("pyrosense.seed")

SQLITE_FALLBACK_VERSION = "0.0.0-sqlite-fallback"

# Default location of the frozen enriched CSV (43 classifier features +
# coordinates + label). The repo ships the model artifacts but not the CSV —
# drop it here (or mount/point PYROSENSE_HISTORICAL_CSV at it) and startup
# seeds from it instead of the SQLite fallback. Resolved against the REPO ROOT
# (three levels up: app/db/seed.py -> app -> pyrosense_ml -> repo root) so the
# path works regardless of the process working directory (/srv/pyrosense_ml in
# the container, CSV lands at /srv/data).
DEFAULT_HISTORICAL_CSV = (
    Path(__file__).resolve().parents[3] / "data" / "historical_hotspots.csv"
)

# Column-name aliases accepted in the CSV for coords / label / hotspot id.
# Feature columns must match CLASSIFIER_FEATURES verbatim (no aliases).
# Canonical spellings come first so real columns are never clobbered.
_ALIASES = {
    "latitude": "latitude",
    "hotspot_latitude": "latitude",
    "lat": "latitude",
    "longitude": "longitude",
    "hotspot_longitude": "longitude",
    "lng": "longitude",
    "lon": "longitude",
    "long": "longitude",
    "label": "label",
    "final_label": "label",
    "class": "label",
    "target": "label",
    "hotspot_id": "hotspot_id",
    "hotspot_uid": "hotspot_id",
    "id": "hotspot_id",
}


def _extract_coords(row: dict) -> tuple[float, float] | None:
    lat = row.get("latitude") or row.get("lat")
    lng = row.get("longitude") or row.get("lng") or row.get("lon")
    if lat in (None, "") or lng in (None, ""):
        return None
    try:
        return float(lat), float(lng)
    except (TypeError, ValueError):
        return None


def _coerce_features(row: dict) -> dict[str, float]:
    feats: dict[str, float] = {}
    for name in CLASSIFIER_FEATURES:
        v = row.get(name)
        if v in (None, ""):
            continue
        try:
            feats[name] = float(v)
        except (TypeError, ValueError):
            continue
    return feats


def load_historical_csv(path: Path) -> list[dict]:
    """Parse an enriched CSV into seed rows (43 features + coords + label)."""
    df = pd.read_csv(path)
    df.columns = [str(c).strip() for c in df.columns]
    # Normalize alias headers (coords/label/id) to canonical names,
    # case-insensitively; never clobber an already-canonical column.
    cols_lower = {c.lower(): c for c in df.columns}
    canonical: set[str] = set(df.columns)
    rename: dict[str, str] = {}
    for alias, target in _ALIASES.items():
        src = cols_lower.get(alias)
        if src is not None and target not in canonical:
            rename[src] = target
            canonical.add(target)
    df.rename(columns=rename, inplace=True)
    rows: list[dict] = []
    for i, raw in df.iterrows():
        row = raw.to_dict()
        coords = _extract_coords(row)
        if coords is None:
            logger.warning("row %d: missing latitude/longitude — skipped", i)
            continue
        feats = _coerce_features(row)
        if len(feats) < len(CLASSIFIER_FEATURES) // 2:
            logger.warning(
                "row %d: <50%% of classifier features present (%d/%d) — skipped",
                i,
                len(feats),
                len(CLASSIFIER_FEATURES),
            )
            continue
        label = row.get("label")
        uid = row.get("hotspot_id")
        rows.append(
            {
                "latitude": coords[0],
                "longitude": coords[1],
                "features": feats,
                "label": str(label).strip() if label else None,
                "hotspot_uid": str(uid) if uid else f"hist-{i + 1:04d}",
            }
        )
    return rows


def derive_from_sqlite(min_detections: int = 5, limit: int = 552) -> list[dict]:
    """Fallback: grid-cluster the Node backend's detections into hotspots.

    These are NOT a frozen dataset — they are what the current 3-day NRT
    window supports, marked with a distinct dataset_version.

    Returns [] when the Node backend's SQLite DB is absent (e.g. the ML
    container on Render has never had it) — seeding degrades to a no-op and
    the service boots normally.
    """
    from collections import defaultdict

    from app.db.engine import sqlite_connect_readonly

    try:
        con = sqlite_connect_readonly()
    except FileNotFoundError as exc:
        logger.warning(
            "skipping SQLite-fallback seeding: %s — starting with an empty "
            "hotspots table (live predictions will create hotspots on demand)",
            exc,
        )
        return []
    try:
        rows = con.execute(
            "SELECT lat, lng, frp, acq_date FROM firms_detections ORDER BY acq_date"
        ).fetchall()
    finally:
        con.close()

    clusters: dict[tuple, list] = defaultdict(list)
    for r in rows:
        key = (round(r["lat"] * 100) / 100, round(r["lng"] * 100) / 100)
        clusters[key].append(r)

    out: list[dict] = []
    for (lat, lng), dets in clusters.items():
        if len(dets) < min_detections:
            continue
        dates = sorted(d["acq_date"] for d in dets)
        frps = [d["frp"] or 0.0 for d in dets]
        derived = {
            "unique_h3_cells": 1.0,
            "total_fire_detections": float(len(dets)),
            "unique_fire_days": float(len(set(dates))),
            "temporal_span_days": 0.0,
            "active_months": float(len({(d[:4], d[5:7]) for d in dates})),
            "mean_frp": sum(frps) / len(frps),
            "max_frp": max(frps),
        }
        # The 3-day NRT window cannot supply OSM/land-cover/weather context.
        # Fill those from the documented priors (rows carry
        # dataset_version=0.0.0-sqlite-fallback for traceability).
        feats = {**CLASSIFIER_TRAINING_MEDIANS, **derived}
        out.append(
            {
                "latitude": lat,
                "longitude": lng,
                "features": feats,
                "label": None,
                "hotspot_uid": f"hist-sqlite-{lat:.2f}_{lng:.2f}",
            }
        )
        if len(out) >= limit:
            break
    return out


async def seed_if_empty(session: AsyncSession) -> int:
    """Seed historical hotspots when the table has none. Returns rows seeded."""
    existing = (
        await session.execute(
            select(func.count()).select_from(Hotspot).where(Hotspot.source == "historical")
        )
    ).scalar_one()

    csv_path = os.environ.get("PYROSENSE_HISTORICAL_CSV")
    if existing == 0:
        if not csv_path and (DEFAULT_HISTORICAL_CSV).exists():
            csv_path = str(DEFAULT_HISTORICAL_CSV)
        if csv_path and Path(csv_path).exists():
            rows = load_historical_csv(Path(csv_path))
            dataset_version = DATASET_VERSION
        else:
            if csv_path:
                logger.warning("PYROSENSE_HISTORICAL_CSV set but missing: %s", csv_path)
            rows = derive_from_sqlite()
            dataset_version = SQLITE_FALLBACK_VERSION
        seeded = await _seed_rows(session, rows, dataset_version)
        logger.info(
            "seeded %d historical hotspots (dataset=%s, source=%s)",
            seeded,
            dataset_version,
            "csv" if csv_path and Path(csv_path).exists() else "sqlite-fallback",
        )
        return seeded
    return 0


async def _seed_rows(session: AsyncSession, rows: list[dict], dataset_version: str) -> int:
    seeded = 0
    for row in rows:
        feats = row["features"]
        try:
            validate_classifier_features(feats)
            result = run_inference(feats)
        except Exception as exc:
            logger.warning("hotspot %s: inference failed (%s) — skipped", row["hotspot_uid"], exc)
            continue

        hotspot = Hotspot(
            hotspot_uid=row["hotspot_uid"],
            source="historical",
            latitude=row["latitude"],
            longitude=row["longitude"],
            feature_snapshot=feats,
        )
        session.add(hotspot)
        await session.flush()

        await save_prediction(
            session,
            hotspot=hotspot,
            result=result,
            risk_score=0.0,  # legacy scalar column; GRU risk needs Phase 2C
            top_contributing_features=[],  # per-feature importances not exposed by the MLP
            source="historical",
            dataset_version=dataset_version,
        )
        seeded += 1
    await session.commit()
    return seeded
