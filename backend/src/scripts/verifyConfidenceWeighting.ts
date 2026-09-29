/**
 * Synthetic verification for confidence-weighted scoring (Track C1).
 *
 * Run: npm run verify:confidence   (from backend/)
 *
 * Builds two synthetic facilities with IDENTICAL FRP values and dates and
 * proves that after the change:
 *   1. confidence still gates inclusion (a low-only facility → unknown),
 *   2. equal-confidence histories score identically (recency untouched),
 *   3. mixing confidence CHANGES the weighted baseline and the base-signal
 *      score in the intended direction (high-confidence evidence counts
 *      more; a low-confidence spike is damped),
 *   4. the signal-quality split is exposed for the UI.
 *
 * Pure math + injected clock — no DB, no network.
 */

import {
  classifyFromDetections,
  computeWeightedBaseline,
  confidenceWeight,
  baselineWeight,
} from "../services/scoringService.js";
import type { DetectionRow } from "../db/client.js";

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

/** Severity rank matching the dashboard's ordering (lower = calmer). */
const statusRank = (s: string): number =>
  ({ critical: 0, suspicious: 1, watch: 2, unknown: 3, normal: 4 })[s] ?? 3;

/** Build a synthetic DetectionRow; all fields irrelevant to the math are stubbed. */
function det(
  frp: number,
  ageDays: number,
  confidence: string,
  seq: number,
  today: Date,
): DetectionRow {
  return {
    lat: 30.7,
    lng: 76.8,
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

console.log("\n── confidence weighting (Track C1) ───────────────────────────");

// ── 1. Weight table sanity ────────────────────────────────────────────────
check("h/high → 1.0", confidenceWeight("h") === 1.0 && confidenceWeight("HIGH") === 1.0);
check("n/nominal + m/medium + missing → 0.7 (nominal)", ["n", "nominal", "m", "medium", ""].every((c) => confidenceWeight(c) === 0.7));
check("l/low → 0.4", confidenceWeight("l") === 0.4);

// ── 2. Inclusion gate unchanged: all-low ⇒ unknown ────────────────────────
{
  const facility = { lat: 30.7, lng: 76.8 };
  const detections = [
    det(40, 1, "l", 1, TODAY),
    det(45, 2, "l", 2, TODAY),
    det(50, 3, "l", 3, TODAY),
  ];
  const c = classifyFromDetections({ facility, detections, todayUtc: TODAY });
  check("all-low-confidence facility classifies as unknown (gate unchanged)", c.status === "unknown");
  check("all-low facility keeps usable count 0", c.detectionCount === 0);
}

// ── 3. Equal confidence ⇒ identical to pure recency weighting ─────────────
{
  // 5 detections, same FRP decay pattern, all high confidence.
  const frps = [30, 34, 28, 31, 33];
  const allHigh = frps.map((frp, i) => ({ frp, ageDays: i * 2, confidence: "h" }));
  const allMedium = frps.map((frp, i) => ({ frp, ageDays: i * 2, confidence: "n" }));

  const bHigh = computeWeightedBaseline(allHigh);
  const bMedium = computeWeightedBaseline(allMedium);
  const bHighNoConf = (() => {
    // reference: plain recency-only computation, pre-change formula
    let wsum = 0, wfrp = 0;
    for (const { frp, ageDays } of allHigh) {
      const w = baselineWeight(ageDays);
      wsum += w;
      wfrp += w * frp;
    }
    return wfrp / wsum;
  })();

  check(
    "uniform high confidence ≡ recency-only baseline (change is backwards-compatible)",
    bHigh !== null && Math.abs(bHigh.mean - bHighNoConf) < 1e-9,
    `got ${bHigh?.mean.toFixed(4)} vs ${bHighNoConf.toFixed(4)}`,
  );
  check(
    "uniform confidence still uniform (medium baseline = high baseline when FRPs equal)",
    bHigh !== null && bMedium !== null && Math.abs(bHigh.mean - bMedium.mean) < 1e-9,
  );
}

// ── 4. Mixed confidence CHANGES the baseline in the intended direction ────
{
  // Varying FRPs: old rows hot, recent rows cool. Down-weighting the hot
  // old rows must LOWER the baseline (damps false escalation).
  const varying = (oldConf: string) =>
    [
      { frp: 90, ageDays: 40 },
      { frp: 85, ageDays: 42 },
      { frp: 25, ageDays: 1 },
      { frp: 22, ageDays: 3 },
    ].map((r, i) => ({ ...r, confidence: i < 2 ? oldConf : "h" }));
  const hotOldHigh = computeWeightedBaseline(varying("h"))!;
  const hotOldLow = computeWeightedBaseline(varying("l"))!;
  check(
    "low-confidence hot history lowers the baseline (damps false escalation)",
    hotOldLow.mean < hotOldHigh.mean,
    `hot-old-low ${hotOldLow.mean.toFixed(2)} vs hot-old-high ${hotOldHigh.mean.toFixed(2)}`,
  );

  // Live-window aggregation damping: baseline ≈ 30 MW; two live detections
  // — a 60 MW spike (band varies) + a steady 30 MW high-confidence one.
  // The confidence-weighted live mean must be LOWER when the spike is
  // nominal (0.7×) than when it is high (1.0×) — the core C1 property.
  // ("l" rows are excluded from scoring by the pre-existing confidence
  // gate, so the damping comparison is high vs nominal.)
  const history = [30, 30, 30, 30].map((frp, i) => ({ frp, ageDays: 30 + i, confidence: "h" }));
  const mkSpike = (conf: string) =>
    classifyFromDetections({
      facility: { lat: 30.7, lng: 76.8 },
      detections: [
        ...history.map((h, i) => det(h.frp, h.ageDays, "h", i, TODAY)),
        det(60, 1, conf, 9, TODAY),
        det(30, 2, "h", 8, TODAY),
      ],
      todayUtc: TODAY,
    });

  const cHighSpike = mkSpike("h");
  const cNominalSpike = mkSpike("n");
  check(
    "nominal-confidence spike damps the weighted live mean (vs high)",
    cNominalSpike.liveMeanFrp !== null &&
      cHighSpike.liveMeanFrp !== null &&
      cNominalSpike.liveMeanFrp < cHighSpike.liveMeanFrp,
    `nominal ${cNominalSpike.liveMeanFrp?.toFixed(2)} vs high ${cHighSpike.liveMeanFrp?.toFixed(2)}`,
  );
  check(
    "spike confidence never yields a WORSE status than high confidence",
    statusRank(cNominalSpike.status) <= statusRank(cHighSpike.status),
    `nominal ${cNominalSpike.status} vs high ${cHighSpike.status}`,
  );
  check(
    "high-confidence 60 MW spike elevates the status (suspicious/critical)",
    cHighSpike.status === "suspicious" || cHighSpike.status === "critical",
    `got ${cHighSpike.status}`,
  );

  // Legacy gate unchanged: a low-band spike does not participate in scoring
  // — the facility is classified from its usable history + the other live
  // detection alone (peak 30, watch), and the split still shows the low row.
  const cLowSpike = mkSpike("l");
  check(
    "low-band spike is excluded from scoring (livePeak stays 30, facility stays watch)",
    cLowSpike.livePeakFrp === 30 && cLowSpike.status === "watch",
    `peak ${cLowSpike.livePeakFrp} status ${cLowSpike.status}`,
  );
  check(
    "low-band spike still counted in the signal-quality split",
    cLowSpike.liveConfidenceSplit.high === 1 && cLowSpike.liveConfidenceSplit.low === 1,
    JSON.stringify(cLowSpike.liveConfidenceSplit),
  );
}

// ── 5. Signal-quality split exposure (C2 data) ────────────────────────────
{
  const c = classifyFromDetections({
    facility: { lat: 30.7, lng: 76.8 },
    detections: [
      det(25, 1, "h", 1, TODAY),
      det(28, 2, "h", 2, TODAY),
      det(31, 3, "n", 3, TODAY),
      det(22, 4, "l", 4, TODAY),
    ],
    todayUtc: TODAY,
  });
  check(
    "liveConfidenceSplit counts ALL nearby bands (low = gated out, not dropped)",
    c.liveConfidenceSplit.high === 2 && c.liveConfidenceSplit.nominal === 1 && c.liveConfidenceSplit.low === 1,
    JSON.stringify(c.liveConfidenceSplit),
  );
  check(
    "gated-out low detection keeps usable count at 3",
    c.detectionCount === 3,
    `got ${c.detectionCount}`,
  );
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
