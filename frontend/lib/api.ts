/**
 * PYROSENSE — backend API client.
 *
 * The Next.js app is a pure frontend: every computation (classification,
 * scoring, narratives, AI summaries) happens in the standalone backend
 * service (backend/, Express + SQLite). This module is the ONLY place that
 * knows the backend's URL and response shapes.
 *
 * Auth-free by design: the backend holds every secret; the browser never
 * sees a key. NEXT_PUBLIC_API_BASE_URL is the single knob (default
 * http://localhost:4000).
 */

/* ------------------------------------------------------------------ */
/* base url                                                            */
/* ------------------------------------------------------------------ */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") ||
  // Production default: the deployed Render backend. NEXT_PUBLIC_ vars are
  // inlined at BUILD time, so a Vercel deploy without the env var set used to
  // fall back to localhost:4000 — unreachable from every visitor's browser.
  // Local dev keeps overriding via .env.local.
  (process.env.NODE_ENV === "production" && process.env.VERCEL
    ? "https://pyrosense-2aif.onrender.com"
    : "http://localhost:4000");

/* ------------------------------------------------------------------ */
/* DTOs (mirror the backend's controllers — keep both sides in sync)    */
/* ------------------------------------------------------------------ */

export interface FacilityDto {
  id: string;
  name: string;
  lat: number;
  lng: number;
  type: string;
  source: string;
  updated_at: string;
}

/** A classified facility — status/score computed by the backend. */
export interface FacilityAnalysisDto {
  facility: FacilityDto;
  status: "normal" | "watch" | "suspicious" | "critical" | "unknown";
  score: number;
  latestFrp: number | null;
  latestTimestampUtc: string | null;
  nearestKm: number | null;
  /** usable detections within the corroboration radius, last 10 days */
  detectionCount: number;
  liveCount: number;
  liveMeanFrp: number | null;
  baselineMeanFrp: number | null;
  /**
   * VIIRS confidence-band split of the live window (backend Track C).
   * `low` counts gated-out rows too — Signal Quality shows the real mix.
   */
  liveConfidenceSplit?: { high: number; nominal: number; low: number };
  /**
   * Contextual "Predicted Fire Type" — the backend's evidence-based
   * prediction of what is actually burning (agricultural burn, forest fire,
   * campfire, industrial incident, …). Optional: older cached analyses
   * predate the field.
   */
  predictedTag?: PredictedTagDto;
}

/** Backend's contextual predicted fire type (fireTagService). */
export interface PredictedTagDto {
  tag: string;
  /** 0–1 dominance-based belief — a prediction, never a measurement. */
  confidence: number;
  /** human-readable evidence that drove the prediction */
  reasons: string[];
  /** "ml_observations" (env-enriched) | "fire_physics_only" (fallback) */
  provenance?: string;
}

export interface WhatChangedRowDto {
  kind: "ok" | "warning";
  text: string;
  value?: string;
  severity?: FacilityAnalysisDto["status"];
}

export interface DetectionEventDto {
  time: string;
  text: string;
  severity: FacilityAnalysisDto["status"];
}

export interface NarrativeDto {
  whatChanged: WhatChangedRowDto[];
  timeline: DetectionEventDto[];
  templatedSummary: string;
  /** "openrouter" when LLM-generated, "template" for the fallback. */
  provider?: "openrouter" | "template";
}

/** PDF §4 persistence group — computed from the stored FIRMS archive. */
export interface PersistenceBlockDto {
  totalDetections: number;
  uniqueDays: number;
  activeDurationDays: number | null;
  firstDetectionDate: string | null;
  lastDetectionDate: string | null;
}

/** PDF §4 fire-characteristics group — computed from stored detections. */
export interface FireCharacteristicsBlockDto {
  meanFrp: number | null;
  maxFrp: number | null;
  minFrp: number | null;
  latestBrightnessK: number | null;
  dayNightSplit: { day: number; night: number };
  confidenceSplit: Record<string, number>;
  satelliteSplit: Record<string, number>;
}

export interface FacilityAnalysisResponseDto {
  facility: FacilityDto;
  classification:
    | FacilityAnalysisDto["status"]
    | {
        status: FacilityAnalysisDto["status"];
        score: number;
        latestFrp: number | null;
        latestTimestampUtc: string | null;
        nearestKm: number | null;
        detectionCount: number;
        liveCount: number;
        liveMeanFrp: number | null;
        baselineMeanFrp: number | null;
        liveConfidenceSplit?: { high: number; nominal: number; low: number };
      };
  narrative: NarrativeDto;
  /** PDF §4 groups (optional: older backends may omit them). */
  persistence?: PersistenceBlockDto;
  fireCharacteristics?: FireCharacteristicsBlockDto;
  /** Contextual predicted fire type (environment-enriched server-side). */
  predictedTag?: PredictedTagDto;
}

export interface SummaryResponseDto {
  facilityId: string;
  text: string;
  /** which provider actually served the text: openrouter | template */
  provider: "openrouter" | "template";
  factsHash?: string;
}

/* ------------------------------------------------------------------ */
/* fetchers                                                            */
/* ------------------------------------------------------------------ */

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`backend ${res.status} for ${path}`);
  return (await res.json()) as T;
}

async function fetchText(path: string): Promise<string> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`backend ${res.status} for ${path}`);
  return res.text();
}

/* ------------------------------------------------------------------ */
/* endpoints                                                           */
/* ------------------------------------------------------------------ */

/** GET /api/analyses?bbox=… — classified facilities for a region window. */
export function fetchAnalyses(bbox: string): Promise<{ analyses: FacilityAnalysisDto[]; count: number }> {
  return fetchJson(`/api/analyses?bbox=${encodeURIComponent(bbox)}`);
}

/** GET /api/firms?bbox=…&dayRange=… — stored detections as FIRMS-format CSV. */
export function fetchFirmsCsv(bbox: string, dayRange = 10): Promise<string> {
  return fetchText(`/api/firms?bbox=${encodeURIComponent(bbox)}&dayRange=${dayRange}`);
}

/** GET /api/facilities/:id/analyses — one facility's classification + narrative. */
export function fetchFacilityAnalysis(id: string): Promise<FacilityAnalysisResponseDto> {
  return fetchJson(`/api/facilities/${encodeURIComponent(id)}/analyses`);
}

/** GET /api/facilities/:id/summary — grounded AI summary (with fallback chain). */
export function fetchSummary(id: string): Promise<SummaryResponseDto> {
  return fetchJson(`/api/facilities/${encodeURIComponent(id)}/summary`);
}

/* ------------------------------------------------------------------ */
/* command view — top-level counters + priority list                    */
/* ------------------------------------------------------------------ */

export interface CommandViewDto {
  facilitiesMonitored: number;
  totalHotspots: number;
  newAnomalies: number;
  highRisk: number;
  critical: number;
  unidentifiedSources: number;
  priorityList: {
    id: string;
    name: string;
    type: string;
    lat: number;
    lng: number;
    status: string;
    healthScore: number;
    riskScore: number;
    classification: string;
    classificationLabel: string;
    detectionCount: number;
    latestFrp: number | null;
  }[];
}

/** GET /api/command — top-level command view with counters + priority list. */
export function fetchCommand(): Promise<CommandViewDto> {
  return fetchJson(`/api/command`);
}

/* ------------------------------------------------------------------ */
/* chatbot                                                             */
/* ------------------------------------------------------------------ */

export interface ChatResponseDto {
  reply: string;
  provider: "openrouter" | "fallback";
  grounded: boolean;
}

/** Prior turns sent along so the assistant keeps conversational context. */
export interface ChatHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/** POST /api/chat — send a message (plus optional history) to the grounded chatbot. */
export async function postChat(
  message: string,
  facilityId?: string,
  history: ChatHistoryTurn[] = [],
): Promise<ChatResponseDto> {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, facilityId, history }),
  });
  if (!res.ok) throw new Error(`backend ${res.status} for /api/chat`);
  return (await res.json()) as ChatResponseDto;
}
