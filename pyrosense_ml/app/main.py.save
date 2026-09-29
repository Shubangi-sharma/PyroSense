"""PyroSense ML service — FastAPI application entry point.

Lifespan: load + validate model → connect PostgreSQL → ensure schema →
seed historical hotspots (when empty). Fails fast on any of these — a ML
service that cannot prove its model/DB/schema consistency must not serve.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.config import settings
from app.feature_schema import (
    CLASSIFIER_CLASSES,
    CLASSIFIER_FEATURES,
    CLASSIFIER_MODEL_VERSION,
    SCHEMA_VERSION,
)


def _setup_logging() -> None:
    """Structured JSON logging, matching the Node backend's pino output."""
    handler = logging.StreamHandler(sys.stdout)

    class JsonFormatter(logging.Formatter):
        def format(self, record: logging.LogRecord) -> str:
            import json
            import time

            payload = {
                "level": record.levelname.lower(),
                "time": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)),
                "name": record.name,
                "msg": record.getMessage(),
            }
            if record.exc_info:
                payload["err"] = self.formatException(record.exc_info)
            return json.dumps(payload)

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.INFO)
    handler.setFormatter(JsonFormatter())
    # httpx logs full request URLs at INFO — that would leak the FIRMS MAP_KEY
    # (it is a path segment) into logs. Client libraries stay at WARNING.
    for noisy in ("httpx", "httpcore", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _setup_logging()
    logger = logging.getLogger("pyrosense.startup")

    # 1. Models — load + validate classifier + GRU risk models against the
    # frozen schema (hard-fails on any mismatch).
    from app.ml.model_loader import load_model

    loaded = load_model()
    logger.info(
        "models ready: classifier_version=%s schema=%s classifier_features=%d "
        "classes=%s legacy_gbm_loaded=%s risk_horizons=%s",
        CLASSIFIER_MODEL_VERSION,
        SCHEMA_VERSION,
        len(CLASSIFIER_FEATURES),
        list(CLASSIFIER_CLASSES),
        loaded.gbm_pipeline is not None,
        sorted(loaded.risk_models),
    )

    # 2. PostgreSQL — connectivity + schema + seed.
    from sqlalchemy import text

    from app.db.engine import get_engine, get_session_factory
    from app.db.models import Base
    from app.db.seed import seed_if_empty

    engine = get_engine()
    async with engine.begin() as conn:
        await conn.execute(text("SELECT 1"))
        try:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
        except Exception:
            await conn.rollback()
            logger.info(
                "postgis extension not created at startup (needs superuser; setup_db.sh handles it)"
            )
        # Alembic owns migrations in prod; dev/bootstrap creates tables directly.
        await conn.run_sync(Base.metadata.create_all)

    factory = get_session_factory()
    async with factory() as session:
        if settings.SEED_ON_STARTUP:
            await seed_if_empty(session)

    # 3. Optional FIRMS live-ingest scheduler (Node.js cron remains primary).
    ingest_task: asyncio.Task | None = None
    if settings.ENABLE_LIVE_INGEST_SCHEDULER:
        if not settings.FIRMS_MAP_KEY:
            logger.warning(
                "ENABLE_LIVE_INGEST_SCHEDULER=true but FIRMS_MAP_KEY empty — scheduler disabled"
            )
        else:
            from app.data.live import live_ingest_loop

            ingest_task = asyncio.create_task(
                live_ingest_loop(), name="pyrosense-live-ingest"
            )

    logger.info("pyrosense-ml ready on port %d", settings.PORT)
    yield

    if ingest_task is not None:
        ingest_task.cancel()
        try:
            await ingest_task
        except asyncio.CancelledError:
            pass
        logger.info("live ingest scheduler stopped")


def create_app() -> FastAPI:
    app = FastAPI(
        title="PyroSense ML Service",
        version=CLASSIFIER_MODEL_VERSION,
        description="ML inference, risk scoring, timelines, and GenAI explanations",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=_cors_regex(settings.cors_origins),
        allow_methods=["GET", "POST"],
        allow_credentials=False,
    )
    app.include_router(api_router)
    return app


def _cors_regex(patterns: list[str]) -> str | None:
    """Origin regex matching the Node backend's whole-segment wildcard style."""
    import re

    if "*" in patterns:
        return ".*"
    wildcard = [p for p in patterns if "*" in p]
    if not wildcard:
        return None
    # "http://localhost:*" → http://localhost:[0-9]+ ; host-prefix wildcards too
    escaped = [
        re.escape(p).replace(r"\*", r"[^.]*").replace(r":\*", r":\d+")
        for p in wildcard
    ]
    return "^(" + "|".join(escaped) + ")$"


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.HOST, port=settings.PORT)
