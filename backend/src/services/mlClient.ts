/**
 * mlClient — typed, resilient client for the pyrosense_ml internal API.
 *
 * Phase 3 middleware contract (the BFF hardening):
 * - Circuit breaker: after ML_BREAKER_THRESHOLD consecutive failures the
 *   breaker OPENS for ML_BREAKER_COOLDOWN_MS; requests fail fast with a
 *   stale-cache chance instead of hanging. Half-open after cooldown.
 * - Timeout budget: every call bounded by ML_TIMEOUT_MS — a slow ML service
 *   degrades the map to stale-but-labeled data, never a hung request.
 * - Concurrency lane: p-limit so a viewport burst can't stampede FastAPI.
 * - Zod validation on the FastAPI→Node boundary: schema drift is caught
 *   here and logged, never shipped as NaN/undefined to the map.
 */

import { LRUCache } from "lru-cache";
import pLimit from "p-limit";
import { z } from "zod";
import { env } from "../config/env.js";
import { httpRequest } from "../lib/http.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ module: "mlClient" });

/* ── Zod schemas: the /internal contract, validated at the boundary ─────── */

const RiskHorizonSchema = z.object({
  probability: z.number().finite().min(0).max(1),
  level: z.enum(["HIGH", "LOW"]),
  threshold: z.number().finite(),
});

const RiskEntrySchema = z.object({
  h3_cell: z.string().min(1).optional(),
  horizons: z.record(z.string(), RiskHorizonSchema),
  overall: z.string().min(1),
  status: z.string().min(1),
  data_timestamp: z.string().min(1).nullable(),
  model_version: z.string().min(1).optional(),
  feature_schema_version: z.string().min(1).optional(),
});

export type RiskEntry = z.infer<typeof RiskEntrySchema>;

const RiskBatchResponseSchema = z.object({
  risks: z.record(z.string(), RiskEntrySchema),
  missing: z.array(z.object({ h3_cell: z.string(), status: z.string() })),
  count: z.number().int().nonnegative(),
  model_version: z.string(),
  feature_schema_version: z.string(),
  data_timestamp: z.string(),
});

/**
 * Classification-derived risk component of the unified Risk Score —
 * /internal/classify's risk_score (weighted probability × category danger
 * weights, weather+land+OSM-informed via feature engineering). Schema mirrors
 * predict.py's category weighting contract (risk_score ∈ [0, 100]).
 */
const ClassificationRiskResponseSchema = z.object({
  risk_score: z.number().finite().min(0).max(100),
  class: z.string(),
  confidence: z.number().finite(),
  feature_provenance: z.record(z.string(), z.string()),
  data_timestamp: z.string(),
});

export type ClassificationRiskResult = z.infer<typeof ClassificationRiskResponseSchema>;

/**
 * Per-facility cached Risk Score components pushed by pyrosense_ml's nightly
 * pipeline (POST /internal/facility-risk/sync → upserted into the Node
 * backend's facility_risk_cache table).
 */
const FacilityRiskSyncResponseSchema = z.object({
  synced: z.number().int().nonnegative(),
  computed_at: z.string(),
});

const HotspotSummarySchema = z.object({
  cluster_id: z.string(),
  h3_cell: z.string(),
  latitude: z.number().finite(),
  longitude: z.number().finite(),
  unique_fire_days: z.number().int().nonnegative(),
  total_detections: z.number().int().nonnegative(),
  first_seen: z.string(),
  last_seen: z.string(),
  is_persistent: z.boolean(),
  class: z.string().nullable(),
  confidence: z.number().finite().nullable(),
  needs_review: z.boolean(),
  model_version: z.string().nullable(),
});

const HotspotListResponseSchema = z.object({
  count: z.number().int().nonnegative(),
  hotspots: z.array(HotspotSummarySchema),
  classes: z.array(z.string()),
  model_version: z.string(),
  feature_schema_version: z.string(),
  data_timestamp: z.string(),
});

export type MlHotspotSummary = z.infer<typeof HotspotSummarySchema>;

/* ── Circuit breaker ────────────────────────────────────────────────────── */

type BreakerState = "closed" | "open" | "half-open";

const breaker = {
  state: "closed" as BreakerState,
  failures: 0,
  openedAt: 0,
  threshold: 3,
  cooldownMs: 30_000,
};

export function breakerState(): { state: BreakerState; failures: number } {
  if (breaker.state === "open" && Date.now() - breaker.openedAt >= breaker.cooldownMs) {
    breaker.state = "half-open";
  }
  return { state: breaker.state, failures: breaker.failures };
}

function recordSuccess(): void {
  breaker.failures = 0;
  breaker.state = "closed";
}

function recordFailure(): void {
  breaker.failures += 1;
  if (breaker.failures >= breaker.threshold) {
    breaker.state = "open";
    breaker.openedAt = Date.now();
    log.error({ failures: breaker.failures }, "ML circuit breaker OPEN");
  }
}

/* ── Transport ──────────────────────────────────────────────────────────── */

/** Map reads share one lane; pipeline triggers get their own (long) budget. */
const ML_QUEUE = pLimit(8);
const ML_PIPELINE_QUEUE = pLimit(1);

const ML_TIMEOUT_MS = 15_000;
const ML_PIPELINE_TIMEOUT_MS = 600_000; // nightly job can be slow

function baseUrl(): string {
  return env.ML_API_BASE_URL.replace(/\/+$/, "");
}

async function call(
  path: string,
  init: { method?: string; body?: string } = {},
  opts: { timeoutMs?: number; lane?: typeof ML_QUEUE | typeof ML_PIPELINE_QUEUE } = {},
): Promise<{ status: number; body: unknown }> {
  const lane = opts.lane ?? ML_QUEUE;
  const timeoutMs = opts.timeoutMs ?? ML_TIMEOUT_MS;
  const url = `${baseUrl()}${path}`;

  return lane(async () => {
    const { status, text } = await httpRequest(
      url,
      {
        method: init.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body,
      },
      { timeoutMs, allowHttpError: true },
    );
    try {
      return { status, body: JSON.parse(text) };
    } catch {
      throw new Error(`pyrosense_ml returned non-JSON (HTTP ${status}) for ${path}`);
    }
  });
}

/* ── Public API ─────────────────────────────────────────────────────────── */

/**
 * Batch risk for a viewport. Returns validated risks + the list of cells
 * with no stored prediction (insufficient history) — or null when the
 * breaker is open (caller serves stale/cache and labels freshness).
 */
export async function fetchRiskBatch(
  cells: string[],
): Promise<{ risks: Record<string, RiskEntry>; missing: string[]; dataTimestamp: string } | null> {
  const { state } = breakerState();
  if (state === "open") {
    log.warn("ml breaker open — fetchRiskBatch short-circuits to null");
    return null;
  }
  try {
    const { status, body } = await call(
      "/internal/risk/batch",
      { method: "POST", body: JSON.stringify({ h3_cells: cells }) },
    );
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const parsed = RiskBatchResponseSchema.parse(body);
    recordSuccess();
    return {
      risks: parsed.risks,
      missing: parsed.missing.map((m) => m.h3_cell),
      dataTimestamp: parsed.data_timestamp,
    };
  } catch (err) {
    recordFailure();
    log.warn({ err: String(err) }, "fetchRiskBatch failed");
    return null;
  }
}

/** Hotspot clusters (bbox + type + persistence filters). Null on failure. */
export async function fetchHotspots(
  query: { minLat?: number; maxLat?: number; minLng?: number; maxLng?: number; type?: string; persistent?: boolean; limit?: number },
): Promise<z.infer<typeof HotspotListResponseSchema> | null> {
  const { state } = breakerState();
  if (state === "open") return null;

  const qs = new URLSearchParams();
  if (query.minLat !== undefined) qs.set("min_lat", String(query.minLat));
  if (query.maxLat !== undefined) qs.set("max_lat", String(query.maxLat));
  if (query.minLng !== undefined) qs.set("min_lng", String(query.minLng));
  if (query.maxLng !== undefined) qs.set("max_lng", String(query.maxLng));
  if (query.type) qs.set("type", query.type);
  if (query.persistent !== undefined) qs.set("persistent", String(query.persistent));
  if (query.limit !== undefined) qs.set("limit", String(query.limit));

  try {
    const { status, body } = await call(`/internal/hotspots?${qs.toString()}`);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const parsed = HotspotListResponseSchema.parse(body);
    recordSuccess();
    return parsed;
  } catch (err) {
    recordFailure();
    log.warn({ err: String(err) }, "fetchHotspots failed");
    return null;
  }
}

/** Single-cell risk (the click panel). Null when unavailable. */
export async function fetchCellRisk(cell: string): Promise<RiskEntry | null> {
  const { state } = breakerState();
  if (state === "open") return null;
  try {
    const { status, body } = await call(`/internal/risk/${encodeURIComponent(cell)}`);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const parsed = RiskEntrySchema.parse({ ...(body as object), h3_cell: cell });
    recordSuccess();
    return parsed;
  } catch (err) {
    recordFailure();
    log.warn({ err: String(err), cell }, "fetchCellRisk failed");
    return null;
  }
}

/**
 * Environment component of the unified Risk Score: live classification-risk
 * for one point via /internal/classify (feature engineering + inference only
 * — unlike /predict it persists nothing and runs no GenAI, so it is the cheap
 * primitive for scoring). Null when the ML service is unavailable.
 */
export async function fetchClassificationRisk(
  lat: number,
  lng: number,
): Promise<ClassificationRiskResult | null> {
  const { state } = breakerState();
  if (state === "open") return null;
  try {
    const { status, body } = await call(
      "/internal/classify",
      { method: "POST", body: JSON.stringify({ latitude: lat, longitude: lng }) },
    );
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const parsed = ClassificationRiskResponseSchema.parse(body);
    recordSuccess();
    return parsed;
  } catch (err) {
    recordFailure();
    log.warn({ err: String(err), lat, lng }, "fetchClassificationRisk failed");
    return null;
  }
}

/**
 * Sync the per-facility cached Risk Score components from pyrosense_ml's
 * nightly pipeline run. Node pushes its exact facility set (ids + coords);
 * pyrosense_ml computes/caches the environment + temporal components per
 * facility and returns them for upsert into facility_risk_cache. Null when
 * the ML service is unavailable (callers keep yesterday's cache).
 */
export async function syncFacilityRisk(
  facilities: { id: string; lat: number; lng: number }[],
): Promise<
  | {
      synced: number;
      computedAt: string;
      rows: {
        facility_id: string;
        environment_signal: number | null;
        temporal_signal: number | null;
        temporal_source: string | null;
        computed_at: string;
      }[];
    }
  | null
> {
  if (facilities.length === 0) return null;
  const { state } = breakerState();
  if (state === "open") return null;
  try {
    const { status, body } = await call(
      "/internal/facility-risk/sync",
      { method: "POST", body: JSON.stringify({ facilities }) },
    );
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const parsed = z
      .object({
        synced: z.number().int().nonnegative(),
        computed_at: z.string(),
        rows: z.array(
          z.object({
            facility_id: z.string(),
            // "ok" rows carry the components; "pending" rows (first sync,
            // nightly stage has not filled them yet) carry only the id.
            status: z.string().optional(),
            environment_signal: z.number().finite().min(0).max(100).nullish(),
            temporal_signal: z.number().finite().min(0).max(100).nullish(),
            temporal_source: z.string().nullish(),
            computed_at: z.string().nullish(),
          }),
        ),
      })
      .parse(body);
    recordSuccess();
    // Only computed rows are upserted — pending facilities keep whatever
    // state they had (or stay absent, composing base-only).
    return {
      synced: parsed.synced,
      computedAt: parsed.computed_at,
      rows: parsed.rows
        .filter((r) => r.status === "ok" && r.computed_at != null)
        .map((r) => ({
          facility_id: r.facility_id,
          environment_signal: r.environment_signal ?? null,
          temporal_signal: r.temporal_signal ?? null,
          temporal_source: r.temporal_source ?? null,
          computed_at: r.computed_at as string,
        })),
    };
  } catch (err) {
    recordFailure();
    log.warn({ err: String(err), facilities: facilities.length }, "syncFacilityRisk failed");
    return null;
  }
}

/**
 * Trigger the full pipeline (Node cron → FastAPI). Never throws — returns
 * the report or null; job tracking lives in pyrosense_ml's pipeline_job_runs.
 */
export async function triggerPipeline(days = 10): Promise<unknown | null> {
  try {
    const { status, body } = await call(
      "/internal/pipeline/run",
      { method: "POST", body: JSON.stringify({ days }) },
      { timeoutMs: ML_PIPELINE_TIMEOUT_MS, lane: ML_PIPELINE_QUEUE },
    );
    if (status !== 200) throw new Error(`HTTP ${status}`);
    recordSuccess();
    return body;
  } catch (err) {
    recordFailure();
    log.error({ err: String(err) }, "triggerPipeline failed");
    return null;
  }
}

/** Internal health for the Node /health rollup. */
export async function fetchMlHealth(): Promise<unknown | null> {
  try {
    const { status, body } = await call("/internal/health");
    if (status !== 200) throw new Error(`HTTP ${status}`);
    recordSuccess();
    return body;
  } catch (err) {
    recordFailure();
    return null;
  }
}

/* ── Response cache (stale-serving when the breaker is open) ────────────── */

const respCache = new LRUCache<string, { body: unknown; at: number }>({
  max: 200,
  ttl: 60_000,
});

function cacheKey(prefix: string, key: string): string {
  return `${prefix}:${key}`;
}

/** Small helper used by routes to remember the last good payload per key. */
export function rememberGood(prefix: string, key: string, body: unknown): void {
  respCache.set(cacheKey(prefix, key), { body, at: Date.now() });
}

/** Last good payload for a key, with its age — for stale-but-labeled mode. */
export function lastGood(prefix: string, key: string): { body: unknown; ageMs: number } | null {
  const hit = respCache.get(cacheKey(prefix, key));
  if (!hit) return null;
  return { body: hit.body, ageMs: Date.now() - hit.at };
}
