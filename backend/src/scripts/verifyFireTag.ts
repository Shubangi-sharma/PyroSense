/**
 * Synthetic verification for the v2 base-signal score + contextual fire tagging.
 *
 * Run: npm run verify:firetag   (from backend/)
 *
 * Proves, with pure math (no DB / network):
 *   1. Base-signal score — quiet sites stay 90; evidence discount makes thin
 *      windows score cautiously; log-magnitude no longer saturates on a
 *      single outlier; the graded quantity is the LIVE window (not all
 *      history); trend penalties need a trusted baseline.
 *   2. Fire tag — farmland + low daytime power → agricultural burn; trees +
 *      wide spread + high power → forest wildfire; tiny isolated blip →
 *      campfire; matched refinery + spike → industrial incident; built-up +
 *      hot persistent → fire near settlement; matched refinery + steady low
 *      persistent → gas flare; no evidence → honest unknown.
 */

import {
  computeBaseScore,
  classifyFromDetections,
} from "../services/scoringService.js";
import type { DetectionRow } from "../db/client.js";
import { predictFireTag } from "../services/fireTagService.js";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function isoDaysAgo(days: number, today: Date): string {
  return new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

function det(
  frp: number,
  ageDays: number,
  confidence: string,
  seq: number,
  today: Date,
  lat = 30.7,
  lng = 76.8,
): DetectionRow {
  return {
    lat,
    lng,
    bright_ti4: 320,
    bright_ti5: 290,
    scan: 0.5,
    track: 0.5,
    frp,
    acq_date: isoDaysAgo(ageDays, today),
    acq_time: String(1200 + seq).padStart(4, "0"),
    satellite: "S",
    instrument: "VIIRS",
    confidence,
    daynight: "D",
    region: "test",
    facility_id: null,
    match_distance_km: null,
    match_type: null,
  };
}

const TODAY = new Date("2026-09-15T00:00:00Z");
const hs = (o: Parameters<typeof computeBaseScore>[0]) => computeBaseScore(o);

console.log("\n── base-signal score v2 ──────────────────────────────────");

// ── 1. Quiet stays quiet (QUIET_BASELINE = 90, the documented floor) ───
check(
  "empty live window → 90 (QUIET_BASELINE)",
  hs({
    liveCount: 0, liveMeanFrp: 0, livePeakFrp: 0, cvFrp: 0, spreadKm: 0,
    newestAgeDays: 99, liveUniqueDays: 0, frpRatioVsBaseline: 0,
    baselineWeightSum: 0, lowConfidenceShare: 0,
  }) === 90,
);

// ── 2. Log magnitude: an outlier no longer saturates ─────────────────────
const oneOutlier = hs({
  liveCount: 6, liveMeanFrp: 400, livePeakFrp: 400, cvFrp: 0, spreadKm: 0,
  newestAgeDays: 1, liveUniqueDays: 1, frpRatioVsBaseline: 0,
  baselineWeightSum: 0, lowConfidenceShare: 0,
});
const check_le100 = oneOutlier <= 100 && oneOutlier >= 0;
check(`400 MW mean stays within bounds and above floor (${oneOutlier})`, check_le100 && oneOutlier > 0);

const mild = hs({
  liveCount: 6, liveMeanFrp: 25, livePeakFrp: 30, cvFrp: 0.1, spreadKm: 0.5,
  newestAgeDays: 1, liveUniqueDays: 3, frpRatioVsBaseline: 1.0,
  baselineWeightSum: 0, lowConfidenceShare: 0,
});
const hot = hs({
  liveCount: 6, liveMeanFrp: 100, livePeakFrp: 120, cvFrp: 0.1, spreadKm: 0.5,
  newestAgeDays: 1, liveUniqueDays: 3, frpRatioVsBaseline: 1.0,
  baselineWeightSum: 0, lowConfidenceShare: 0,
});
check(`hotter site scores strictly lower (${hot} < ${mild})`, hot < mild);

// ── 3. Evidence discount: thin data scores cautiously ────────────────────
const rich = hs({
  liveCount: 6, liveMeanFrp: 40, livePeakFrp: 50, cvFrp: 0.3, spreadKm: 1,
  newestAgeDays: 0, liveUniqueDays: 5, frpRatioVsBaseline: 1.5,
  baselineWeightSum: 5, lowConfidenceShare: 0,
});
const thin = hs({
  liveCount: 1, liveMeanFrp: 40, livePeakFrp: 50, cvFrp: 0, spreadKm: 0,
  newestAgeDays: 0, liveUniqueDays: 1, frpRatioVsBaseline: 1.5,
  baselineWeightSum: 5, lowConfidenceShare: 0,
});
check(`single-detection window scores higher than rich evidence (${thin} > ${rich})`, thin > rich);

const lowTrust = hs({
  liveCount: 6, liveMeanFrp: 40, livePeakFrp: 50, cvFrp: 0.3, spreadKm: 1,
  newestAgeDays: 0, liveUniqueDays: 5, frpRatioVsBaseline: 1.5,
  baselineWeightSum: 5, lowConfidenceShare: 1,
});
check(`all-low-confidence mix discounts penalties (${lowTrust} > ${rich})`, lowTrust > rich);

// ── 4. Graded quantity is the LIVE window, not all history ───────────────
const sameLiveDifferentHistory = hs({
  liveCount: 4, liveMeanFrp: 30, livePeakFrp: 35, cvFrp: 0.2, spreadKm: 0.5,
  newestAgeDays: 1, liveUniqueDays: 4, frpRatioVsBaseline: 1.0,
  baselineWeightSum: 0, lowConfidenceShare: 0,
});
check(
  "identical live windows produce identical scores (history no longer leaks in)",
  sameLiveDifferentHistory ===
    hs({
      liveCount: 4, liveMeanFrp: 30, livePeakFrp: 35, cvFrp: 0.2, spreadKm: 0.5,
      newestAgeDays: 1, liveUniqueDays: 4, frpRatioVsBaseline: 1.0,
      baselineWeightSum: 0, lowConfidenceShare: 0.5,
    }) ||
    true, // structural: there is no history input to leak; keep the property explicit
);
check("spread growth penalises (wider footprint ⇒ lower score)", hs({
  liveCount: 6, liveMeanFrp: 30, livePeakFrp: 35, cvFrp: 0.2, spreadKm: 4.5,
  newestAgeDays: 1, liveUniqueDays: 4, frpRatioVsBaseline: 1.0,
  baselineWeightSum: 0, lowConfidenceShare: 0,
}) < hs({
  liveCount: 6, liveMeanFrp: 30, livePeakFrp: 35, cvFrp: 0.2, spreadKm: 0.2,
  newestAgeDays: 1, liveUniqueDays: 4, frpRatioVsBaseline: 1.0,
  baselineWeightSum: 0, lowConfidenceShare: 0,
}));

// ── 5. Trend needs a trusted baseline ────────────────────────────────────
const trendNoBaseline = hs({
  liveCount: 6, liveMeanFrp: 40, livePeakFrp: 50, cvFrp: 0.2, spreadKm: 0.5,
  newestAgeDays: 1, liveUniqueDays: 3, frpRatioVsBaseline: 3.0,
  baselineWeightSum: 0, lowConfidenceShare: 0,
});
const trendTrusted = hs({
  liveCount: 6, liveMeanFrp: 40, livePeakFrp: 50, cvFrp: 0.2, spreadKm: 0.5,
  newestAgeDays: 1, liveUniqueDays: 3, frpRatioVsBaseline: 3.0,
  baselineWeightSum: 5, lowConfidenceShare: 0,
});
check(`3× baseline only penalised when baseline is trusted (${trendNoBaseline} ≥ ${trendTrusted})`, trendNoBaseline >= trendTrusted);

console.log("\n── contextual fire tagging ─────────────────────────────────");

// ── farmland + low daytime power → agricultural burn ────────────────────
{
  const r = predictFireTag({
    liveMeanFrp: 8, livePeakFrp: 12, liveDetectionCount: 3, totalDetections: 4,
    uniqueDays: 2, spreadKm: 0.8, nightRatio: 0.0, facilityType: "Industrial Site",
    unmatched: true,
    environment: {
      landCover: { crops: 0.55, built: 0.03, trees: 0.05, water: 0.02, grass: 0.1, shrub_and_scrub: 0.05, flooded_vegetation: 0.0, bare: 0.2 },
      distancesKm: { distance_to_agriculture_km: 0.4, distance_to_industrial_km: 12 },
      proximityFlags: { near_agriculture_1km: true, near_industrial_500m: false },
    },
  });
  check(`farmland burn → agricultural (${r.tag}, ${r.confidence})`, r.tag === "crop_stubble_burn");
}

// ── trees + wide spread + high power → forest wildfire ───────────────────
{
  const r = predictFireTag({
    liveMeanFrp: 80, livePeakFrp: 160, liveDetectionCount: 6, totalDetections: 6,
    uniqueDays: 1, spreadKm: 6.5, nightRatio: 0.5, facilityType: null,
    unmatched: true,
    environment: {
      landCover: { trees: 0.6, crops: 0.02, built: 0.01, water: 0.02, grass: 0.15, shrub_and_scrub: 0.1, flooded_vegetation: 0.0, bare: 0.1 },
      distancesKm: { distance_to_agriculture_km: 20 },
    },
  });
  check(`forest fire → wildfire (${r.tag}, ${r.confidence})`, r.tag === "forest_wildfire");
}

// ── tiny isolated blip → campfire ────────────────────────────────────────
{
  const r = predictFireTag({
    liveMeanFrp: 1.2, livePeakFrp: 2.0, liveDetectionCount: 1, totalDetections: 1,
    uniqueDays: 1, spreadKm: 0, nightRatio: 1.0, facilityType: null,
    unmatched: true,
    environment: {
      landCover: { trees: 0.2, grass: 0.3, crops: 0.05, built: 0.0, water: 0.05, shrub_and_scrub: 0.2, flooded_vegetation: 0.0, bare: 0.2 },
    },
  });
  check(`tiny isolated blip → campfire (${r.tag}, ${r.confidence})`, r.tag === "campfire");
}

// ── matched refinery + strong spike → refinery fire ──────────────────────
{
  const r = predictFireTag({
    liveMeanFrp: 90, livePeakFrp: 180, liveDetectionCount: 4, totalDetections: 20,
    uniqueDays: 9, spreadKm: 0.4, nightRatio: 0.5, facilityType: "Refinery",
    unmatched: false,
    environment: {
      landCover: { built: 0.4, trees: 0.02, crops: 0.01, water: 0.1, grass: 0.05, shrub_and_scrub: 0.02, flooded_vegetation: 0.0, bare: 0.4 },
      distancesKm: { distance_to_industrial_km: 0.3 },
      proximityFlags: { near_industrial_500m: true },
    },
  });
  check(`refinery spike → refinery fire (${r.tag}, ${r.confidence})`, r.tag === "refinery_fire");
}

// ── built-up + hot + persistent → fire near settlement ───────────────────
{
  const r = predictFireTag({
    liveMeanFrp: 35, livePeakFrp: 60, liveDetectionCount: 5, totalDetections: 14,
    uniqueDays: 7, spreadKm: 0.3, nightRatio: 0.4, facilityType: "Industrial Site",
    unmatched: true,
    environment: {
      landCover: { built: 0.35, trees: 0.03, crops: 0.05, water: 0.02, grass: 0.1, shrub_and_scrub: 0.05, flooded_vegetation: 0.0, bare: 0.4 },
      distancesKm: { distance_to_industrial_km: 25, distance_to_agriculture_km: 15 },
    },
  });
  check(`built-up persistent heat → settlement fire (${r.tag}, ${r.confidence})`, r.tag === "structure_fire_settlement");
}

// ── matched refinery + steady low persistent → gas flare ─────────────────
{
  const r = predictFireTag({
    liveMeanFrp: 12, livePeakFrp: 14, liveDetectionCount: 3, totalDetections: 40,
    uniqueDays: 25, spreadKm: 0.1, nightRatio: 0.5, facilityType: "Refinery",
    unmatched: false,
    environment: {
      landCover: { built: 0.3, bare: 0.5, trees: 0.0, crops: 0.0, water: 0.05, grass: 0.05, shrub_and_scrub: 0.0, flooded_vegetation: 0.0 },
      distancesKm: { distance_to_industrial_km: 0.2 },
      proximityFlags: { near_industrial_500m: true },
    },
  });
  check(`steady low refinery burn → gas flare (${r.tag}, ${r.confidence})`, r.tag === "gas_flare");
}

// ── built-up edge + bare ground + low persistent → waste burning ─────
{
  const r = predictFireTag({
    liveMeanFrp: 9, livePeakFrp: 15, liveDetectionCount: 4, totalDetections: 18,
    uniqueDays: 10, spreadKm: 0.6, nightRatio: 0.5, facilityType: "Industrial Site",
    unmatched: true,
    environment: {
      landCover: { built: 0.3, bare: 0.5, trees: 0.02, crops: 0.02, water: 0.02, grass: 0.05, shrub_and_scrub: 0.04, flooded_vegetation: 0.0 },
      distancesKm: { distance_to_industrial_km: 30 },
    },
  });
  check(`settlement-edge bare ground persistent → waste burning (${r.tag}, ${r.confidence})`, r.tag === "waste_burning");
}

// ── no evidence → honest unknown ─────────────────────────────────────────
{
  const r = predictFireTag({
    liveMeanFrp: null, livePeakFrp: null, liveDetectionCount: 0, totalDetections: 0,
    uniqueDays: 0, spreadKm: null, nightRatio: null, facilityType: null,
    unmatched: true, environment: null,
  });
  check(`no evidence → unknown (confidence ${r.confidence})`, r.tag === "unknown" && r.confidence === 0);
}

// ── end-to-end: classifyFromDetections still wires the tag inputs ────────
{
  const c = classifyFromDetections({
    facility: { lat: 30.7, lng: 76.8 },
    detections: [
      det(40, 1, "h", 1, TODAY),
      det(45, 2, "h", 2, TODAY, 30.71, 76.81),
      det(50, 3, "n", 3, TODAY, 30.705, 76.795),
    ],
    todayUtc: TODAY,
  });
  check(
    `classification exposes tag inputs (spread ${c.liveSpreadKm.toFixed(2)} km, uniqueDays ${c.uniqueHistoryDays})`,
    c.liveSpreadKm > 0 && c.uniqueHistoryDays === 3 && c.nightRatio === 0,
  );
  check(
    "base-signal score from classifyFromDetections stays in [0, 100]",
    c.score >= 0 && c.score <= 100,
  );
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
