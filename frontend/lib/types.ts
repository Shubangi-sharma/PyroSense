/**
 * PYROSENSE — shared domain types (client side).
 *
 * The Next.js app is a pure frontend: facilities come from the backend's
 * ingested OSM catalogue, thermal detections from the backend's stored FIRMS
 * archive, and risk status / Risk Score / narrative content are COMPUTED
 * by the backend (backend/src/services/). Nothing is invented client-side.
 */

/* ------------------------------------------------------------------ */
/* Risk status — the 5-tier palette (colour + shape, design.md §9)      */
/* ------------------------------------------------------------------ */

export type RiskStatus =
  | "normal"
  | "watch"
  | "suspicious"
  | "critical"
  | "unknown";

/** Facility category, derived from which OSM tag matched (§2). */
export type FacilityType =
  | "Refinery"
  | "Power Plant"
  | "Industrial Site"
  | "Mine";

export interface Facility {
  /** Stable OSM-derived id, e.g. "osm-node-123456" / "osm-way-98765". */
  id: string;
  /** OSM name tag, or a generated "Industrial Site #<id>" fallback. */
  name: string;
  type: FacilityType;
  lat: number;
  lng: number;
  source: "osm" | "user_dataset";
}

/**
 * One FIRMS detection, as displayed in tooltips (parsed client-side from
 * the backend's FIRMS-format CSV). Scoring does NOT happen here — the
 * backend classifies facilities against its full-year database.
 */
export interface Detection {
  latitude: number;
  longitude: number;
  frp: number;
  brightness: number;
  confidence: string;
  satellite: string;
  instrument: string;
  acqDate: string; // YYYY-MM-DD
  acqTime: string; // HHMM
  daynight: "D" | "N";
  /** days before "now" at parse time (0 = today) */
  ageDays: number;
}

/**
 * A classified facility — the backend computes status/score from its
 * SQLite FIRMS archive and serves the result (lib/api.ts DTO).
 */
export interface FacilityAnalysis {
  facility: Facility;
  status: RiskStatus;
  /**
   * Unified Risk Score — 0–100, HIGHER = MORE RISK (riskScoreService:
   * base FRP-anomaly + ML classification + GRU temporal, renormalized over
   * the signals actually available).
   */
  riskScore: number;
  /** Which signals contributed ("base"|"environment"|"temporal"). */
  riskScoreProvenance?: string[];
  /** ISO timestamp of the newest contributing signal. */
  riskScoreComputedAt?: string;
  /** true = live composition (detail views); false = cached (bulk views). */
  riskScoreLive?: boolean;
  /** Latest detection FRP within the corroboration radius, MW. Null = none. */
  latestFrp: number | null;
  /** km to the nearest detection; null = no detection nearby. */
  nearestKm: number | null;
  /** Usable detections within the radius in the live window. */
  detectionCount: number;
  /** Confidence-weighted mean FRP of the live window, MW (null = none). */
  liveMeanFrp: number | null;
  /** Recency×confidence-weighted full-history baseline FRP mean (null = no baseline). */
  baselineMeanFrp: number | null;
  /**
   * Contextual Predicted Fire Type from the backend (optional: older cached
   * analyses predate the field).
   */
  predictedTag?: { tag: string; confidence: number; reasons: string[]; provenance?: string };
  /**
   * VIIRS confidence-band split of the live window (backend Track C).
   * Optional: older cached analyses may predate the field.
   */
  liveConfidenceSplit?: { high: number; nominal: number; low: number };
}

/* ------------------------------------------------------------------ */
/* Predicted Fire Type (backend fireTagService — contextual tagging)    */
/* ------------------------------------------------------------------ */

export const FIRE_TAG_META: Record<
  string,
  { label: string; hex: string; blurb: string }
> = {
  crop_stubble_burn: {
    label: "Agricultural burn",
    hex: "#E0A84C",
    blurb: "Stubble/crop-residue burning — seasonal, daytime, low-power, on farmland.",
  },
  forest_wildfire: {
    label: "Forest wildfire",
    hex: "#E06060",
    blurb: "Vegetation fire in wooded land — spreading, high radiant power.",
  },
  grass_shrub_burn: {
    label: "Grass/shrub burn",
    hex: "#CBB26A",
    blurb: "Open-land grass or scrub fire — moderate power, dispersed points.",
  },
  campfire: {
    label: "Campfire / small fire",
    hex: "#9CB86E",
    blurb: "Tiny, isolated, low-power heat source — human-scale, short-lived.",
  },
  structure_fire_settlement: {
    label: "Fire near settlement",
    hex: "#E08A52",
    blurb: "Hot, persistent heat close to built-up areas / housing.",
  },
  industrial_incident: {
    label: "Industrial incident",
    hex: "#E06060",
    blurb: "Elevated FRP at an industrial asset, above its own baseline.",
  },
  refinery_fire: {
    label: "Refinery / plant fire",
    hex: "#C46A6A",
    blurb: "Large sustained burning at a matched refinery or fuel-storage site.",
  },
  gas_flare: {
    label: "Gas flare",
    hex: "#9186C4",
    blurb: "Steady, single-point, continuous burning at energy infrastructure.",
  },
  mining_heat: {
    label: "Mining heat",
    hex: "#4FB3B3",
    blurb: "Persistent low-power heating at/near a mine or quarry.",
  },
  waste_burning: {
    label: "Waste burning",
    hex: "#A0927C",
    blurb: "Persistent low-to-moderate heat on open/bare ground near settlement — open dumping.",
  },
  unknown: {
    label: "Unclassified",
    hex: "#5D6570",
    blurb: "Not enough evidence to predict the fire type yet.",
  },
};

export const fireTagMeta = (
  tag: string | undefined | null,
): { label: string; hex: string; blurb: string } =>
  (tag && FIRE_TAG_META[tag]) || FIRE_TAG_META.unknown;

export const STATUS_ORDER: RiskStatus[] = [
  "normal",
  "watch",
  "suspicious",
  "critical",
  "unknown",
];

export const STATUS_META: Record<
  RiskStatus,
  {
    label: string;
    hex: string;
    shape: "dot" | "diamond" | "triangle" | "octagon" | "square";
    tag: string;
  }
> = {
  normal: { label: "Normal", hex: "#4ECBA0", shape: "dot", tag: "NML" },
  watch: { label: "Watch", hex: "#E0A84C", shape: "diamond", tag: "WTC" },
  suspicious: { label: "Suspicious", hex: "#E08A52", shape: "triangle", tag: "SUS" },
  critical: { label: "Critical", hex: "#E06060", shape: "octagon", tag: "CRT" },
  unknown: { label: "Unknown", hex: "#5D6570", shape: "square", tag: "UNK" },
};

export const statusColorHex = (s: RiskStatus): string => STATUS_META[s].hex;

/* ------------------------------------------------------------------ */
/* Backend-served narrative content (computed diffs + grounded AI)      */
/* ------------------------------------------------------------------ */

/** One real FIRMS detection, summarised for UI display. */
export interface DetectionEvent {
  /** ISO-ish "YYYY-MM-DD HH:MM" acquisition timestamp (UTC). */
  time: string;
  /** Human sentence describing the real detection. */
  text: string;
  severity: RiskStatus;
}

export interface WhatChangedRow {
  kind: "ok" | "warning";
  text: string;
  /** right-aligned mono value, e.g. "+40%", "+3" */
  value?: string;
  severity?: RiskStatus;
}

/**
 * Per-facility narrative served by the backend: computed What-Changed rows
 * and a real timeline, plus the AI summary fetched separately so it can
 * regenerate independently of the classification cache.
 */
export interface FacilityNarrative {
  whatChanged: WhatChangedRow[];
  /** Detections sorted newest-first (real acquisition timestamps). */
  timeline: DetectionEvent[];
}

/* ------------------------------------------------------------------ */
/* Classification + Risk Score (new pipeline outputs)                   */
/* ------------------------------------------------------------------ */

export type ThermalClassification =
  | "industrial_fire"
  | "gas_flare"
  | "crop_burning"
  | "mining_activity"
  | "wildfire"
  | "persistent_source"
  | "normal_operations"
  | "unknown";

export const CLASSIFICATION_LABELS: Record<ThermalClassification, string> = {
  industrial_fire: "Industrial Fire",
  gas_flare: "Gas Flare",
  crop_burning: "Crop Burning",
  mining_activity: "Mining Activity",
  wildfire: "Wildfire",
  persistent_source: "Persistent Source",
  normal_operations: "Normal Operations",
  unknown: "Unknown",
};

/** Command view — top-level counters + priority-ranked facility list. */
export interface CommandView {
  facilitiesMonitored: number;
  totalHotspots: number;
  newAnomalies: number;
  highRisk: number;
  critical: number;
  unidentifiedSources: number;
  priorityList: CommandFacility[];
}

export interface CommandFacility {
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
  classification: string;
  classificationLabel: string;
  detectionCount: number;
  latestFrp: number | null;
}

/** Chat message for the chatbot UI. */
export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  provider?: "openrouter" | "fallback";
  timestamp: number;
}

