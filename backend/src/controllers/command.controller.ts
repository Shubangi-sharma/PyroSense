/**
 * command.controller — GET /api/command
 *
 * Top-level command view: counters + priority-ranked facility list.
 * Single endpoint that both the dashboard and the chatbot read from.
 *
 * Risk Score here is the UNIFIED one (riskScoreService): the facility's
 * cached bulk composition (fresh local base signal + nightly ML-derived
 * environment/temporal components), provenance included. The retired ad hoc
 * computeRiskScore blend (inverse-score*0.4 + rule-based classRisk*0.3 +
 * frpRisk*0.2 + trendRisk*0.1) is DELETED, not deprecated — per the repo's
 * Phase 2A precedent (risk_score.py removed its legacy formula without
 * even a comment). classifyRuleBased survives ONLY as an informational
 * behavioural label ("classificationLabel"), not as a scoring input.
 */

import { Request, Response } from "express";
import { analyzeAllFacilities } from "../services/analysisService.js";
import { getDbStats } from "../db/client.js";
import {
  buildClassificationSignals,
  CLASSIFICATION_LABELS,
  classifyRuleBased,
} from "../services/classificationService.js";
import { getDetectionsNear, getBaseline } from "../db/client.js";
import { parseBaseline } from "../services/fingerprintService.js";
import { FACILITY_RADIUS_KM, LIVE_WINDOW_DAYS } from "../config/regions.js";
import { getAnalysesCached, cacheKeys } from "../services/cacheService.js";

interface CommandFacility {
  id: string;
  name: string;
  type: string;
  lat: number;
  lng: number;
  status: string;
  /** Unified Risk Score — 0–100, HIGHER = MORE RISK (riskScoreService). */
  riskScore: number;
  riskScoreProvenance: string[];
  riskScoreComputedAt: string;
  riskScoreLive: boolean;
  /** Informational behavioural label (rule-based) — NOT a score input. */
  classification: string;
  classificationLabel: string;
  detectionCount: number;
  latestFrp: number | null;
}

export async function getCommand(req: Request, res: Response): Promise<void> {
  const key = cacheKeys.analyses("command", "0", "0");

  const result = await getAnalysesCached(key, async () => {
    const analyses = await analyzeAllFacilities(new Date());
    const todayUtc = new Date();
    const fromDate = new Date(todayUtc.getTime() - LIVE_WINDOW_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const priorityList: CommandFacility[] = [];

    for (const a of analyses) {
      // Informational behavioural label only — the unified Risk Score no
      // longer consumes rule-based classification severity. Kept because the
      // chatbot/dashboard UI groups facilities by this label; flagged as an
      // open question in docs/RISK_SCORE_UNIFICATION.md.
      const baselineRow = getBaseline(a.facility.id);
      const baseline = parseBaseline(baselineRow);
      const dets = getDetectionsNear(
        a.facility.lat,
        a.facility.lng,
        FACILITY_RADIUS_KM + 1,
        fromDate,
      );
      const signals = buildClassificationSignals(a.facility, dets, baseline);
      const classification = classifyRuleBased(signals);

      priorityList.push({
        id: a.facility.id,
        name: a.facility.name,
        type: a.facility.type,
        lat: a.facility.lat,
        lng: a.facility.lng,
        status: a.status,
        riskScore: a.riskScore,
        riskScoreProvenance: a.riskScoreProvenance,
        riskScoreComputedAt: a.riskScoreComputedAt,
        riskScoreLive: a.riskScoreLive,
        classification,
        classificationLabel: CLASSIFICATION_LABELS[classification],
        detectionCount: a.detectionCount,
        latestFrp: a.latestFrp,
      });
    }

    // Sort by risk score descending (highest risk first)
    priorityList.sort((a, b) => b.riskScore - a.riskScore);

    // Real unidentified-thermal-source count: distinct UTS-* facility ids the
    // matcher assigned during the last matching pass — not a hardcoded 0.
    const unidentifiedSources = getDbStats().unidentifiedSources;

    const stats = {
      facilitiesMonitored: analyses.length,
      totalHotspots: analyses.filter((a) => a.detectionCount > 0).length,
      newAnomalies: analyses.filter((a) => a.status === "watch").length,
      highRisk: analyses.filter((a) => a.status === "suspicious").length,
      critical: analyses.filter((a) => a.status === "critical").length,
      unidentifiedSources,
      // Bulk-view freshness: when the newest cached ML component was
      // computed (bulk views read cached components; detail views compute
      // live — the UI labels the difference).
      riskScoreComputedAt: analyses[0]?.riskScoreComputedAt ?? new Date().toISOString(),
    };

    return { ...stats, priorityList };
  });

  // The command view refreshes on a 30s poll client-side; short browser
  // caching keeps showcase navigation instant without hiding fresh data.
  res.setHeader("Cache-Control", "public, max-age=30");
  res.status(200).json(result);
}
