/**
 * scoringService — PURE scoring math (no DB access).
 *
 * ── RECENCY-WEIGHTED BASELINE (§4) ──────────────────────────────────────
 *
 * The baseline FRP mean is a full-history, recency-weighted mean so a
 * facility whose behaviour genuinely shifted this month is not masked by a
 * stale year-old average:
 *
 *   w(d) = exp(−ln(4) · d / 30)
 *
 *     d      = days before "today" of the detection's acquisition date
 *     30     = BASELINE_RECENT_DAYS — the mean age of the weighting kernel
 *     ln(4)  = ln(weightAtHorizon / weightToday), chosen so a detection
 *              BASELINE_RECENT_DAYS old carries exactly ¼ the weight of a
 *              detection from today. Half-life ≈ 15 days; weights decay to
 *              ~1/1000 by 5 months.
 *
 *   weightedMean     = Σ wᵢ·frpᵢ / Σ wᵢ
 *   weightedVariance = Σ wᵢ·(frpᵢ − μ)² / Σ wᵢ   (reliability-style weights)
 *
 * ── CONFIDENCE WEIGHTING (combined with recency) ────────────────────────
 *
 * Recency is only half of "how much should this detection move the
 * baseline?". FIRMS VIIRS ships a per-detection confidence band, and until
 * now that band was used solely as an inclusion gate (isUsable) — after
 * inclusion every detection carried equal weight, so one low-confidence
 * sensor artifact counted the same as a textbook high-confidence sighting.
 *
 * Each usable detection now carries a multiplicative confidence weight on
 * top of its recency weight:
 *
 *   h / high      → 1.0   (strong radiance + cloud-mask match)
 *   n / nominal, m / medium, "" → 0.7   (nominal band — usable, softer)
 *   l / low       → 0.4   (elevated noise/cloud likelihood)
 *
 * Combined weight:  wᵢ = recency(ageDays) × confidence(band)
 *
 * The two factors are deliberately independent and multiplicative:
 * recency models WHEN evidence was seen, confidence models HOW
 * trustworthy each sighting is. Multiplying (not discarding) keeps weak
 * evidence in play at reduced voice — important for facilities with short
 * histories, where dropping low-band rows entirely could erase the only
 * signal. The same weighting is applied to live-window FRP aggregation so
 * "recent behaviour" is also quality-weighted, and the band split is
 * exposed as Signal Quality for the operator (C2).
 *
 * Documented in code because this is real analytical logic, not decoration.
 *
 * ── CLASSIFICATION ──────────────────────────────────────────────────────
 * The last LIVE_WINDOW_DAYS of detections are "recent behaviour"; they are
 * compared against the weighted baseline over the FULL stored history.
 */

import {
  BASELINE_RECENT_DAYS,
  FACILITY_RADIUS_KM,
  LIVE_WINDOW_DAYS,
} from "../config/regions.js";
import { haversineKm } from "../lib/geo.js";
import type { DetectionRow } from "../db/client.js";

/* ── tunables (single source of truth) ─────────────────────────────────── */

export const NEW_DETECTION_KM = 2;
export const SUSPICIOUS_FRP_RATIO = 1.3;
export const CRITICAL_FRP_RATIO = 2.0;
export const MIN_PERSISTENT_DETECTIONS = 2;
export const MAX_DETECTION_SPREAD_KM = 3;
export const PERSISTENT_FRP_CV = 0.45;
export const QUIET_BASELINE = 90;
/** Minimum weighted-sample count before a baseline is trusted. */
export const MIN_BASELINE_SAMPLES = 3;

export type RiskStatus = "normal" | "watch" | "suspicious" | "critical" | "unknown";

export const USABLE_CONFIDENCE = new Set(["h", "high", "m", "medium", "n", "nominal", ""]);

export const isUsable = (d: DetectionRow): boolean =>
  USABLE_CONFIDENCE.has(d.confidence.toLowerCase());

/* ── confidence weighting (applied AFTER inclusion) ───────────────────── */

export type ConfidenceBand = "high" | "nominal" | "low";

/**
 * VIIRS confidence band → evidence weight (see module docblock).
 * Band names follow FIRMS VIIRS's own vocabulary: l / n / h → low /
 * nominal / high. "" (missing band) and m/medium are treated as nominal:
 * usable, softer than high.
 */
export const CONFIDENCE_WEIGHTS: Record<ConfidenceBand, number> = {
  high: 1.0,
  nominal: 0.7,
  low: 0.4,
};

export function confidenceBand(confidence: string): ConfidenceBand {
  switch (confidence.trim().toLowerCase()) {
    case "h":
    case "high":
      return "high";
    case "l":
    case "low":
      return "low";
    default:
      // n / nominal / m / medium / "" — everything usable-but-not-high.
      return "nominal";
  }
}

export function confidenceWeight(confidence: string): number {
  return CONFIDENCE_WEIGHTS[confidenceBand(confidence)];
}

/** Confidence-weighted mean FRP — the live-window aggregation uses this too. */
export function confidenceWeightedMean(
  frps: { frp: number; confidence: string }[],
): number {
  if (frps.length === 0) return 0;
  let wsum = 0;
  let wfrp = 0;
  for (const { frp, confidence } of frps) {
    const w = confidenceWeight(confidence);
    wsum += w;
    wfrp += w * frp;
  }
  // Degenerate guard: fall back to the plain mean if all weights vanish.
  return wsum > 0 ? wfrp / wsum : mean(frps.map((f) => f.frp));
}

/* ── weighted baseline ─────────────────────────────────────────────────── */

export interface WeightedBaseline {
  mean: number;
  stdDev: number;
  weightSum: number;
  count: number;
  maxAgeDays: number;
}

export function baselineWeight(ageDays: number): number {
  return Math.exp((-Math.log(4) * ageDays) / BASELINE_RECENT_DAYS);
}

export function computeWeightedBaseline(
  frps: { frp: number; ageDays: number; confidence: string }[],
): WeightedBaseline | null {
  if (frps.length === 0) return null;
  let wsum = 0;
  let wfrp = 0;
  let maxAge = 0;
  for (const { frp, ageDays, confidence } of frps) {
    // Recency × confidence: when it was seen × how much to trust it.
    const w = baselineWeight(ageDays) * confidenceWeight(confidence);
    wsum += w;
    wfrp += w * frp;
    if (ageDays > maxAge) maxAge = ageDays;
  }
  if (wsum <= 0) return null;
  const mean = wfrp / wsum;
  let wvar = 0;
  for (const { frp, ageDays, confidence } of frps) {
    const w = baselineWeight(ageDays) * confidenceWeight(confidence);
    wvar += w * (frp - mean) ** 2;
  }
  return {
    mean,
    stdDev: Math.sqrt(Math.max(0, wvar / wsum)),
    weightSum: wsum,
    count: frps.length,
    maxAgeDays: maxAge,
  };
}

/* ── classification ────────────────────────────────────────────────────── */

export interface Classification {
  status: RiskStatus;
  score: number;
  latestFrp: number | null;
  latestTimestampUtc: string | null;
  latestConfidence: string | null;
  latestSatellite: string | null;
  nearestKm: number | null;
  detectionCount: number;
  liveCount: number;
  liveMeanFrp: number | null;
  livePeakFrp: number | null;
  /** VIIRS confidence-band split of the live window (Signal Quality, C2). */
  liveConfidenceSplit: { high: number; nominal: number; low: number };
  baseline: WeightedBaseline | null;
  newDetectionsLast5d: number;
  newDetectionsPriorNearby: number;
  /** max spread of LIVE usable detections from their centroid, km (contextual tagging). */
  liveSpreadKm: number;
  /** share of LIVE usable detections from night passes, 0–1 (contextual tagging). */
  nightRatio: number | null;
  /** distinct acquisition days across ALL usable history (contextual tagging). */
  uniqueHistoryDays: number;
}

export interface ClassifyInput {
  facility: { lat: number; lng: number };
  /** ALL stored detections near the facility, any age (from the DB). */
  detections: DetectionRow[];
  todayUtc: Date;
  radiusKm?: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function ageDaysBetween(fromIsoDate: string, today: Date): number {
  const [y, m, d] = fromIsoDate.split("-").map(Number);
  if (!y || !m || !d) return 0;
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.max(0, Math.round((todayUtc - Date.UTC(y, m - 1, d)) / 86_400_000));
}

export function detectionTimestampUtc(acqDate: string, acqTime: string): string {
  const t = acqTime.padStart(4, "0");
  return `${acqDate} ${t.slice(0, 2)}:${t.slice(2, 4)}`;
}

/** Coefficient of variation (stdev/mean) — 0 for small or degenerate sets. */
export function coefficientOfVariation(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  if (m === 0) return 0;
  const variance = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance) / m;
}

/* ── Base-signal scoring (100 − penalties; the input to the unified
   Risk Score's base component — see riskScoreService.ts) ─────────────── */

export interface BaseScoreInput {
  /** usable detections in the LIVE window (the behaviour being graded) */
  liveCount: number;
  /** confidence-weighted mean FRP of the live window, MW */
  liveMeanFrp: number;
  /** peak FRP of the live window, MW (a real observation, unweighted) */
  livePeakFrp: number;
  /** FRP coefficient of variation across the live window */
  cvFrp: number;
  /** live detections spread across space, km (0 for a single point) */
  spreadKm: number;
  /** max age in days of the live-window detections (0 = today) */
  newestAgeDays: number;
  /** unique acquisition days in the live window */
  liveUniqueDays: number;
  /** recent mean FRP vs weighted baseline (ratio, >1 = elevated); 0 = no trusted baseline */
  frpRatioVsBaseline: number;
  /** weighted sample count behind the baseline (evidence quality) */
  baselineWeightSum: number;
  /** share of live detections that were low-confidence (gated out) — data trust */
  lowConfidenceShare: number;
}

/**
 * Base-signal score — 100 minus penalties, clamped to [0, 100]. Lower = more
 * thermal anomaly risk; riskScoreService inverts it for the unified score.
 *
 * Design (v2 — evidence-quality weighting):
 *  • The graded quantity is the LIVE window (10 d), not all history —
 *    a site that burned for a month last quarter and is quiet today is
 *    QUIET today. The old input mixed full-history counts into every term.
 *  • Magnitude is LOG-scaled: FRP is heavy-tailed (one 400 MW flare next to
 *    ten 3 MW flickers); a linear /100 term let a single outlier saturate
 *    the whole score. log1p gives every doubling of power a similar penalty
 *    step and needs no outlier clamp.
 *  • Frequency counts ACTIVE DAYS, not raw detections — satellite passes
 *    can repeat on one fire; what matters operationally is how many days
 *    it was actually burning.
 *  • Spatial spread penalises fire that is GROWING across the site
 *    (single-point heating vs multi-hectare spread) — a physical signal the
 *    old score ignored entirely.
 *  • Every penalty is scaled by EVIDENCE QUALITY: few live observations
 *    (short window) and a low-confidence mix shrink the penalties toward
 *    0, so thin/low-trust data scores cautious (near 100) instead of
 *    being punished as if it were certain. Evidence quality never ADDS
 *    penalty — it only discounts the penalties we cannot trust.
 *  • Trend vs the site's OWN recency×confidence-weighted baseline is kept,
 *    but trusted only when the baseline carries enough weighted samples
 *    (see trustedTrend below) — one stale baseline row can no longer
 *    manufacture a fake "2× baseline" escalation.
 */
export function computeBaseScore(input: BaseScoreInput): number {
  const {
    liveCount,
    liveMeanFrp,
    livePeakFrp,
    cvFrp,
    spreadKm,
    newestAgeDays,
    liveUniqueDays,
    frpRatioVsBaseline,
    baselineWeightSum,
    lowConfidenceShare,
  } = input;

  // Nothing usable in the live window → quiet site (documented 90 floor).
  if (liveCount === 0) return QUIET_BASELINE;

  // Evidence quality ∈ (0, 1]: how much we trust the live-window picture.
  //  • sample floor: 1 det = 0.45, 2 = 0.7, 3+ = 0.85, 6+ = 1.0
  //  • trust floor: low-band share of ALL nearby live rows (gated-out rows
  //    still tell us the sensor was struggling) — up to −0.35
  const sampleQuality = Math.min(1, 0.45 + 0.2 * liveCount + (liveCount >= 6 ? 0.15 : 0));
  const trustQuality = Math.max(0.65, 1 - 0.35 * Math.min(1, Math.max(0, lowConfidenceShare)));
  const evidence = sampleQuality * trustQuality;

  // magnitude: log-scaled on the mean (steady output) with a peak kicker for
  // rare extreme events. log1p(100)/log1p(500) ≈ 0.62; the peak term only
  // bites above ~150 MW (one-off sensor artifacts stay damped by evidence).
  const magnitudePenalty =
    30 * (Math.log1p(Math.max(0, liveMeanFrp)) / Math.log1p(500)) +
    10 * Math.min(1, Math.max(0, (livePeakFrp - 150) / 350));

  // frequency: ACTIVE DAYS in the live window (of 10), not raw detections.
  const frequencyPenalty = 22 * Math.min(1, liveUniqueDays / LIVE_WINDOW_DAYS);

  // instability: erratic FRP behaviour within the window (needs 2+ points).
  const instabilityPenalty = 12 * Math.min(1, Math.max(0, cvFrp) / 0.8);

  // spread: heating footprint growth across the site (5 km radius ≈ full).
  const spreadPenalty = 14 * Math.min(1, Math.max(0, spreadKm) / 5);

  // recency: graded, not binary — today 12 pts, 2 days ago 8, within the
  // window ≥1, older than the window costs nothing (it can't be "recent").
  const recencyPenalty =
    newestAgeDays <= 0 ? 12 : newestAgeDays <= 1 ? 10 : newestAgeDays <= 3 ? 6 : newestAgeDays <= LIVE_WINDOW_DAYS ? 2 : 0;

  // trend: recent FRP vs the site's own weighted baseline — trusted only
  // with enough weighted evidence behind the baseline (≥ 2.0 weight-sum ≈
  // a couple of recent high-confidence rows or a longer medium-confidence
  // history). ratio 1.0 → 0, 2.0 → 14, saturates at 3× baseline.
  const trustedTrend = baselineWeightSum >= 2.0 && frpRatioVsBaseline > 0;
  const trendPenalty = trustedTrend
    ? 14 * Math.min(1, Math.max(0, frpRatioVsBaseline - 1) / 2)
    : 0;

  // Evidence discount: thin/low-trust windows get most (not all) of their
  // penalty forgiven — but recency is a timing fact (cheap to observe) and
  // is discounted less than the physics terms.
  const discounted =
    evidence * (magnitudePenalty + frequencyPenalty + instabilityPenalty + spreadPenalty + trendPenalty) +
    (0.5 + 0.5 * evidence) * recencyPenalty;

  const score = 100 - Math.max(discounted, 0);
  return Math.round(Math.max(0, Math.min(100, score)));
}

/* ── classification entry point ──────────────────────────────────────── */

/**
 * Classify one facility from its real stored detection history.
 * `detections` must be ALL stored rows within a generous bounding box of
 * the facility (see analysisService) — the km filter is re-applied here.
 * Pure: same inputs → same outputs, no clock reads (`todayUtc` is injected).
 */
export function classifyFromDetections(input: ClassifyInput): Classification {
  const { facility, detections, todayUtc } = input;
  const radiusKm = input.radiusKm ?? FACILITY_RADIUS_KM;

  const withDist = detections
    .map((d) => ({ d, dist: haversineKm(facility.lat, facility.lng, d.lat, d.lng) }))
    .filter((x) => x.dist <= radiusKm)
    .sort((a, b) => a.dist - b.dist);

  const nearestKm = withDist.length ? withDist[0]!.dist : null;

  // Signal Quality source data (C2): confidence-band split of ALL nearby
  // live-window detections — INCLUDING the low-band rows the quality gate
  // excludes — so the operator sees the true quality mix. "low" here means
  // "present but excluded from scoring", never silently dropped.
  const liveConfidenceSplit = { high: 0, nominal: 0, low: 0 };
  for (const x of withDist) {
    if (ageDaysBetween(x.d.acq_date, todayUtc) < LIVE_WINDOW_DAYS) {
      liveConfidenceSplit[confidenceBand(x.d.confidence)] += 1;
    }
  }

  const newest = [...withDist].sort((a, b) =>
    a.d.acq_date < b.d.acq_date
      ? 1
      : a.d.acq_date > b.d.acq_date
        ? -1
        : b.d.acq_time.localeCompare(a.d.acq_time),
  )[0];

  const latestTimestampUtc = newest
    ? detectionTimestampUtc(newest.d.acq_date, newest.d.acq_time)
    : null;

  const usable = withDist.filter((x) => isUsable(x.d));

  if (usable.length === 0) {
    // Detections nearby but all unusable → unknown; nothing nearby → normal.
    const hasAny = withDist.length > 0;
    return {
      status: hasAny ? "unknown" : "normal",
      score: hasAny ? 40 : QUIET_BASELINE,
      latestFrp: newest ? newest.d.frp : null,
      latestTimestampUtc,
      latestConfidence: newest ? newest.d.confidence : null,
      latestSatellite: newest ? newest.d.satellite : null,
      nearestKm,
      detectionCount: 0,
      liveCount: 0,
      liveMeanFrp: null,
      livePeakFrp: null,
      liveConfidenceSplit,
      baseline: null,
      newDetectionsLast5d: 0,
      newDetectionsPriorNearby: 0,
      liveSpreadKm: 0,
      nightRatio: null,
      uniqueHistoryDays: 0,
    };
  }

  const ages = new Map(
    usable.map((x) => [x, ageDaysBetween(x.d.acq_date, todayUtc)] as const),
  );

  // LIVE window = recent behaviour; BASELINE = full stored history.
  // Both aggregations are confidence-weighted (recency × confidence): see
  // the module docblock. livePeak stays an unweighted max — a peak is a
  // physical observation, not an estimate.
  const live = usable.filter((x) => ages.get(x)! < LIVE_WINDOW_DAYS);
  const liveFrps = live.map((x) => x.d.frp);
  const liveWeighted = (rows: typeof usable) =>
    confidenceWeightedMean(rows.map((x) => ({ frp: x.d.frp, confidence: x.d.confidence })));
  const liveMean = liveFrps.length ? liveWeighted(live) : liveWeighted(usable);
  const livePeak = liveFrps.length ? Math.max(...liveFrps) : Math.max(...usable.map((x) => x.d.frp));

  const baseline = computeWeightedBaseline(
    usable.map((x) => ({ frp: x.d.frp, ageDays: ages.get(x)!, confidence: x.d.confidence })),
  );

  // ── new detection (vs the FULL prior baseline, not a 10-day early half) ──
  const last5 = usable.filter((x) => ages.get(x)! < 5);
  const prior = usable.filter((x) => ages.get(x)! >= 5);
  const newDetections = last5.filter(
    (x) => !prior.some((p) => haversineKm(p.d.lat, p.d.lng, x.d.lat, x.d.lng) <= NEW_DETECTION_KM),
  );

  // ── persistent-source pattern (watch) ──
  const spreadKm =
    usable.length >= 2
      ? Math.max(
          ...usable.map((x) => {
            const cLat = mean(usable.map((u) => u.d.lat));
            const cLng = mean(usable.map((u) => u.d.lng));
            return haversineKm(cLat, cLng, x.d.lat, x.d.lng);
          }),
        )
      : 0;
  const cv = coefficientOfVariation(usable.map((x) => x.d.frp));
  const persistentPattern =
    usable.length >= MIN_PERSISTENT_DETECTIONS &&
    spreadKm <= MAX_DETECTION_SPREAD_KM &&
    cv <= PERSISTENT_FRP_CV;

  // ── escalation vs the facility's OWN weighted baseline ──
  const trustedBaseline = baseline && baseline.count >= MIN_BASELINE_SAMPLES ? baseline : null;
  const ratioVsBaseline = trustedBaseline && trustedBaseline.mean > 0 ? livePeak / trustedBaseline.mean : 0;
  const maxRatio = mean(usable.map((x) => x.d.frp)) > 0 ? livePeak / mean(usable.map((x) => x.d.frp)) : 0;

  let status: RiskStatus;
  if (trustedBaseline && ratioVsBaseline > CRITICAL_FRP_RATIO) {
    status = "critical";
  } else if (trustedBaseline && ratioVsBaseline >= SUSPICIOUS_FRP_RATIO) {
    status = "suspicious";
  } else if (newDetections.length > 0) {
    status = "suspicious";
  } else if (persistentPattern) {
    status = "watch";
  } else {
    status = "watch";
  }

  // ── base-signal inputs: the graded quantity is the LIVE window ──
  // Live-window spread (not all-history spread): fire growth NOW.
  const liveSpreadKm =
    live.length >= 2
      ? Math.max(
          ...live.map((x) => {
            const cLat = mean(live.map((u) => u.d.lat));
            const cLng = mean(live.map((u) => u.d.lng));
            return haversineKm(cLat, cLng, x.d.lat, x.d.lng);
          }),
        )
      : 0;
  const liveUniqueDays = new Set(live.map((x) => x.d.acq_date)).size;
  // Newest scoring-grade (usable) detection age — usable[0] is nearest, NOT
  // newest (distance-sorted), so the old code graded recency off the wrong row.
  const newestUsableAgeDays = Math.min(...usable.map((x) => ages.get(x)!));
  // Low-band share of ALL nearby live rows (incl. gated-out) — data trust.
  const liveSplitTotal = liveConfidenceSplit.high + liveConfidenceSplit.nominal + liveConfidenceSplit.low;
  const lowConfidenceShare = liveSplitTotal > 0 ? liveConfidenceSplit.low / liveSplitTotal : 0;

  const score = computeBaseScore({
    liveCount: live.length,
    liveMeanFrp: liveMean,
    livePeakFrp: livePeak,
    cvFrp: coefficientOfVariation(liveFrps),
    spreadKm: liveSpreadKm,
    newestAgeDays: newestUsableAgeDays,
    liveUniqueDays,
    frpRatioVsBaseline: ratioVsBaseline || maxRatio,
    baselineWeightSum: trustedBaseline?.weightSum ?? 0,
    lowConfidenceShare,
  });

  return {
    status,
    score,
    latestFrp: newest ? newest.d.frp : null,
    latestTimestampUtc,
    latestConfidence: newest ? newest.d.confidence : null,
    latestSatellite: newest ? newest.d.satellite : null,
    nearestKm,
    detectionCount: usable.length,
    liveCount: live.length,
    liveMeanFrp: liveFrps.length ? liveMean : null,
    livePeakFrp: liveFrps.length ? livePeak : null,
    liveConfidenceSplit,
    baseline: trustedBaseline,
    newDetectionsLast5d: newDetections.length,
    newDetectionsPriorNearby: prior.length,
    liveSpreadKm,
    nightRatio: live.length ? live.filter((x) => x.d.daynight === "N").length / live.length : null,
    uniqueHistoryDays: new Set(usable.map((x) => x.d.acq_date)).size,
  };
}

/** Format a real delta as a signed percentage, e.g. "+40%" or "−18%". */
export function formatDeltaPct(current: number, baseline: number): string {
  if (baseline === 0) return current === 0 ? "±0%" : "n/a";
  const pct = Math.round(((current - baseline) / baseline) * 100);
  return `${pct >= 0 ? "+" : "−"}${Math.abs(pct)}%`;
}
