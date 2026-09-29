"""Pipeline orchestrator — runs the Phase 2C stages in dependency order,
recording each run in pipeline_job_runs for /internal/health.

Stages:
1. ingest      — FIRMS NRT fetch → live_detections (existing app.data.live)
2. weather     — per-cell Open-Meteo fetch → weather_daily
3. aggregate   — detections + weather → firms_daily_h3 (17-feature store)
4. risk        — rolling 30-day windows → 3 GRUs → risk_predictions
5. hotspots    — DBSCAN persistence → classification → hotspot_clusters

Each stage is isolated: a failure records a 'failed' job row and skips the
stages that depend on it, never crashing the whole run.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import PipelineJobRun, WeatherDaily

logger = logging.getLogger("pyrosense.ml.pipeline.orchestrator")

JOB_NAMES = ("ingest", "weather", "aggregate", "risk", "hotspots", "facility_risk")

# Concurrent Open-Meteo fetches per batch (public community API — be gentle).
WEATHER_FETCH_CONCURRENCY = 8


async def _record_job(
    session: AsyncSession,
    job_name: str,
    status: str,
    rows_processed: int,
    error: str | None,
    started_at: datetime,
):
    """Append one finished job run row (own flush; caller commits)."""
    run = PipelineJobRun(
        job_name=job_name,
        status=status,
        rows_processed=rows_processed,
        error=(error[:2000] if error else None),
        started_at=started_at,
        finished_at=datetime.now(timezone.utc),
    )
    session.add(run)
    await session.flush()


async def run_weather_stage(session: AsyncSession, *, days: int = 10) -> dict:
    """Fetch weather for every cell active in the aggregation window.

    HTTP fetches fan out concurrently (WEATHER_FETCH_CONCURRENCY at a time —
    the public archive API is a shared free resource); DB writes stay on the
    one session and run sequentially between batches.
    """
    import asyncio

    import h3

    from app.pipeline.weather_fetch import archive_end_day, fetch_weather_rows, store_weather_rows

    end = archive_end_day()
    start = end - timedelta(days=days)

    # Cells seen in recent detections — the ones the store needs weather for.
    from app.db.models import LiveDetection

    det_rows = (
        await session.execute(
            select(LiveDetection.latitude, LiveDetection.longitude).where(
                LiveDetection.acq_date >= start
            )
        )
    ).all()
    cells = {
        h3.latlng_to_cell(float(lat), float(lng), 7)
        for lat, lng in det_rows
    }

    # Build all fetch coroutines first (pure HTTP, no session use), then run
    # them in bounded batches; store each batch's rows before the next.
    def _fetch_coro(cell: str):
        lat_c, lng_c = h3.cell_to_latlng(cell)
        return fetch_weather_rows(
            lat=float(lat_c), lng=float(lng_c), h3_cell=cell, start=start, end=end
        )

    pending = [(cell, _fetch_coro(cell)) for cell in sorted(cells)]
    fetched = 0
    for i in range(0, len(pending), WEATHER_FETCH_CONCURRENCY):
        batch = pending[i : i + WEATHER_FETCH_CONCURRENCY]
        results = await asyncio.gather(*(coro for _cell, coro in batch))
        for (_cell, _coro), rows in zip(batch, results):
            fetched += await store_weather_rows(session, rows)
    return {"cells": len(cells), "rows": fetched, "start": start.isoformat(), "end": end.isoformat()}


async def run_aggregate_stage(session: AsyncSession, *, days: int = 10) -> dict:
    """Aggregate the last `days` days into firms_daily_h3."""
    from app.pipeline.h3_aggregate import aggregate_day

    end = date.today() - timedelta(days=1)
    totals = {"cells": 0, "rows_upserted": 0, "rows_excluded": 0}
    for offset in range(days):
        day = end - timedelta(days=offset)
        counters = await aggregate_day(session, day)
        for k in totals:
            totals[k] += counters.get(k, 0)
    return totals


async def run_risk_stage(session: AsyncSession) -> dict:
    from app.pipeline.risk_batch import run_risk_pipeline

    r = await run_risk_pipeline(session)
    return {
        "as_of": r.as_of.isoformat(),
        "cells_eligible": r.cells_eligible,
        "cells_insufficient": r.cells_insufficient,
        "rows_upserted": r.rows_upserted,
    }


async def run_hotspots_stage(session: AsyncSession, *, lookback_days: int = 60) -> dict:
    from app.pipeline.hotspots_pipeline import run_hotspot_pipeline

    return await run_hotspot_pipeline(session, lookback_days=lookback_days)


async def run_facility_risk_stage(session: AsyncSession) -> dict:
    """Compute + store per-facility Risk Score components (env + temporal)."""
    from app.pipeline.facility_risk import run_facility_risk_stage as run_stage

    return await run_stage(session)


async def run_full_pipeline(session: AsyncSession, *, days: int = 10) -> dict:
    """Run all stages in order with job-run bookkeeping. Returns stage reports."""
    from app.data.live import run_ingest_cycle

    reports: dict[str, object] = {}

    async def _stage(name: str, fn, *, depends_on: list[str] | None = None):
        started = datetime.now(timezone.utc)
        if depends_on and any(reports.get(d, {}).get("status") == "failed" for d in depends_on):
            await _record_job(session, name, "failed", 0, f"skipped: upstream failure", started)
            reports[name] = {"status": "skipped"}
            return
        try:
            result = await fn()
            rows = result.get("rows", 0) if isinstance(result, dict) else 0
            if name == "aggregate":
                rows = result.get("rows_upserted", 0)
            elif name == "risk":
                rows = result.get("rows_upserted", 0)
            elif name == "hotspots":
                rows = result.get("persistent", 0)
            elif name == "facility_risk":
                rows = result.get("computed", 0)
            await _record_job(session, name, "success", int(rows), None, started)
            reports[name] = {"status": "success", **(result if isinstance(result, dict) else {})}
        except Exception as exc:  # noqa: BLE001 — stage isolation is the contract
            logger.exception("pipeline stage %s failed", name)
            await _record_job(session, name, "failed", 0, str(exc), started)
            reports[name] = {"status": "failed", "error": str(exc)}

    # 1. Ingest (fetch FIRMS; own sessions inside run_ingest_cycle)
    await _stage("ingest", lambda: run_ingest_cycle(day_range=2))

    # 2+3. Weather + aggregation (same session, commit at the end)
    async def _weather():
        r = await run_weather_stage(session, days=days)
        await session.commit()
        return r

    async def _aggregate():
        r = await run_aggregate_stage(session, days=days)
        await session.commit()
        return r

    async def _risk():
        r = await run_risk_stage(session)
        await session.commit()
        return r

    async def _hotspots():
        r = await run_hotspots_stage(session, lookback_days=60)
        await session.commit()
        return r

    await _stage("weather", _weather, depends_on=["ingest"])
    await _stage("aggregate", _aggregate, depends_on=["ingest", "weather"])
    await _stage("risk", _risk, depends_on=["aggregate"])
    await _stage("hotspots", _hotspots, depends_on=["ingest"])

    # 6. Facility risk components (reads risk_predictions → must follow risk)
    async def _facility_risk():
        r = await run_facility_risk_stage(session)
        await session.commit()
        return r

    await _stage("facility_risk", _facility_risk, depends_on=["risk"])

    return reports


async def last_runs_per_job(session: AsyncSession) -> dict[str, dict]:
    """Latest run per job name — the payload behind /internal/health."""
    rows = (
        (
            await session.execute(
                select(PipelineJobRun).order_by(PipelineJobRun.started_at.desc()).limit(50)
            )
        )
        .scalars()
        .all()
    )
    latest: dict[str, PipelineJobRun] = {}
    for r in rows:
        if r.job_name not in latest:
            latest[r.job_name] = r
    return {
        name: {
            "status": r.status,
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
            "rows_processed": r.rows_processed,
            "error": r.error,
        }
        for name, r in sorted(latest.items())
    }


# Re-exported for the API layer's weather-freshness check.
WEATHER_STALENESS_LIMIT_DAYS = 8  # 7-day fill + 1 day of slack
