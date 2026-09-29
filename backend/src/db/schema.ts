/**
 * SQLite schema (better-sqlite3).
 *
 * firms_detections — every raw VIIRS NRT detection ingested from FIRMS.
 *   UNIQUE(lat,lng,acq_date,acq_time,satellite) makes ingestion idempotent:
 *   INSERT OR IGNORE can be replayed any number of times without duplicates.
 *   Indexed on (lat,lng) and acq_date — every downstream query filters by
 *   location window and/or time window (§3).
 *
 * facilities — OSM industrial sites from the Overpass ingestion job. Live
 *   requests never hit Overpass; only this table (§3).
 *
 * ingest_state — tiny key/value store for job bookkeeping (last refresh,
 *   archive progress) so jobs are resumable and reportable.
 *
 * facility_risk_cache — per-facility cached components of the unified Risk
 *   Score (environment + temporal signals, computed by pyrosense_ml's
 *   nightly pipeline and pushed here). The base (FRP-anomaly) component is
 *   always recomputed live from stored detections — it is cheap and local —
 *   so only the two ML-derived components are cached.
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS facilities (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  type       TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'osm',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facilities_geo ON facilities (lat, lng);
CREATE INDEX IF NOT EXISTS idx_facilities_type ON facilities (type);

CREATE TABLE IF NOT EXISTS user_facilities (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  lat              REAL NOT NULL,
  lng              REAL NOT NULL,
  type             TEXT NOT NULL DEFAULT 'Industrial Site',
  boundary_geojson TEXT,
  capacity         TEXT,
  operator         TEXT,
  source           TEXT NOT NULL DEFAULT 'user_dataset',
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_facilities_geo ON user_facilities (lat, lng);
CREATE INDEX IF NOT EXISTS idx_user_facilities_type ON user_facilities (type);

CREATE TABLE IF NOT EXISTS firms_detections (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  lat               REAL NOT NULL,
  lng               REAL NOT NULL,
  bright_ti4        REAL,
  bright_ti5        REAL,
  scan              REAL,
  track             REAL,
  frp               REAL NOT NULL DEFAULT 0,
  acq_date          TEXT NOT NULL,
  acq_time          TEXT NOT NULL,
  satellite         TEXT NOT NULL,
  instrument        TEXT NOT NULL,
  confidence        TEXT NOT NULL DEFAULT '',
  daynight          TEXT NOT NULL DEFAULT '',
  region            TEXT NOT NULL DEFAULT '',
  facility_id       TEXT,
  match_distance_km REAL,
  match_type        TEXT,
  UNIQUE (lat, lng, acq_date, acq_time, satellite)
);

CREATE INDEX IF NOT EXISTS idx_detections_geo_time   ON firms_detections (lat, lng, acq_date);
CREATE INDEX IF NOT EXISTS idx_detections_acq_date   ON firms_detections (acq_date);
CREATE INDEX IF NOT EXISTS idx_detections_region     ON firms_detections (region);
CREATE INDEX IF NOT EXISTS idx_detections_facility   ON firms_detections (facility_id);

CREATE TABLE IF NOT EXISTS facility_baselines (
  facility_id      TEXT PRIMARY KEY,
  baseline_json    TEXT NOT NULL,
  window_days      INTEGER NOT NULL,
  detection_count  INTEGER NOT NULL,
  computed_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facility_risk_cache (
  facility_id           TEXT PRIMARY KEY,
  environment_signal    REAL,
  temporal_signal       REAL,
  temporal_source       TEXT,
  computed_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facility_risk_cache_computed_at
  ON facility_risk_cache (computed_at);
`;
