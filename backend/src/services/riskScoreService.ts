/**
 * riskScoreService — THE single composition point for the unified Risk Score.
 *
 * ── What this replaces ───────────────────────────────────────────────────
 * Before this module, the repo had four disagreeing score concepts:
 *   1. scoringService.computeBaseScore (100 − penalties → higher =
 *      HEALTHIER), exposed to users as "Thermal Health Score".
 *   2. pyrosense_ml's classification-derived risk (weighted probability ×
 *      category danger weights → higher = more risky), absent from the
 *      backend's own score entirely.
 *   3. The GRU 1/3/7-day temporal risk signals (stored nightly in
 *      risk_predictions, keyed by H3 cell).
 *   4. command.controller's ad hoc computeRiskScore blend (healthRisk*0.4 +
 *      rule-based classRisk*0.3 + frpRisk*0.2 + trendRisk*0.1), which mixed
 *      concepts 1 and a rule-based classifier into a second number shown
 *      alongside #1 on /api/command.
 * (2)–(4) are retired by this module; (1) survives ONLY as the base signal's
 * input below. Per the Phase 2A precedent in pyrosense_ml/app/ml/risk_score.py
 * (the legacy weighted-probability-sum formula was removed "intentionally not
 * preserved anywhere, not even as a comment"), the old blends are deleted,
 * not deprecated.
 *
 * ── Composition ──────────────────────────────────────────────────────────
 *   riskScore = 0.40 × base          (FRP-anomaly rule, inverted)
 *             + 0.35 × environment   (ML classification-risk, weather+land+OSM informed)
 *             + 0.25 × temporal      (GRU 1/3/7-day, environment/history informed)
 * renormalized over whichever signals are actually available (weights of
 * available signals are scaled to sum to 1 — never a missing signal treated
 * as 0). The base signal is always available (pure local computation), so
 * the worst case is base-only, never a fully-missing score.
 *
 * Direction contract: 0–100, HIGHER = MORE RISK, everywhere.
 *
 * Provenance contract: every result names the signals that actually
 * contributed ("base" | "environment" | "temporal"), reusing the
 * *_provenance naming convention already established by feature_provenance
 * (predict.py) and explanation_provenance (genai/explanation_service.py).
 *
 * Freshness contract: `live` distinguishes a just-computed score (detail
 * views) from a cached composition (bulk views) so the UI can label each
 * honestly ("live, just computed" vs "as of <timestamp>").
 */

import type { FacilityRow } from "../db/client.js";
import { fetchCellRisk, fetchClassificationRisk, type RiskEntry } from "./mlClient.js";
import h3 from "h3-js";

/* ── weights (single source of truth) ───────────────────────────────────── */

export const BASE_WEIGHT = 0.4;
export const ENVIRONMENT_WEIGHT = 0.35;
export const TEMPORAL_WEIGHT = 0.25;

/* ── result shape ───────────────────────────────────────────────────────── */

export interface RiskScoreResult {
  /** 0–100, rounded; higher = more risk. */
  riskScore: number;
  /** Which signals actually contributed, in composition order. */
  riskScoreProvenance: string[];
  /** ISO timestamp — when the newest contributing signal was computed. */
  computedAt: string;
  /** true = just computed from current signals; false = cached composition. */
  live: boolean;
}

/* ── signal → 0–100 risk contribution ───────────────────────────────────── */

/**
 * Base signal — the FRP-anomaly rule, inverted.
 *
 * computeBaseScore returns 100 − clamped(discounted): a 100-minus-health
 * semantic inversion, not an ad hoc "100 − score" bolt-on. We compute it as
 * `100 − classification.score` at this integration point rather than
 * re-deriving `discounted`, so the health-score internals live in exactly
 * one place (scoringService).
 *
 * Edge case asserted by tests: a fully quiet site (liveCount === 0) scores
 * QUIET_BASELINE (90), not 100, so its base contribution is exactly 10,
 * not 0 — a quiet site still carries a small residual risk.
 */
export function baseSignalFromScore(classificationScore: number): number {
  return clamp100(100 - classificationScore);
}

function clamp100(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

/* ── composition core (pure, unit-tested) ───────────────────────────────── */

export interface RiskComponents {
  base: number;
  environment: number | null;
  temporal: number | null;
}

function composeFromComponents(
  components: RiskComponents,
  opts: { live: boolean; computedAt: string; includeBase?: boolean },
): RiskScoreResult {
  const parts: { signal: string; weight: number; value: number }[] = [];
  // Hotspot mode (includeBase: false, §2.6 of the design doc): an
  // unregistered hotspot has no facility detection history to anchor the
  // FRP-anomaly base signal, so the remaining weights renormalize over
  // environment + temporal only.
  if (opts.includeBase !== false) {
    parts.push({ signal: "base", weight: BASE_WEIGHT, value: clamp100(components.base) });
  }
  if (components.environment != null) {
    parts.push({ signal: "environment", weight: ENVIRONMENT_WEIGHT, value: clamp100(components.environment) });
  }
  if (components.temporal != null) {
    parts.push({ signal: "temporal", weight: TEMPORAL_WEIGHT, value: clamp100(components.temporal) });
  }
  if (parts.length === 0) {
    // Degenerate: no signal contributed at all (hotspot mode with the ML
    // service down and no stored prediction). 0 with an EMPTY provenance
    // list means "unavailable", never "no risk" — the UI must treat an
    // empty provenance as missing data.
    return { riskScore: 0, riskScoreProvenance: [], computedAt: opts.computedAt, live: opts.live };
  }

  const weightSum = parts.reduce((s, p) => s + p.weight, 0);
  const raw = parts.reduce((s, p) => s + p.value * p.weight, 0) / weightSum;
  const riskScore = Math.round(clamp100(raw));

  return {
    riskScore,
    riskScoreProvenance: parts.map((p) => p.signal),
    computedAt: opts.computedAt,
    live: opts.live,
  };
}

/* ── environment signal (cached) ────────────────────────────────────────── */

/**
 * Small TTL cache for the environment component. /internal/classify
 * engineers features live (Overpass + land cover + weather — tens of
 * seconds cold, varying with external-source health), so detail views of
 * the same site would otherwise re-pay that on every request. Keyed at 4
 * decimal places (~11 m) — same site, same signal; TTL bounds staleness.
 * Failures are NOT cached: the next request retries (best-effort lane).
 */
const ENV_CACHE_MAX = 500;
const ENV_CACHE_TTL_MS = 10 * 60 * 1000;
const envCache = new Map<string, { at: number; value: number }>();

async function classificationRiskCached(lat: number, lng: number): Promise<number | null> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const hit = envCache.get(key);
  if (hit && Date.now() - hit.at < ENV_CACHE_TTL_MS) return hit.value;
  const res = await fetchClassificationRisk(lat, lng);
  const value = res?.risk_score ?? null;
  if (value != null) {
    if (envCache.size >= ENV_CACHE_MAX) {
      const oldest = envCache.keys().next().value;
      if (oldest !== undefined) envCache.delete(oldest);
    }
    envCache.set(key, { at: Date.now(), value });
  }
  return value;
}

/* ── temporal signal from GRU horizons ──────────────────────────────────── */

/**
 * Temporal signal = unweighted mean of the three GRU horizon probabilities ×
 * 100. Equal weighting across horizons is a deliberate choice: the three
 * GRUs are independent models trained for different decision timescales, and
 * a 7-day-out escalation is not less "real" risk than a 1-day one, just
 * differently timed. If product feedback wants near-term risk weighted
 * higher, that is a one-line change isolated here.
 *
 * Bucket fallback (only when raw horizon probabilities are missing, e.g. an
 * old stored row): HIGH=100, MODERATE=55, LOW=15 — the brief's original
 * bucket mapping, retained as the degraded path rather than discarded.
 */
export function temporalSignalFromCellRisk(
  risk: Pick<RiskEntry, "horizons" | "overall"> | null | undefined,
): number | null {
  if (!risk) return null;
  const probs: number[] = [];
  for (const h of ["1day", "3day", "7day"]) {
    const p = risk.horizons?.[h]?.probability;
    if (typeof p === "number" && Number.isFinite(p)) probs.push(p);
  }
  if (probs.length > 0) {
    const mean = probs.reduce((s, p) => s + p, 0) / probs.length;
    return clamp100(mean * 100);
  }
  switch (risk.overall) {
    case "HIGH":
      return 100;
    case "MODERATE":
      return 55;
    case "LOW":
      return 15;
    default:
      return null;
  }
}

/**
 * Hotspot Risk Score (unregistered points, §2.6): environment + temporal
 * only, renormalized — no base signal, since there is no facility detection
 * history at this point. The UI must caption this distinction.
 */
export async function computeHotspotRiskScore(
  lat: number,
  lng: number,
): Promise<RiskScoreResult> {
  const [environment, cellRisk] = await Promise.all([
    classificationRiskCached(lat, lng).catch(() => null),
    fetchCellRisk(h3.latLngToCell(lat, lng, 7)).catch(() => null),
  ]);
  const temporal = temporalSignalFromCellRisk(cellRisk ?? undefined);
  const computedAt = new Date().toISOString();
  return composeFromComponents(
    { base: 0, environment, temporal },
    {
      live: true,
      includeBase: false,
      computedAt:
        temporal != null ? (cellRisk?.data_timestamp ?? computedAt) : computedAt,
    },
  );
}

/* ── live path (single-facility / detail views) ─────────────────────────── */

/**
 * Compute the Risk Score for ONE facility from current signals.
 *
 * Base comes from the already-computed classification (reuse, don't
 * recompute — classifyFromDetections is the caller's job). Environment is a
 * live POST /internal/classify to pyrosense_ml (engineering + inference only —
 * unlike /predict it persists nothing and runs no GenAI). Temporal is the
 * stored nightly GRU prediction for the facility's H3-r7 cell.
 *
 * Never throws for signal loss: a missing environment/temporal signal
 * renormalizes, it does not fail the request.
 */
export async function computeRiskScoreLive(
  facility: Pick<FacilityRow, "lat" | "lng">,
  classificationScore: number,
): Promise<RiskScoreResult> {
  const base = baseSignalFromScore(classificationScore);

  // Environment + temporal in parallel; each independently nullable.
  const [environment, cellRisk] = await Promise.all([
    classificationRiskCached(facility.lat, facility.lng).catch(() => null),
    fetchCellRisk(h3.latLngToCell(facility.lat, facility.lng, 7)).catch(() => null),
  ]);

  const temporal = temporalSignalFromCellRisk(cellRisk ?? undefined);

  const computedAt = new Date().toISOString();
  return composeFromComponents(
    { base, environment, temporal },
    {
      live: true,
      // computedAt = newest contributing signal. When only base contributed,
      // that is "now" (base is always computed fresh); otherwise the cached
      // temporal signal's own timestamp is the honest newest-source time.
      computedAt:
        temporal != null ? (cellRisk?.data_timestamp ?? computedAt) : computedAt,
    },
  );
}

/* ── cached path (bulk views: lists, map markers, /api/command) ─────────── */

export interface CachedRiskBundle {
  computedAt: string;
  /** facility_id → cached components for that facility. */
  byFacilityId: Map<
    string,
    { environment: number | null; temporal: number | null; computedAt: string }
  >;
}

/**
 * Load the per-facility cached environment/temporal components pushed by
 * pyrosense_ml's nightly pipeline (upserted into facility_risk_cache by the
 * sync hook). Returns null when nothing has ever been synced — callers then
 * compose base-only (or fall back to their own live path if cheap enough).
 */
export async function loadCachedRiskComponents(): Promise<CachedRiskBundle | null> {
  const { getAllFacilityRiskCache } = await import("../db/client.js");
  const rows = getAllFacilityRiskCache();
  if (rows.length === 0) return null;
  let computedAt = rows[0]!.computed_at;
  const byFacilityId = new Map<string, { environment: number | null; temporal: number | null; computedAt: string }>();
  for (const r of rows) {
    if (r.computed_at > computedAt) computedAt = r.computed_at;
    byFacilityId.set(r.facility_id, {
      environment: r.environment_signal,
      temporal: r.temporal_signal,
      computedAt: r.computed_at,
    });
  }
  return { computedAt, byFacilityId };
}

/**
 * Compose a facility's Risk Score from the fresh local base signal plus the
 * cached ML-derived components. This is the bulk-view path: no ML calls per
 * facility per request — O(facilities) local math only.
 */
export function composeCachedRiskScore(
  baseComponent: number,
  cached: { environment?: number; temporal?: number; computedAt: string } | null,
): RiskScoreResult {
  const environment = cached?.environment ?? null;
  const temporal = cached?.temporal ?? null;
  return composeFromComponents(
    { base: baseComponent, environment, temporal },
    {
      live: false,
      // Newest contributing signal: if only base contributed, that is "now"
      // (base is always fresh); otherwise the cached bundle's timestamp.
      computedAt:
        environment == null && temporal == null
          ? new Date().toISOString()
          : cached?.computedAt ?? new Date().toISOString(),
    },
  );
}

