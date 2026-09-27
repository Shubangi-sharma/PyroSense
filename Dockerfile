# Root Dockerfile — builds the pyrosense_ml FastAPI service (Phase 5.3).
# Lives at repo root so the build context can include data_science/ (the
# frozen model artifacts). Node keeps its own backend/Dockerfile.
#
#   docker build -t pyrosense-ml -f Dockerfile .
#
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# TensorFlow/oneDNN thread pools assume bare-metal cores; on Render's cgroup-
# limited CPUs they over-subscribe and crash the process (free(): invalid
# pointer, exit 139) right after model load. Cap every thread pool explicitly
# and disable oneDNN's custom ops (see docs on TF thread env vars).
ENV OMP_NUM_THREADS=1 \
    TF_NUM_INTRAOPS_THREADS=1 \
    TF_NUM_INTEROPS_THREADS=1 \
    TF_ENABLE_ONEDNN_OPTS=0

# tensorflow needs libgomp; psycopg needs libpq; curl for healthchecks.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 libpq5 curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

# uv for reproducible installs from uv.lock.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Dependency specs first for layer caching.
COPY pyrosense_ml/pyproject.toml pyrosense_ml/uv.lock ./pyrosense_ml/

# Project deps (no dev group).
RUN cd pyrosense_ml && uv sync --frozen --no-dev

# App code, migrations, scripts.
COPY pyrosense_ml/app ./pyrosense_ml/app
COPY pyrosense_ml/alembic ./pyrosense_ml/alembic
COPY pyrosense_ml/alembic.ini ./pyrosense_ml/
COPY pyrosense_ml/scripts ./pyrosense_ml/scripts
COPY pyrosense_ml/tests/fixtures ./pyrosense_ml/tests/fixtures

# The frozen model artifacts — model_loader resolves these relative to the
# REPO ROOT (data_science/…), so they land at /srv/data_science.
COPY data_science ./data_science
COPY FINAL_GRADIENT_BOOSTING_MODEL.pkl ./FINAL_GRADIENT_BOOSTING_MODEL.pkl

ENV PYTHONPATH=/srv/pyrosense_ml
WORKDIR /srv/pyrosense_ml

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -sf http://localhost:5000/health || exit 1

CMD ["/srv/pyrosense_ml/.venv/bin/python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "5000", "--loop", "asyncio"]
