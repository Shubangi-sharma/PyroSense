/**
 * chatService — conversational interface grounded in live facility + FIRMS data.
 *
 * Reuses the existing OpenRouter provider chain (same API key, same model).
 * The server stays stateless: the client sends prior turns with each request
 * and live context is injected from the CACHED analyses (same 15-min cache
 * every other endpoint reads — a chat message never re-classifies the whole
 * facility catalogue). Temperature 0.3 (slightly conversational, still
 * grounded).
 */

import { env, hasAiProvider } from "../config/env.js";
import { GENAI_QUEUE } from "../lib/http.js";
import { genaiLog } from "../lib/logger.js";
import { getCoverage, getAllFacilitiesMerged, getDetectionsInBox, type FacilityRow } from "../db/client.js";
import { analyzeFacility, analyzeAllFacilities, type FacilityAnalysis } from "./analysisService.js";
import { buildFactsText } from "./facts.js";
import { cacheKeys, getAnalysesCached } from "./cacheService.js";
import { callProvider, modelChain, type ProviderCall } from "./genaiService.js";
import { detectionTimestampUtc, USABLE_CONFIDENCE } from "./scoringService.js";
import { FACILITY_RADIUS_KM, LIVE_WINDOW_DAYS } from "../config/regions.js";
import { haversineKm } from "../lib/geo.js";

const CHAT_TIMEOUT_MS = 25_000;

/** History hygiene: hard caps so one abusive client cannot balloon the prompt. */
const MAX_HISTORY_TURNS = 12;
const MAX_TURN_CHARS = 1_000;

const SYSTEM_PROMPT = `You are PYROSENSE AI Assistant, a thermal-monitoring analyst embedded in an industrial site monitoring dashboard. You answer questions about facility fire risk, FIRMS satellite detections, Risk Scores, and anomalies.

RULES:
1. You will be given a CONTEXT block with current facility data and FIRMS detection statistics. Use ONLY this data to answer questions.
2. Never invent numbers, dates, facility names, or details not present in the context.
3. If the user asks about something not covered in the context, say the data is insufficient rather than guessing. The context ALWAYS includes a LAST 24 HOURS block (newest full data day compared against the previous day) plus 10-day live-window aggregates: for questions about recent activity or "what changed recently", answer from those blocks, citing the stated data-day dates, instead of claiming no recent data exists. Satellite detections are date-granular and NRT data can lag real time by up to ~1 day — mention that lag when it matters. The context also ALWAYS includes a SCORING METHODOLOGY block: questions about HOW scores, statuses, or classifications are calculated must be answered from that block — never refuse methodology questions as "not in context".
4. Keep answers concise and factual — this is a monitoring tool, not a chatbot.
5. You may use light markdown for readability: **bold** for facility names and key figures, bullet lists for multi-item answers, and tables for comparisons. Reference specific numbers from the context when relevant.
6. If asked about a specific facility, reference its unified Risk Score (0-100, higher = more risk) and current status.
7. Earlier turns of the conversation may be provided; stay consistent with them, but the CONTEXT block always outranks remembered statements.`;

/**
 * Last-24-hours block — computed from REAL stored detections (same rule as
 * everywhere else in the pipeline: never invented).
 *
 * FIRMS NRT data is date-granular, so "the last 24 hours" is answered with
 * the newest full data day in the DB vs the day before it (a true rolling
 * clock slice would mostly return empty windows and read as an outage).
 * Dates and row counts are stated explicitly so the model can cite them.
 */
function buildLast24hBlock(todayUtc: Date, facilities: FacilityRow[]): string {
  const toDate = todayUtc.toISOString().slice(0, 10);
  const fromDate = new Date(todayUtc.getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
  const rows = getDetectionsInBox({
    minLat: -90,
    maxLat: 90,
    minLng: -180,
    maxLng: 180,
    fromDate,
    toDate,
  });
  if (rows.length === 0) {
    return "LAST 24 HOURS: no detections stored in the last 14 days — data pipeline may be idle or the ingestion job has not run.";
  }

  const byDate = new Map<string, typeof rows>();
  for (const d of rows) {
    const list = byDate.get(d.acq_date);
    if (list) list.push(d);
    else byDate.set(d.acq_date, [d]);
  }
  const dates = [...byDate.keys()].sort();
  const newest = dates[dates.length - 1]!;
  const prev = dates.length >= 2 ? dates[dates.length - 2]! : null;

  const summarizeDay = (date: string) => {
    const dets = byDate.get(date)!;
    const usable = dets.filter((d) => USABLE_CONFIDENCE.has(d.confidence.toLowerCase()));
    const frps = usable.map((d) => d.frp).filter((v) => Number.isFinite(v));
    const meanFrp = frps.length ? frps.reduce((a, b) => a + b, 0) / frps.length : null;
    return { dets, usable, meanFrp };
  };

  const fmtNum = (n: number) => n.toLocaleString("en-US");

  const lines: string[] = [];
  const newDay = summarizeDay(newest);
  lines.push(
    `LAST 24 HOURS (newest data day ${newest}): ${fmtNum(newDay.dets.length)} detection${newDay.dets.length === 1 ? "" : "s"} stored (${fmtNum(newDay.usable.length)} usable confidence), ${newDay.meanFrp != null ? `mean FRP ${newDay.meanFrp.toFixed(1)} MW` : "no usable FRP readings"}.`,
  );

  if (prev) {
    const prevDay = summarizeDay(prev);
    const delta = newDay.dets.length - prevDay.dets.length;
    lines.push(
      `Previous day ${prev}: ${fmtNum(prevDay.dets.length)} detections — change day-over-day: ${delta >= 0 ? "+" : "−"}${fmtNum(Math.abs(delta))}.`,
    );
  } else {
    lines.push(`Previous day: none stored — no day-over-day comparison possible.`);
  }

  // Top facilities / areas by detections on the newest data day.
  const facilityCounts = new Map<string, number>();
  let unmatched = 0;
  for (const d of newDay.dets) {
    let best: { id: string; name: string; dist: number } | null = null;
    const dLatPad = FACILITY_RADIUS_KM / 111;
    const dLngPad = FACILITY_RADIUS_KM / (111 * Math.max(0.1, Math.cos((d.lat * Math.PI) / 180)));
    for (const f of facilities) {
      if (Math.abs(f.lat - d.lat) > dLatPad || Math.abs(f.lng - d.lng) > dLngPad) continue;
      const dist = haversineKm(f.lat, f.lng, d.lat, d.lng);
      if (dist <= FACILITY_RADIUS_KM && (!best || dist < best.dist)) {
        best = { id: f.id, name: f.name, dist };
      }
    }
    if (best) {
      facilityCounts.set(best.name, (facilityCounts.get(best.name) ?? 0) + 1);
    } else {
      unmatched += 1;
    }
  }
  const topNames = [...facilityCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, n]) => `${name} (${n})`);
  lines.push(
    `Affected facilities on ${newest}: ${topNames.length > 0 ? topNames.join(", ") : "none within the 5 km corroboration radius"}. Detections not near any monitored facility: ${fmtNum(unmatched)} (unidentified thermal sources).`,
  );

  lines.push(`Data day granularity: detections are aggregated by acquisition date, not a rolling clock; NRT satellite data can lag real time by up to ~1 day.`);
  return lines.join("\n");
}

/**
 * Methodology block — the REAL scoring formulas, rendered from the same
 * constants scoringService/classificationService use, so methodology
 * questions ("how are risk scores calculated?") are answerable from the
 * context instead of triggering a data-insufficient refusal. Mirrors the
 * code — if scoring changes, update these strings in lockstep.
 */
function buildMethodologyBlock(): string {
  const lines: string[] = [];
  lines.push("=== SCORING METHODOLOGY (system facts) ===");
  lines.push(
    `Unified Risk Score (0-100, HIGHER = MORE RISK): a weighted blend renormalized over the signals available for each facility — base signal 40% (the FRP-anomaly rule, inverted: a quiet site scores 10, an actively burning site scores high; derived from the live-window FRP penalties: frequency scaling with active days, log-scaled magnitude with confidence-weighted mean FRP, instability with FRP CV, spatial spread, recency, and trend vs the facility's recency×confidence-weighted baseline); environment signal 35% (ML classification risk: weighted probability × domain danger weights over the 5 hotspot categories, informed by FIRMS history, OSM distances, land cover and weather); temporal signal 25% (GRU 1/3/7-day fire-risk probabilities for the facility's H3 cell, unweighted mean × 100, from the nightly pipeline). When the ML service or a stored prediction is unavailable, the remaining weights are renormalized to 100% and the response's provenance lists which signals actually contributed.`,
  );
  lines.push(
    `Risk statuses: critical = live peak FRP more than 2.0× the trusted recency-weighted baseline; suspicious = 1.3×-2.0× baseline, OR new detections in the last 5 days with no prior activity within 2 km; watch = persistent pattern (≥2 detections spread over ≤3 km with FRP CV ≤0.45) or default when activity exists. Statuses require a trusted baseline (≥3 weighted samples) for the ratio-based tiers.`,
  );
  lines.push(
    `Recency-weighted baseline FRP: each detection weighted by exp(−ln(4)·ageDays/30) × confidence weight — age in days, so a 30-day-old detection carries ¼ the weight of a fresh one; confidence weights: high=1.0, nominal=0.7, low=0.4. Only usable confidence bands (high, nominal, medium) enter scoring; low-confidence detections are excluded but counted in Signal Quality.`,
  );
  lines.push(
    `Corroboration radius: detections within ${FACILITY_RADIUS_KM} km of the facility centroid count toward it (5 km default; user-drawn boundaries use point-in-polygon). Live window: last ${LIVE_WINDOW_DAYS} days. Baseline kernel half-life ≈15 days, weights decay to ~1/1000 by 5 months.`,
  );
  return lines.join("\n");
}

/**
 * Cached overview classification — the SAME cache the analyses/command
 * endpoints read (15-min TTL, invalidated after each ingestion refresh).
 * Before this, every chat message re-ran the full-facility classification.
 */
async function getCachedAnalyses(): Promise<FacilityAnalysis[]> {
  const key = cacheKeys.analyses("chat-overview", "0", "0");
  return getAnalysesCached(key, () => analyzeAllFacilities(new Date()));
}

async function buildContext(facilityId?: string): Promise<string> {
  const lines: string[] = [];
  const coverage = getCoverage();

  lines.push("=== PYROSENSE LIVE CONTEXT ===");
  lines.push(`Data coverage: ${coverage.minDate ?? "no data"} to ${coverage.maxDate ?? "no data"} (${coverage.rows} total detections)`);
  lines.push(`Live window: last ${LIVE_WINDOW_DAYS} days`);

  // Real last-24h facts — every "what changed recently" question is answered
  // from this block, not from the 10-day aggregates below.
  const facilities = getAllFacilitiesMerged();
  lines.push("");
  lines.push(buildLast24hBlock(new Date(), facilities));

  // Real methodology from scoringService/classificationService — answers
  // "how are scores calculated" questions without inventing formulas.
  lines.push("");
  lines.push(buildMethodologyBlock());

  if (facilityId) {
    // Focused context on one facility (single-site analysis is millisecond
    // queries against indexed tables — no cache needed).
    const facility = facilities.find((f) => f.id === facilityId);
    if (facility) {
      const { facts, narrative } = await analyzeFacility(facility, new Date());
      lines.push("");
      lines.push("=== SELECTED FACILITY ===");
      lines.push(buildFactsText(facts));
      if (narrative.whatChanged.length > 0) {
        lines.push("");
        lines.push("What Changed:");
        for (const wc of narrative.whatChanged) {
          lines.push(`  ${wc.kind === "warning" ? "⚠" : "✅"} ${wc.text}${wc.value ? ` (${wc.value})` : ""}`);
        }
      }
    } else {
      lines.push("");
      lines.push(`=== SELECTED FACILITY ===`);
      lines.push(`Facility id "${facilityId}" not found — fall back to the monitoring overview.`);
    }
  } else {
    // Overview context — cached top-level stats
    const analyses = await getCachedAnalyses();
    const stats = {
      total: analyses.length,
      withDetections: analyses.filter((a) => a.detectionCount > 0).length,
      critical: analyses.filter((a) => a.status === "critical").length,
      suspicious: analyses.filter((a) => a.status === "suspicious").length,
      watch: analyses.filter((a) => a.status === "watch").length,
      normal: analyses.filter((a) => a.status === "normal").length,
    };
    lines.push("");
    lines.push("=== MONITORING OVERVIEW ===");
    lines.push(`Facilities monitored: ${stats.total}`);
    lines.push(`With thermal detections: ${stats.withDetections}`);
    lines.push(`Critical: ${stats.critical}`);
    lines.push(`Suspicious: ${stats.suspicious}`);
    lines.push(`Watch: ${stats.watch}`);
    lines.push(`Normal: ${stats.normal}`);

    // Top 5 facilities needing attention (unified Risk Score, higher = more risk)
    const top5 = [...analyses]
      .sort((a, b) => {
        const rank: Record<string, number> = { critical: 0, suspicious: 1, watch: 2, unknown: 3, normal: 4 };
        return (rank[a.status] ?? 4) - (rank[b.status] ?? 4) || b.riskScore - a.riskScore;
      })
      .slice(0, 5);

    if (top5.length > 0) {
      lines.push("");
      lines.push("Top facilities needing attention:");
      for (const a of top5) {
        lines.push(`  - ${a.facility.name} (${a.facility.type}): status=${a.status}, riskScore=${a.riskScore}, detections=${a.detectionCount}${a.latestFrp != null ? `, latest FRP=${a.latestFrp.toFixed(1)} MW` : ""}`);
      }
    }
  }

  return lines.join("\n");
}

/** One prior conversation turn, already sanitized. */
export interface ChatHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/** Clamp + filter client-supplied history so it can never blow up the prompt. */
function sanitizeHistory(raw: unknown): ChatHistoryTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: ChatHistoryTurn[] = [];
  for (const item of raw.slice(-MAX_HISTORY_TURNS)) {
    if (!item || typeof item !== "object") continue;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string") continue;
    const clipped = content.trim().slice(0, MAX_TURN_CHARS);
    if (clipped) turns.push({ role, content: clipped });
  }
  return turns;
}

export interface ChatResponse {
  reply: string;
  provider: "openrouter" | "fallback";
  grounded: boolean;
}

export async function chat(
  message: string,
  facilityId?: string,
  history: ChatHistoryTurn[] = [],
): Promise<ChatResponse> {
  if (!hasAiProvider()) {
    return {
      reply: "AI chat is not available — no OpenRouter API key configured. The system is running in template-only mode. You can still view all facility data, scores, and What Changed reports in the dashboard.",
      provider: "fallback",
      grounded: true,
    };
  }

  const context = await buildContext(facilityId);
  const priorTurns = sanitizeHistory(history);

  const url = `${env.OPENROUTER_API_URL.replace(/\/+$/, "")}/chat/completions`;
  const messages = [
    { role: "system", content: `${SYSTEM_PROMPT}\n\n${context}` },
    ...priorTurns.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: message },
  ];

  // Same chain semantics as summaries: primary model → fallback models.
  // callProvider disables reasoning and strips <think> blocks, so a
  // reasoning-tuned free model can no longer eat the whole token budget.
  for (const model of modelChain()) {
    const p: ProviderCall = { provider: "openrouter", url, apiKey: env.OPENROUTER_API_KEY!, model };
    try {
      const reply = await GENAI_QUEUE(() =>
        callProvider(p, messages, { timeoutMs: CHAT_TIMEOUT_MS, temperature: 0.3, maxTokens: 500 }),
      );
      genaiLog.info({ facilityId: facilityId ?? "overview", model, turns: priorTurns.length }, "chat response served");
      return { reply, provider: "openrouter", grounded: true };
    } catch (err) {
      genaiLog.warn({ err: String(err), model }, "chat provider call failed, trying next model");
    }
  }

  return {
    reply: "I'm sorry, I couldn't process your question right now. The AI provider is temporarily unavailable. Please check the dashboard directly for facility status, scores, and anomaly reports.",
    provider: "fallback",
    grounded: true,
  };
}
