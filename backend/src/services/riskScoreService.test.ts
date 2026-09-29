/**
 * riskScoreService tests — node:test runner (Node ≥20, tsx import loader).
 *
 * Covers the composition contract:
 *  1. all three signals → hand-computed weighted composite
 *  2. ML unreachable → renormalized to base-only, provenance ["base"]
 *  3. temporal missing, classification present → two-signal renormalization
 *  4. quiet-site edge case: base contribution is 10 (100 − QUIET_BASELINE 90), not 0
 *  5. monotonicity: raising any one signal never lowers the composite
 *  6. temporal signal: raw probabilities win; bucket fallback; hotspot mode
 *
 * run: npm run test:services  (from backend/)
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_WEIGHT,
  ENVIRONMENT_WEIGHT,
  TEMPORAL_WEIGHT,
  baseSignalFromScore,
  composeCachedRiskScore,
  temporalSignalFromCellRisk,
} from "./riskScoreService.js";

test("weights are the documented 0.40 / 0.35 / 0.25", () => {
  assert.equal(BASE_WEIGHT, 0.4);
  assert.equal(ENVIRONMENT_WEIGHT, 0.35);
  assert.equal(TEMPORAL_WEIGHT, 0.25);
});

test("all three signals → hand-computed weighted composite", () => {
  const base = 40;
  const environment = 80;
  const temporal = 20;
  // hand-computed: (40*0.4 + 80*0.35 + 20*0.25) / 1.0 = 16 + 28 + 5 = 49
  const r = composeCachedRiskScore(base, { environment, temporal, computedAt: "2026-09-29T00:00:00Z" });
  assert.equal(r.riskScore, 49);
  assert.deepEqual(r.riskScoreProvenance, ["base", "environment", "temporal"]);
  assert.equal(r.live, false);
  assert.equal(r.computedAt, "2026-09-29T00:00:00Z");
});

test("ML unreachable → renormalized to base-only, provenance [\"base\"]", () => {
  const r = composeCachedRiskScore(37, null);
  assert.equal(r.riskScore, 37);
  assert.deepEqual(r.riskScoreProvenance, ["base"]);
  // computedAt falls back to "now" when only base contributed — assert it is a parseable ISO time.
  assert.ok(!Number.isNaN(Date.parse(r.computedAt)));
});

test("temporal unavailable, classification available → two-signal renormalization", () => {
  // weights: base 0.4 + env 0.35 = 0.75
  // hand-computed: (10*0.4 + 70*0.35) / 0.75 = (4 + 24.5) / 0.75 = 38
  const r = composeCachedRiskScore(10, { environment: 70, computedAt: "2026-09-28T22:15:00Z" });
  assert.equal(r.riskScore, 38);
  assert.deepEqual(r.riskScoreProvenance, ["base", "environment"]);
  assert.equal(r.computedAt, "2026-09-28T22:15:00Z");
});

test("quiet-site edge case: base contribution is 10 (100 − QUIET_BASELINE), not 0", () => {
  const base = baseSignalFromScore(90); // QUIET_BASELINE = 90 inside computeBaseScore
  assert.equal(base, 10, "a fully quiet site still carries residual risk of 10, not 0");
  // And base-only composition preserves exactly that value.
  const r = composeCachedRiskScore(base, null);
  assert.equal(r.riskScore, 10);
});

test("base signal clamps and inverts cleanly", () => {
  assert.equal(baseSignalFromScore(0), 100);
  assert.equal(baseSignalFromScore(100), 0);
  assert.equal(baseSignalFromScore(55), 45);
});

test("monotonicity: raising any one signal never lowers the composite", () => {
  const steps = [0, 10, 20, 35, 50, 65, 80, 90, 100];
  const cachedVariants = [
    null,
    { environment: 30, temporal: 60, computedAt: "t" },
    { environment: 70, computedAt: "t" },
    { temporal: 85, computedAt: "t" },
  ];
  for (const cached of cachedVariants) {
    for (let i = 1; i < steps.length; i++) {
      const prev = composeCachedRiskScore(steps[i - 1]!, cached).riskScore;
      const next = composeCachedRiskScore(steps[i]!, cached).riskScore;
      assert.ok(
        next >= prev,
        `base ${steps[i - 1]}→${steps[i]} must not lower composite (${prev}→${next})`,
      );
    }
  }
  // Environment monotonicity (base held fixed at 50).
  for (let i = 1; i < steps.length; i++) {
    const prev = composeCachedRiskScore(50, { environment: steps[i - 1]!, temporal: 40, computedAt: "t" }).riskScore;
    const next = composeCachedRiskScore(50, { environment: steps[i]!, temporal: 40, computedAt: "t" }).riskScore;
    assert.ok(next >= prev, `env ${steps[i - 1]}→${steps[i]} must not lower composite`);
  }
  // Temporal monotonicity (base + env held fixed).
  for (let i = 1; i < steps.length; i++) {
    const prev = composeCachedRiskScore(50, { environment: 40, temporal: steps[i - 1]!, computedAt: "t" }).riskScore;
    const next = composeCachedRiskScore(50, { environment: 40, temporal: steps[i]!, computedAt: "t" }).riskScore;
    assert.ok(next >= prev, `temporal ${steps[i - 1]}→${steps[i]} must not lower composite`);
  }
});

test("temporal signal: unweighted mean of raw horizon probabilities × 100", () => {
  const t = temporalSignalFromCellRisk({
    horizons: {
      "1day": { probability: 0.2, level: "LOW", threshold: 0.5 },
      "3day": { probability: 0.5, level: "LOW", threshold: 0.4 },
      "7day": { probability: 0.9, level: "HIGH", threshold: 0.3 },
    },
    overall: "HIGH",
  });
  // (0.2 + 0.5 + 0.9) / 3 = 0.5333… → 53.33… → clamped/used unrounded by compose; assert ≈ 53.33
  assert.ok(Math.abs((t ?? 0) - 53.3333333) < 0.001);
});

test("temporal signal: bucket fallback only when probabilities are missing", () => {
  assert.equal(temporalSignalFromCellRisk({ horizons: {}, overall: "HIGH" }), 100);
  assert.equal(temporalSignalFromCellRisk({ horizons: {}, overall: "MODERATE" }), 55);
  assert.equal(temporalSignalFromCellRisk({ horizons: {}, overall: "LOW" }), 15);
  assert.equal(temporalSignalFromCellRisk(null), null);
  assert.equal(temporalSignalFromCellRisk({ horizons: {}, overall: "WEIRD" }), null);
  // Raw probabilities take precedence over the bucket.
  const t = temporalSignalFromCellRisk({
    horizons: { "1day": { probability: 0.3, level: "LOW", threshold: 0.5 } },
    overall: "HIGH",
  });
  assert.equal(t, 30);
});
