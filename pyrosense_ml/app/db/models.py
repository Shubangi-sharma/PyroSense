"""SQLAlchemy ORM models for the PyroSense ML store (PostgreSQL/PostGIS).

Table roles
-----------
hotspots             552 historical persistent hotspots (immutable seed) and
                     any live hotspots created via /predict.
predictions          Every inference result, with the full feature snapshot.
timeline_snapshots   Daily aggregated per-hotspot snapshots (slider support).
genai_explanations   Cached LLM explanations keyed by prediction + input hash.
live_detections      Live FIRMS detections ingested by THIS service (only used
                     when ENABLE_LIVE_INGEST_SCHEDULER is on).

Feature store (Phase 2B — the GRU/classifier pipelines' canonical input):
firms_daily_h3       Per H3-r7 cell per day: the exact 17 RISK_FEATURES the
                     GRUs consume, in feature_names.pkl order. The rolling
                     30-day window is read straight from this table.
weather_daily        Per cell per day: raw Open-Meteo daily values. Kept raw
                     so forward-fill (<=7 days, the V3->V4 lesson) can be
                     re-derived/re-played without re-fetching.
risk_predictions     Latest GRU run per (cell, horizon): probabilities +
                     HIGH/LOW + overall level, timestamped and versioned.
hotspot_clusters     Persistent-hotspot pipeline output: H3-r8 grouping,
                     DBSCAN cluster label, fire-day count, contextual class.
pipeline_job_runs    One row per pipeline stage run (ingest / aggregate /
                     risk / hotspots) — /internal/health reports from here.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from geoalchemy2 import Geography
from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from app.feature_schema import (
    CLASSIFIER_FEATURES,
    CLASSIFIER_MODEL_VERSION,
    DATASET_VERSION,
    RISK_FEATURES,
    RISK_MODEL_VERSION,
    SCHEMA_VERSION,
)


class Base(DeclarativeBase):
    pass


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# JSONB on PostgreSQL, plain JSON elsewhere (tests may run on SQLite? — no:
# tests use PostgreSQL via DATABASE_URL override; JSONB is fine).
JSONVariant = JSONB().with_variant(JSON(), "sqlite")


class Hotspot(Base):
    __tablename__ = "hotspots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    hotspot_uid: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    source: Mapped[str] = mapped_column(String(16), nullable=False, default="historical")
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    geom = mapped_column(Geography(geometry_type="POINT", srid=4326), nullable=True)
    region: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # Frozen feature values for historical rows (source of truth for seeding)
    feature_snapshot: Mapped[dict] = mapped_column(JSONVariant, nullable=False, default=dict)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    predictions: Mapped[list["Prediction"]] = relationship(
        back_populates="hotspot", cascade="all, delete-orphan"
    )

    __table_args__ = (
        UniqueConstraint("hotspot_uid", name="uq_hotspots_uid"),
        Index("ix_hotspots_source", "source"),
        Index("ix_hotspots_latlng", "latitude", "longitude"),
    )


class Prediction(Base):
    __tablename__ = "predictions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    hotspot_id: Mapped[int] = mapped_column(
        ForeignKey("hotspots.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source: Mapped[str] = mapped_column(String(16), nullable=False, default="live")

    predicted_class: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    probabilities: Mapped[dict] = mapped_column(JSONVariant, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    risk_score: Mapped[float] = mapped_column(Float, nullable=False, index=True)

    top_contributing_features: Mapped[list] = mapped_column(JSONVariant, nullable=False, default=list)

    model_version: Mapped[str] = mapped_column(String(32), nullable=False, default=CLASSIFIER_MODEL_VERSION)
    dataset_version: Mapped[str] = mapped_column(String(32), nullable=False, default=DATASET_VERSION)
    feature_schema_version: Mapped[str] = mapped_column(String(32), nullable=False, default=SCHEMA_VERSION)

    feature_snapshot: Mapped[dict] = mapped_column(JSONVariant, nullable=False)

    prediction_timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )

    hotspot: Mapped["Hotspot"] = relationship(back_populates="predictions")
    explanations: Mapped[list["GenAIExplanation"]] = relationship(
        back_populates="prediction", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("ix_predictions_hotspot_time", "hotspot_id", "prediction_timestamp"),
    )


class TimelineSnapshot(Base):
    __tablename__ = "timeline_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    hotspot_id: Mapped[int] = mapped_column(
        ForeignKey("hotspots.id", ondelete="CASCADE"), nullable=False
    )
    snapshot_date: Mapped[date] = mapped_column(Date, nullable=False)
    source: Mapped[str] = mapped_column(String(16), nullable=False)

    predicted_class: Mapped[str] = mapped_column(String(64), nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    risk_score: Mapped[float] = mapped_column(Float, nullable=False, index=True)
    key_drivers: Mapped[list] = mapped_column(JSONVariant, nullable=False, default=list)

    __table_args__ = (
        UniqueConstraint("hotspot_id", "snapshot_date", name="uq_timeline_hotspot_date"),
        Index("ix_timeline_hotspot_date", "hotspot_id", "snapshot_date"),
    )


class GenAIExplanation(Base):
    __tablename__ = "genai_explanations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    prediction_id: Mapped[int | None] = mapped_column(
        ForeignKey("predictions.id", ondelete="CASCADE"), nullable=True, index=True
    )
    features_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    provider: Mapped[str] = mapped_column(String(32), nullable=False, default="openrouter")
    model_name: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    grounded: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    explanation: Mapped[str] = mapped_column(Text, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    prediction: Mapped["Prediction | None"] = relationship(back_populates="explanations")

    __table_args__ = (
        UniqueConstraint("features_hash", name="uq_genai_features_hash"),
    )


class LiveDetection(Base):
    """FIRMS detection ingested by THIS service (scheduler mode only)."""

    __tablename__ = "live_detections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    hotspot_id: Mapped[int | None] = mapped_column(
        ForeignKey("hotspots.id", ondelete="SET NULL"), nullable=True, index=True
    )

    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    bright_ti4: Mapped[float | None] = mapped_column(Float, nullable=True)
    bright_ti5: Mapped[float | None] = mapped_column(Float, nullable=True)
    frp: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    confidence: Mapped[str | None] = mapped_column(String(16), nullable=True)
    daynight: Mapped[str | None] = mapped_column(String(8), nullable=True)
    satellite: Mapped[str | None] = mapped_column(String(32), nullable=True)
    instrument: Mapped[str | None] = mapped_column(String(32), nullable=True)
    acq_date: Mapped[date] = mapped_column(Date, nullable=False)
    acq_time: Mapped[str] = mapped_column(String(8), nullable=False, default="0000")
    region: Mapped[str | None] = mapped_column(String(64), nullable=True)

    ingested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint(
            "latitude",
            "longitude",
            "acq_date",
            "acq_time",
            "satellite",
            name="uq_live_detections_natural_key",
        ),
        Index("ix_live_detections_geo_date", "latitude", "longitude", "acq_date"),
    )


# Reference: the 43 frozen classifier features this store's snapshots carry.
# (Phase 2A: the old 36-feature GBM schema was replaced by the 43-feature
# classifier; risk-model sequences are a separate schema — see feature_schema.)
FEATURE_NAMES_REF = list(CLASSIFIER_FEATURES)


class FirmsDailyH3(Base):
    """One row per (H3-r7 cell, day) with the 17 GRU features, frozen order.

    feature_vector is a JSONB *list* of 17 floats in exactly RISK_FEATURES
    order — the pipelines scale and stack it directly into (30, 17) windows.
    fire_count is ALSO a real column so eligibility queries ("any fire in the
    last 30 days?") and freshness queries can use an index instead of a
    full-table scan over JSONB.
    """

    __tablename__ = "firms_daily_h3"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    h3_cell: Mapped[str] = mapped_column(String(32), nullable=False)
    day: Mapped[date] = mapped_column(Date, nullable=False)

    feature_vector: Mapped[list] = mapped_column(JSONVariant, nullable=False)
    fire_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # Aggregation provenance: which detection rows contributed, any fill that
    # was applied (weather forward-fill etc.), and the raw per-feature values
    # pre-fill for auditing.
    contributing_detections: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    fill_applied: Mapped[dict] = mapped_column(JSONVariant, nullable=False, default=dict)

    ingested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("h3_cell", "day", name="uq_firms_daily_h3_cell_day"),
        Index("ix_firms_daily_h3_cell_day", "h3_cell", "day"),
        Index("ix_firms_daily_h3_day", "day"),
    )


class WeatherDaily(Base):
    """Raw per-cell per-day weather from Open-Meteo (pre-fill)."""

    __tablename__ = "weather_daily"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    h3_cell: Mapped[str] = mapped_column(String(32), nullable=False)
    day: Mapped[date] = mapped_column(Date, nullable=False)

    temperature_2m_mean: Mapped[float | None] = mapped_column(Float, nullable=True)
    temperature_2m_max: Mapped[float | None] = mapped_column(Float, nullable=True)
    temperature_2m_min: Mapped[float | None] = mapped_column(Float, nullable=True)
    wind_speed_10m_max: Mapped[float | None] = mapped_column(Float, nullable=True)
    wind_speed_10m_mean: Mapped[float | None] = mapped_column(Float, nullable=True)
    dew_point_2m_mean: Mapped[float | None] = mapped_column(Float, nullable=True)
    relative_humidity_mean: Mapped[float | None] = mapped_column(Float, nullable=True)
    relative_humidity_min: Mapped[float | None] = mapped_column(Float, nullable=True)
    precipitation_sum: Mapped[float | None] = mapped_column(Float, nullable=True)
    shortwave_radiation_sum: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Open-Meteo free archive has no daily RH/SSRD; those two may stay NULL.
    observations: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("h3_cell", "day", name="uq_weather_daily_cell_day"),
        Index("ix_weather_daily_cell_day", "h3_cell", "day"),
    )


class RiskPrediction(Base):
    """Latest stored GRU risk output per (cell, horizon).

    Upserted by the risk pipeline; read by /internal/risk* endpoints. One row
    per cell per horizon (not one row with three blobs) so per-horizon history
    queries stay cheap.
    """

    __tablename__ = "risk_predictions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    h3_cell: Mapped[str] = mapped_column(String(32), nullable=False)
    horizon: Mapped[str] = mapped_column(String(8), nullable=False)  # 1day|3day|7day

    probability: Mapped[float] = mapped_column(Float, nullable=False)
    level: Mapped[str] = mapped_column(String(8), nullable=False)  # HIGH|LOW
    overall: Mapped[str] = mapped_column(String(8), nullable=False)  # HIGH|MODERATE|LOW

    model_version: Mapped[str] = mapped_column(String(32), nullable=False, default=RISK_MODEL_VERSION)
    feature_schema_version: Mapped[str] = mapped_column(String(32), nullable=False, default=SCHEMA_VERSION)
    data_timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    predicted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint("h3_cell", "horizon", name="uq_risk_predictions_cell_horizon"),
        Index("ix_risk_predictions_cell", "h3_cell"),
        Index("ix_risk_predictions_overall", "overall"),
    )


class HotspotCluster(Base):
    """Persistent-hotspot pipeline output (H3-8 index + DBSCAN cluster)."""

    __tablename__ = "hotspot_clusters"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    cluster_uid: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    h3_cell: Mapped[str] = mapped_column(String(32), nullable=False, index=True)  # H3-r8 of centroid

    centroid_lat: Mapped[float] = mapped_column(Float, nullable=False)
    centroid_lng: Mapped[float] = mapped_column(Float, nullable=False)

    unique_fire_days: Mapped[int] = mapped_column(Integer, nullable=False)
    total_detections: Mapped[int] = mapped_column(Integer, nullable=False)
    first_seen: Mapped[date] = mapped_column(Date, nullable=False)
    last_seen: Mapped[date] = mapped_column(Date, nullable=False)
    is_persistent: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)  # >= 5 fire days

    # Contextual classification (MLP) + provenance of the context features.
    predicted_class: Mapped[str | None] = mapped_column(String(64), nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    probabilities: Mapped[dict | None] = mapped_column(JSONVariant, nullable=True)
    needs_review: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    feature_snapshot: Mapped[dict] = mapped_column(JSONVariant, nullable=False, default=dict)

    model_version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index("ix_hotspot_clusters_persistent", "is_persistent"),
        Index("ix_hotspot_clusters_latlng", "centroid_lat", "centroid_lng"),
    )


class FacilityRiskCache(Base):
    """Per-facility cached components of the unified Risk Score.

    Node PUSHES its exact facility set via POST /internal/facility-risk/sync
    (the ML service never derives its own facility list — the facility-set
    mismatch problem is structurally resolved: we answer for exactly the ids
    Node sends). Two row states:

    - registered (computed_at IS NULL): coords stored, components pending —
      the nightly facility_risk pipeline stage will fill them;
    - computed (computed_at set): environment_signal (ML classification-risk,
      weather+land+OSM informed) and temporal_signal (GRU 1/3/7-day mean for
      the facility's H3-r7 cell) are populated and served back on the next
      sync read.

    Only computed rows travel back to Node; uncomputed facilities simply have
    no row there and compose base-only (documented degraded mode).
    """

    __tablename__ = "facility_risk_cache"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    facility_id: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)

    environment_signal: Mapped[float | None] = mapped_column(Float, nullable=True)
    temporal_signal: Mapped[float | None] = mapped_column(Float, nullable=True)
    # "raw_probabilities" (GRU horizon mean) or "overall_bucket_fallback".
    temporal_source: Mapped[str | None] = mapped_column(String(32), nullable=True)

    computed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index("ix_facility_risk_cache_computed_at", "computed_at"),
    )


class PipelineJobRun(Base):
    """One row per pipeline stage run — powers /internal/health."""

    __tablename__ = "pipeline_job_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_name: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    # running|success|failed
    status: Mapped[str] = mapped_column(String(8), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rows_processed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        Index("ix_pipeline_job_runs_name_started", "job_name", "started_at"),
    )


RISK_FEATURE_NAMES_REF = list(RISK_FEATURES)
