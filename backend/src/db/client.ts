/**
 * better-sqlite3 connection + typed prepared-statement repository.
 *
 * One module owns the database handle; everything else goes through these
 * prepared statements (§6). Ingestion writes are batched inside
 * transactions at the call site (db.tx), never one write per row.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { env } from "../config/env.js";
import { SCHEMA_SQL } from "./schema.js";
import { dbLog } from "../lib/logger.js";

// ── open + migrate ──────────────────────────────────────────────────────
const dbPath = path.isAbsolute(env.DATABASE_URL)
  ? env.DATABASE_URL
  : path.resolve(process.cwd(), env.DATABASE_URL);

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL"); // readers never block the ingestion writer
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");
// Read-heavy workload (map viewports + dashboard polls): a large page cache
// keeps the ~80 MB detection table's hot pages in memory instead of re-reading
// from disk on every viewport query. Memory-mapped I/O lets SQLite serve hot
// pages straight from the OS page cache without copy-through.
db.pragma("cache_size = -65536"); // 64 MB (negative = KiB units)
db.pragma("mmap_size = 268435456"); // 256 MB
db.exec(SCHEMA_SQL);
dbLog.info({ path: dbPath }, "sqlite ready");

/** Run `fn` inside one transaction (used to batch ingestion writes). */
export function tx<T>(fn: () => T): T {
  return db.transaction(fn)();
}

/* ── facilities (OSM) ─────────────────────────────────────────────────── */

const upsertFacilityStmt = db.prepare(`
  INSERT INTO facilities (id, name, lat, lng, type, source, updated_at)
  VALUES (@id, @name, @lat, @lng, @type, @source, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    lat = excluded.lat,
    lng = excluded.lng,
    type = excluded.type,
    source = excluded.source,
    updated_at = excluded.updated_at
`);

export interface FacilityRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
  type: string;
  source: string;
  updated_at: string;
  /** GeoJSON polygon boundary (user_facilities only, null for OSM). */
  boundary_geojson?: string | null;
  capacity?: string | null;
  operator?: string | null;
}

export const upsertFacility = (f: Omit<FacilityRow, "updated_at"> & { updated_at?: string }): void => {
  upsertFacilityStmt.run({ ...f, updated_at: f.updated_at ?? new Date().toISOString() });
};

const allFacilitiesStmt = db.prepare(`SELECT * FROM facilities ORDER BY name`);

export const getAllFacilities = (): FacilityRow[] => allFacilitiesStmt.all() as FacilityRow[];

/* ── user_facilities ──────────────────────────────────────────────────── */

const upsertUserFacilityStmt = db.prepare(`
  INSERT INTO user_facilities (id, name, lat, lng, type, boundary_geojson, capacity, operator, source, updated_at)
  VALUES (@id, @name, @lat, @lng, @type, @boundary_geojson, @capacity, @operator, @source, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    lat = excluded.lat,
    lng = excluded.lng,
    type = excluded.type,
    boundary_geojson = excluded.boundary_geojson,
    capacity = excluded.capacity,
    operator = excluded.operator,
    source = excluded.source,
    updated_at = excluded.updated_at
`);

export interface UserFacilityInput {
  id: string;
  name: string;
  lat: number;
  lng: number;
  type?: string;
  boundary_geojson?: string | null;
  capacity?: string | null;
  operator?: string | null;
  source?: string;
  updated_at?: string;
}

export const upsertUserFacility = (f: UserFacilityInput): void => {
  upsertUserFacilityStmt.run({
    id: f.id,
    name: f.name,
    lat: f.lat,
    lng: f.lng,
    type: f.type ?? "Industrial Site",
    boundary_geojson: f.boundary_geojson ?? null,
    capacity: f.capacity ?? null,
    operator: f.operator ?? null,
    source: f.source ?? "user_dataset",
    updated_at: f.updated_at ?? new Date().toISOString(),
  });
};

const allUserFacilitiesStmt = db.prepare(`SELECT * FROM user_facilities ORDER BY name`);

export const getAllUserFacilities = (): FacilityRow[] =>
  (allUserFacilitiesStmt.all() as FacilityRow[]);

/**
 * Merged view of both OSM + user facilities — the single source of truth for
 * all downstream pipeline stages. User dataset facilities take precedence over
 * OSM if they share the same id (unlikely since OSM ids are prefixed).
 */
export function getAllFacilitiesMerged(): FacilityRow[] {
  const osm = getAllFacilities();
  const user = getAllUserFacilities();
  const seen = new Set<string>();
  const merged: FacilityRow[] = [];
  // User facilities first (higher priority)
  for (const f of user) {
    seen.add(f.id);
    merged.push(f);
  }
  for (const f of osm) {
    if (!seen.has(f.id)) merged.push(f);
  }
  merged.sort((a, b) => a.name.localeCompare(b.name));
  return merged;
}

/* ── firms_detections ─────────────────────────────────────────────────── */

export interface DetectionRow {
  lat: number;
  lng: number;
  bright_ti4: number | null;
  bright_ti5: number | null;
  scan: number | null;
  track: number | null;
  frp: number;
  acq_date: string; // YYYY-MM-DD
  acq_time: string; // HHMM
  satellite: string;
  instrument: string;
  confidence: string;
  daynight: string;
  region: string;
  facility_id: string | null;
  match_distance_km: number | null;
  match_type: string | null;
}

const insertDetectionStmt = db.prepare(`
  INSERT OR IGNORE INTO firms_detections
    (lat, lng, bright_ti4, bright_ti5, scan, track, frp, acq_date, acq_time, satellite, instrument, confidence, daynight, region)
  VALUES
    (@lat, @lng, @bright_ti4, @bright_ti5, @scan, @track, @frp, @acq_date, @acq_time, @satellite, @instrument, @confidence, @daynight, @region)
`);

export type DetectionInsert = Omit<DetectionRow, "facility_id" | "match_distance_km" | "match_type">;

/** Batched, idempotent insert of many detections — call inside db.tx(). */
export const insertDetections = (rows: DetectionInsert[]): number => {
  let inserted = 0;
  for (const row of rows) {
    const result = insertDetectionStmt.run({
      ...row,
      scan: row.scan ?? null,
      track: row.track ?? null,
    });
    inserted += Number(result.changes);
  }
  return inserted;
};

export interface GeoTimeWindow {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  /** inclusive YYYY-MM-DD lower bound */
  fromDate: string;
  /** inclusive YYYY-MM-DD upper bound */
  toDate: string;
}

const detectionsInBoxStmt = db.prepare(`
  SELECT lat, lng, bright_ti4, bright_ti5, scan, track, frp, acq_date, acq_time, satellite, instrument, confidence, daynight, region, facility_id, match_distance_km, match_type
  FROM firms_detections
  WHERE lat BETWEEN @minLat AND @maxLat
    AND lng BETWEEN @minLng AND @maxLng
    AND acq_date BETWEEN @fromDate AND @toDate
`);

export const getDetectionsInBox = (w: GeoTimeWindow): DetectionRow[] =>
  detectionsInBoxStmt.all(w) as DetectionRow[];

/** Newest-first detections near a point (bounding-box prefilter + km check). */
const detectionsNearStmt = db.prepare(`
  SELECT lat, lng, bright_ti4, bright_ti5, scan, track, frp, acq_date, acq_time, satellite, instrument, confidence, daynight, region, facility_id, match_distance_km, match_type
  FROM firms_detections
  WHERE lat BETWEEN @minLat AND @maxLat
    AND lng BETWEEN @minLng AND @maxLng
    AND acq_date >= @fromDate
  ORDER BY acq_date DESC, acq_time DESC
`);

export function getDetectionsNear(
  lat: number,
  lng: number,
  radiusKm: number,
  fromDate: string,
): DetectionRow[] {
  // ~111 km per degree of latitude; pad longitude for latitude shrinkage.
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return (detectionsNearStmt.all({
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLng: lng - dLng,
    maxLng: lng + dLng,
    fromDate,
  }) as DetectionRow[]);
}

/** Distinct acquisition dates present in the DB (min, max) — honest coverage reporting. */
const coverageStmt = db.prepare(
  `SELECT MIN(acq_date) AS minDate, MAX(acq_date) AS maxDate, COUNT(*) AS rows FROM firms_detections`,
);

export function getCoverage(): { minDate: string | null; maxDate: string | null; rows: number } {
  const r = coverageStmt.get() as { minDate: string | null; maxDate: string | null; rows: number };
  return { minDate: r.minDate ?? null, maxDate: r.maxDate ?? null, rows: Number(r.rows) };
}

/* ── detection matching updates ───────────────────────────────────────── */

const updateMatchStmt = db.prepare(`
  UPDATE firms_detections
  SET facility_id = @facility_id, match_distance_km = @match_distance_km, match_type = @match_type
  WHERE id = @id
`);

export function updateDetectionMatch(id: number, facilityId: string, distKm: number, matchType: string): void {
  updateMatchStmt.run({ id, facility_id: facilityId, match_distance_km: distKm, match_type: matchType });
}

/** Get unmatched detections (facility_id IS NULL) in a region for batch matching. */
const unmatchedDetectionsStmt = db.prepare(`
  SELECT id, lat, lng, bright_ti4, bright_ti5, scan, track, frp, acq_date, acq_time, satellite, instrument, confidence, daynight, region, facility_id, match_distance_km, match_type
  FROM firms_detections
  WHERE facility_id IS NULL
  ORDER BY acq_date DESC
  LIMIT 50000
`);

export interface DetectionRowWithId extends DetectionRow {
  id: number;
}

export const getUnmatchedDetections = (): DetectionRowWithId[] =>
  unmatchedDetectionsStmt.all() as DetectionRowWithId[];

/** Get detections matched to a specific facility. */
const detectionsByFacilityStmt = db.prepare(`
  SELECT lat, lng, bright_ti4, bright_ti5, scan, track, frp, acq_date, acq_time, satellite, instrument, confidence, daynight, region, facility_id, match_distance_km, match_type
  FROM firms_detections
  WHERE facility_id = @facilityId
    AND acq_date >= @fromDate
  ORDER BY acq_date DESC, acq_time DESC
`);

export function getDetectionsByFacility(facilityId: string, fromDate: string): DetectionRow[] {
  return detectionsByFacilityStmt.all({ facilityId, fromDate }) as DetectionRow[];
}

/* ── facility_baselines ───────────────────────────────────────────────── */

const upsertBaselineStmt = db.prepare(`
  INSERT INTO facility_baselines (facility_id, baseline_json, window_days, detection_count, computed_at)
  VALUES (@facility_id, @baseline_json, @window_days, @detection_count, @computed_at)
  ON CONFLICT(facility_id) DO UPDATE SET
    baseline_json = excluded.baseline_json,
    window_days = excluded.window_days,
    detection_count = excluded.detection_count,
    computed_at = excluded.computed_at
`);

export interface BaselineRow {
  facility_id: string;
  baseline_json: string;
  window_days: number;
  detection_count: number;
  computed_at: string;
}

export const upsertBaseline = (b: BaselineRow): void => {
  upsertBaselineStmt.run(b);
};

const getBaselineStmt = db.prepare(`SELECT * FROM facility_baselines WHERE facility_id = ?`);

export const getBaseline = (facilityId: string): BaselineRow | null =>
  (getBaselineStmt.get(facilityId) as BaselineRow | undefined) ?? null;

const allBaselinesStmt = db.prepare(`SELECT * FROM facility_baselines`);

export const getAllBaselines = (): BaselineRow[] => allBaselinesStmt.all() as BaselineRow[];

/* ── facility_risk_cache (unified Risk Score components) ──────────────── */

/** Cached ML-derived Risk Score components for one facility (see schema.ts). */
export interface FacilityRiskCacheRow {
  facility_id: string;
  environment_signal: number | null;
  temporal_signal: number | null;
  /** "raw_probabilities" (nightly GRU run) or "overall_bucket_fallback". */
  temporal_source: string | null;
  computed_at: string;
}

const upsertRiskCacheStmt = db.prepare(`
  INSERT INTO facility_risk_cache (facility_id, environment_signal, temporal_signal, temporal_source, computed_at)
  VALUES (@facility_id, @environment_signal, @temporal_signal, @temporal_source, @computed_at)
  ON CONFLICT(facility_id) DO UPDATE SET
    environment_signal = excluded.environment_signal,
    temporal_signal = excluded.temporal_signal,
    temporal_source = excluded.temporal_source,
    computed_at = excluded.computed_at
`);

export const upsertFacilityRiskCache = (r: {
  facility_id: string;
  environment_signal: number | null;
  temporal_signal: number | null;
  temporal_source: string | null;
  computed_at: string;
}): void => {
  upsertRiskCacheStmt.run(r);
};

const allRiskCacheStmt = db.prepare(`SELECT * FROM facility_risk_cache`);

export const getAllFacilityRiskCache = (): FacilityRiskCacheRow[] =>
  allRiskCacheStmt.all() as FacilityRiskCacheRow[];

const riskCacheByIdStmt = db.prepare(`SELECT * FROM facility_risk_cache WHERE facility_id = ?`);

export const getFacilityRiskCache = (facilityId: string): FacilityRiskCacheRow | null =>
  (riskCacheByIdStmt.get(facilityId) as FacilityRiskCacheRow | undefined) ?? null;

/* ── dataset-wide stats (command view) ────────────────────────────────── */

const dbStatsStmt = db.prepare(`
  SELECT
    COUNT(DISTINCT CASE WHEN facility_id LIKE 'UTS-%' THEN facility_id END) AS unidentifiedSources
  FROM firms_detections
`);

/** Distinct unmatched thermal sources the matcher flagged (UTS-* ids). */
export function getDbStats(): { unidentifiedSources: number } {
  const r = dbStatsStmt.get() as { unidentifiedSources: number | null };
  return { unidentifiedSources: Number(r.unidentifiedSources ?? 0) };
}

/* ── ingest_state ─────────────────────────────────────────────────────── */

const getStateStmt = db.prepare(`SELECT value FROM ingest_state WHERE key = ?`);
const setStateStmt = db.prepare(
  `INSERT INTO ingest_state (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
);

export const getState = (key: string): string | null =>
  (getStateStmt.get(key) as { value: string } | undefined)?.value ?? null;

export const setState = (key: string, value: string): void => {
  setStateStmt.run(key, value);
};

