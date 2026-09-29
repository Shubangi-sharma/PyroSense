/**
 * facts.ts — the computed-facts contract between scoring and the AI layer.
 *
 * EVERY number the AI may mention must exist in a SummaryFacts object first.
 * genaiService renders this block into the prompt and validates the model's
 * output against it — grounding is enforced structurally, not by hope.
 */

import { sha256Hex, stableStringify } from "../lib/geo.js";

export interface SummaryFacts {
  facilityId: string;
  facilityName: string;
  facilityType: string;
  /** km radius used for corroboration */
  radiusKm: number;
  /** days of real history actually present in the DB for this site */
  historyDays: number | null;
  historyFromDate: string | null;
  historyToDate: string | null;
  /** recency-weighted baseline FRP mean, MW */
  baselineFrpMean: number | null;
  baselineFrpStdDev: number | null;
  baselineDetectionCount: number;
  /** unweighted full-history mean, for transparency */
  rawMeanFrp: number | null;
  /** last LIVE_WINDOW_DAYS */
  liveWindowDays: number;
  liveDetectionCount: number;
  liveMeanFrp: number | null;
  livePeakFrp: number | null;
  latestFrp: number | null;
  latestDetection: {
    timestampUtc: string;
    confidence: string;
    satellite: string;
  } | null;
  /** detections in the last 5 days with none within 2 km in the prior history */
  newDetectionsLast5d: number;
  newDetectionsPrior30dSameLocation: number;
  nearestKm: number | null;
  status: string;
  /**
   * Unified Risk Score — 0–100, HIGHER = MORE RISK. Composed by
   * riskScoreService (base FRP-anomaly + ML classification + GRU temporal).
   * Replaces the retired inverse "Thermal Health Score".
   */
  riskScore: number;
  /** Thermal classification label from classificationService. */
  classification?: string;
  classificationLabel?: string;
}

/**
 * Render the facts as the exact structured block the prompt shows the model.
 * Plain deterministic text — the same facts always render identically, so
 * its hash is a stable cache key.
 */
export function buildFactsText(f: SummaryFacts): string {
  const lines: string[] = [];
  lines.push(`Facility: ${f.facilityName} (${f.facilityType})`);
  lines.push(`Corroboration radius: ${f.radiusKm} km`);
  if (f.historyDays != null && f.historyFromDate && f.historyToDate) {
    lines.push(
      `Available FIRMS history: ${f.historyDays} days (${f.historyFromDate} to ${f.historyToDate})`,
    );
  } else {
    lines.push("Available FIRMS history: none recorded for this location");
  }
  if (f.baselineFrpMean != null) {
    lines.push(
      `Baseline FRP (recency-weighted average): ${f.baselineFrpMean.toFixed(1)} MW`,
    );
    if (f.baselineFrpStdDev != null) {
      lines.push(`Baseline FRP spread (1 std dev): ±${f.baselineFrpStdDev.toFixed(1)} MW`);
    }
    lines.push(`Baseline detection count: ${f.baselineDetectionCount}`);
  } else {
    lines.push("Baseline FRP: no detections in the stored history");
  }
  lines.push(`Detections in last ${f.liveWindowDays} days: ${f.liveDetectionCount}`);
  if (f.liveMeanFrp != null) lines.push(`Mean FRP last ${f.liveWindowDays} days: ${f.liveMeanFrp.toFixed(1)} MW`);
  if (f.livePeakFrp != null) lines.push(`Peak FRP last ${f.liveWindowDays} days: ${f.livePeakFrp.toFixed(1)} MW`);
  if (f.latestDetection) {
    lines.push(
      `Last detection: ${f.latestDetection.timestampUtc} UTC, confidence: ${f.latestDetection.confidence}, satellite: ${f.latestDetection.satellite}`,
    );
    if (f.latestFrp != null) lines.push(`Last detection FRP: ${f.latestFrp.toFixed(1)} MW`);
  }
  lines.push(
    `New detections in last 5 days: ${f.newDetectionsLast5d} (prior history detections within 2 km of them: ${f.newDetectionsPrior30dSameLocation})`,
  );
  if (f.nearestKm != null) lines.push(`Nearest detection: ${f.nearestKm.toFixed(1)} km from the asset`);
  lines.push(`Classification: ${f.status}`);
  lines.push(`Risk Score: ${f.riskScore}/100 (higher = more risk)`);
  if (f.classificationLabel) lines.push(`Thermal Classification: ${f.classificationLabel}`);
  return lines.join("\n");
}

/** Stable content hash of the facts — cache key for generated summaries. */
export function hashFacts(f: SummaryFacts): Promise<string> {
  return sha256Hex(stableStringify(f));
}
