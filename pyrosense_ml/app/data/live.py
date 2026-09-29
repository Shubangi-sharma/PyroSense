"""Live data access — hotspots and predictions created at runtime (source='live').

Also hosts the optional FIRMS NRT ingestion scheduler (off by default; the
Node.js backend's 15-min cron is the primary ingest). When enabled, the
scheduler stores raw detections in `live_detections`; feature engineering for
live predictions prefers this service's own detections first, then falls back
to reading the Node backend's SQLite DB.
"""

from __future__ import annotations

import asyncio
import csv
import io
import logging
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import Hotspot, LiveDetection, Prediction, TimelineSnapshot

logger = logging.getLogger("pyrosense.ml.live")

SOURCE_LIVE = "live"


@dataclass
class CreatedHotspot:
    hotspot: Hotspot
    created: bool


async def get_or_create_live_hotspot(
    session: AsyncSession,
    *,
    latitude: float,
    longitude: float,
    region: str | None = None,
    snap_digits: int = 3,
) -> CreatedHotspot:
    """Find or create a live hotspot snapped to a ~110 m grid (3 decimals).

    Snapping means repeated predictions for effectively the same location
    accumulate history on one hotspot row instead of spawning duplicates.
    """
    lat_s = round(latitude, snap_digits)
    lng_s = round(longitude, snap_digits)
    existing = (
        await session.execute(
            select(Hotspot).where(
                Hotspot.source == SOURCE_LIVE,
                Hotspot.latitude == lat_s,
                Hotspot.longitude == lng_s,
            )
        )
    ).scalar_one_or_none()
    if existing:
        return CreatedHotspot(hotspot=existing, created=False)

    hotspot = Hotspot(
        hotspot_uid=f"live-{lat_s:.3f}_{lng_s:.3f}",
        source=SOURCE_LIVE,
        latitude=lat_s,
        longitude=lng_s,
        region=region,
        feature_snapshot={},
    )
    session.add(hotspot)
    await session.flush()
    return CreatedHotspot(hotspot=hotspot, created=True)


async def save_prediction(
    session: AsyncSession,
    *,
    hotspot: Hotspot,
    result,  # PredictionResult (kept loose to avoid a circular import)
    risk_score: float,
    top_contributing_features: list[dict],
    source: str = SOURCE_LIVE,
    dataset_version: str | None = None,
) -> Prediction:
    """Persist an inference result + enrich the hotspot's feature snapshot."""
    pred = Prediction(
        hotspot_id=hotspot.id,
        source=source,
        predicted_class=result.predicted_class,
        probabilities=result.probabilities,
        confidence=result.confidence,
        risk_score=risk_score,
        top_contributing_features=top_contributing_features,
        model_version=result.model_version,
        dataset_version=dataset_version or result.dataset_version,
        feature_schema_version=result.feature_schema_version,
        feature_snapshot=dict(result.features),
        prediction_timestamp=result.prediction_timestamp,
    )
    session.add(pred)
    if not hotspot.feature_snapshot:
        hotspot.feature_snapshot = dict(result.features)
    await session.flush()
    return pred


# ── FIRMS ingestion (scheduler mode only) ───────────────────────────────────


def _f(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse_firms_csv(content: str) -> list[dict]:
    """Parse a FIRMS Area API CSV body into detection dicts (idempotent keys)."""
    rows: list[dict] = []
    reader = csv.DictReader(io.StringIO(content))
    for r in reader:
        try:
            rows.append(
                {
                    "latitude": float(r["latitude"]),
                    "longitude": float(r["longitude"]),
                    "bright_ti4": _f(r.get("bright_ti4")),
                    "bright_ti5": _f(r.get("bright_ti5")),
                    "frp": _f(r.get("frp")) or 0.0,
                    "confidence": r.get("confidence") or None,
                    "daynight": r.get("daynight") or None,
                    "satellite": r.get("satellite") or None,
                    "instrument": r.get("instrument") or None,
                    "acq_date": date.fromisoformat(r["acq_date"]),
                    "acq_time": (r.get("acq_time") or "0").zfill(4),
                }
            )
        except (KeyError, ValueError, TypeError):
            continue
    return rows


async def fetch_firms_rows(
    *,
    south: float,
    west: float,
    north: float,
    east: float,
    day_range: int = 2,
) -> list[dict]:
    """Fetch + parse a FIRMS NRT CSV for a bbox (no DB involved).

    NASA's Area API wants bbox as `west,south,east,north` (same order the
    Node backend uses) and hard-caps day_range at 5. Error payloads are plain
    text without a header row — detected via the "latitude" column name.
    """
    days = min(max(1, round(day_range)), 5)
    url = (
        f"{settings.FIRMS_BASE_URL}/{settings.FIRMS_MAP_KEY}"
        f"/VIIRS_SNPP_NRT/{west},{south},{east},{north}/{days}"
    )
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url)
        resp.raise_for_status()
    text = resp.text.strip()
    if not text or "latitude" not in text.split("\n", 1)[0]:
        raise ValueError(f"FIRMS error payload: {text[:120]}")
    return parse_firms_csv(text)


async def store_detections(session: AsyncSession, rows: list[dict]) -> int:
    """Bulk-insert detections, skipping rows already stored (natural key).

    One `INSERT … ON CONFLICT DO NOTHING` statement for the whole batch —
    per-row savepoints would be far too slow at FIRMS cycle volumes.
    Duplicates *within* the payload are pre-deduped (last wins, matching
    idempotent-replay semantics).
    """
    if not rows:
        return 0
    unique: dict[tuple, dict] = {}
    for row in rows:
        key = (
            row["latitude"],
            row["longitude"],
            row["acq_date"],
            row["acq_time"],
            row["satellite"],
        )
        unique[key] = row
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    stmt = (
        pg_insert(LiveDetection)
        .on_conflict_do_nothing()
        .returning(LiveDetection.id)
    )
    result = await session.execute(stmt, list(unique.values()))
    await session.flush()
    return len(result.scalars().all())


async def ingest_firms_bbox(
    session: AsyncSession,
    *,
    south: float,
    west: float,
    north: float,
    east: float,
    day_range: int = 2,
) -> int:
    """Fetch FIRMS NRT CSV for a bbox and store into live_detections."""
    rows = await fetch_firms_rows(
        south=south, west=west, north=north, east=east, day_range=day_range
    )
    return await store_detections(session, rows)


# ── Scheduled ingestion (mirrors the Node backend's refreshLiveFirms job) ───

# Same region set as backend/src/config/regions.ts — India box + global chunks.
INGEST_REGIONS: list[dict] = [
    {"id": "india", "south": 6, "west": 68, "north": 36, "east": 98},
    {"id": "af", "south": -35, "west": -20, "north": 37, "east": 52},
    {"id": "eu", "south": 34, "west": -25, "north": 71, "east": 60},
    {"id": "as", "south": 0, "west": 52, "north": 55, "east": 150},
    {"id": "me", "south": 12, "west": 34, "north": 42, "east": 63},
    {"id": "na", "south": 12, "west": -170, "north": 72, "east": -50},
    {"id": "sa", "south": -56, "west": -85, "north": 13, "east": -34},
    {"id": "oc", "south": -50, "west": 110, "north": 0, "east": 180},
]


async def run_ingest_cycle(day_range: int = 2) -> int:
    """One ingestion pass over all regions. Returns total rows inserted.

    Per-region failure isolation — one region's error never kills the cycle.
    Each region commits in its own transaction.
    """
    from app.db.engine import get_session_factory

    cycle_started = time.monotonic()
    inserted_total = 0
    for region in INGEST_REGIONS:
        try:
            rows = await fetch_firms_rows(
                south=region["south"],
                west=region["west"],
                north=region["north"],
                east=region["east"],
                day_range=day_range,
            )
        except Exception as exc:
            logger.warning("firms fetch failed for region %s: %s", region["id"], exc)
            continue
        if not rows:
            continue
        try:
            factory = get_session_factory()
            async with factory() as session:
                async with session.begin():
                    inserted = await store_detections(session, rows)
            inserted_total += inserted
        except Exception as exc:
            logger.warning("firms store failed for region %s: %s", region["id"], exc)
    logger.info(
        "live ingest cycle done: %d new detections in %.1fs",
        inserted_total,
        time.monotonic() - cycle_started,
    )
    return inserted_total


async def live_ingest_loop() -> None:
    """Background FIRMS NRT polling task (opt-in via ENABLE_LIVE_INGEST_SCHEDULER).

    Mirrors the Node backend's refreshLiveFirms job: every
    LIVE_INGEST_INTERVAL_MINUTES, fetch the last 2 days for India + the 7
    global chunks. Runs one cycle immediately at startup, then sleeps.
    """
    interval_s = settings.LIVE_INGEST_INTERVAL_MINUTES * 60
    logger.info(
        "live ingest scheduler started (every %d min, %d regions)",
        settings.LIVE_INGEST_INTERVAL_MINUTES,
        len(INGEST_REGIONS),
    )
    while True:
        try:
            await run_ingest_cycle()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("live ingest cycle crashed: %s", exc)
        await asyncio.sleep(interval_s)


# ── Feature-history access for live feature engineering ─────────────────────


def detection_history_query_sqlite(
    lat: float,
    lng: float,
    radius_km: float,
    since: datetime,
) -> tuple[str, dict]:
    """SQL + params for nearby detection history from the Node backend's DB."""
    import math

    since_str = since.strftime("%Y-%m-%d")
    deg = radius_km / 111.0
    lng_scale = max(0.1, math.cos(math.radians(lat)))
    return (
        """
        SELECT lat, lng, frp, acq_date, acq_time, bright_ti4, bright_ti5
        FROM firms_detections
        WHERE lat BETWEEN :min_lat AND :max_lat
          AND lng BETWEEN :min_lng AND :max_lng
          AND acq_date >= :since
        """,
        {
            "min_lat": lat - deg,
            "max_lat": lat + deg,
            "min_lng": lng - deg / lng_scale,
            "max_lng": lng + deg / lng_scale,
            "since": since_str,
        },
    )


async def record_timeline_snapshot(
    session: AsyncSession,
    *,
    hotspot: Hotspot,
    prediction: Prediction,
    snapshot_date: date | None = None,
) -> TimelineSnapshot:
    """Upsert the daily timeline snapshot for a hotspot from its prediction."""
    d = snapshot_date or datetime.now(timezone.utc).date()
    existing = (
        await session.execute(
            select(TimelineSnapshot).where(
                TimelineSnapshot.hotspot_id == hotspot.id,
                TimelineSnapshot.snapshot_date == d,
            )
        )
    ).scalar_one_or_none()
    if existing:
        existing.predicted_class = prediction.predicted_class
        existing.confidence = prediction.confidence
        existing.risk_score = prediction.risk_score
        existing.key_drivers = prediction.top_contributing_features
        existing.source = prediction.source
        await session.flush()
        return existing

    snap = TimelineSnapshot(
        hotspot_id=hotspot.id,
        snapshot_date=d,
        source=prediction.source,
        predicted_class=prediction.predicted_class,
        confidence=prediction.confidence,
        risk_score=prediction.risk_score,
        key_drivers=prediction.top_contributing_features,
    )
    session.add(snap)
    await session.flush()
    return snap


def retention_cutoff(days: int) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=days)
