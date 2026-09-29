"use client";

/**
 * Hotspot Classifier (formerly "Predict") — classify any point on Earth.
 *
 * Two ways in:
 *  1. Type coordinates; the ML service engineers the full 43-feature vector
 *     server-side (auto mode) and classifies the point.
 *  2. Don't know exact coordinates? Nearby FIRMS detections (50 km radius)
 *     are offered as one-click fills — pick a live hotspot and classify it.
 *
 * Real-time mode: a valid coordinate pair auto-classifies (debounced). A
 * stale-response guard (monotonic request id) keeps the rendered result
 * equal to the latest submitted coordinates.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  Crosshair,
  FileWarning,
  Loader2,
  MapPin,
  RotateCcw,
  Satellite,
} from "lucide-react";
import clsx from "clsx";
import {
  MODEL_CLASSES,
  MODEL_CLASS_COLORS,
  MODEL_CLASS_LABELS,
  postPredict,
  type ModelClass,
  type PredictionResponseDto,
} from "@/lib/mlApi";
import {
  FEATURE_LABELS,
  contributionDeviationFor,
  formatFeatureValue,
  featureLabel,
} from "@/lib/features";
import { useFirms } from "@/lib/hooks";
import { INDIA_BBOX } from "@/lib/regions";
import { haversineKm } from "@/lib/geo";
import type { FirmsHotspot } from "@/lib/firms";
import PyroLoader from "@/components/PyroLoader";

/** Nearby-detection search radius in km (user-confirmed choice). */
const NEARBY_RADIUS_KM = 50;

/**
 * One coordinate box — "lat, lng" in a single field (latitude and longitude
 * are the only required inputs). Latitude first, strict validation, and a
 * live preview of the parsed pair.
 */
function CoordinatesField({
  value,
  onChange,
  error,
  parsed,
}: {
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  parsed: { lat: number; lng: number } | null;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-text-tertiary">
          Coordinates
          <span className="ml-1 text-status-suspicious">*</span>
        </span>
        <span className="text-[10px] text-text-tertiary">latitude, longitude</span>
      </div>
      <div
        className={clsx(
          "mt-1.5 flex items-center rounded-lg border bg-white/[0.03] transition-colors duration-150",
          error ? "border-status-critical" : "border-white/[0.08] focus-within:border-accent-primary",
        )}
      >
        <MapPin size={14} className="ml-3 flex-shrink-0 text-text-tertiary" />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="30.7333, 76.7794"
          aria-label="Coordinates as latitude, longitude"
          aria-invalid={!!error}
          autoComplete="off"
          spellCheck={false}
          className="w-full bg-transparent px-2.5 py-2 font-mono text-sm text-text-primary outline-none placeholder:text-text-tertiary"
        />
      </div>
      {error ? (
        <span className="mt-1 block text-[11px] text-status-critical">{error}</span>
      ) : parsed ? (
        <span className="mt-1 block font-mono text-[11px] text-text-tertiary">
          {parsed.lat.toFixed(4)}°, {parsed.lng.toFixed(4)}° - classifying automatically…
        </span>
      ) : null}
    </div>
  );
}

/** One nearby live detection — click to fill the coordinate box. */
function NearbyHotspot({
  h,
  distKm,
  onPick,
}: {
  h: FirmsHotspot;
  /** km from the entered point; null = discovery list (no point entered) */
  distKm: number | null;
  onPick: (lat: number, lng: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(h.latitude, h.longitude)}
      className="map-glass group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-all duration-200 hover:-translate-y-px"
    >
      <Satellite size={12} className="flex-shrink-0 text-accent-secondary" />
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-[11px] text-text-primary">
          {h.latitude.toFixed(3)}°, {h.longitude.toFixed(3)}°
        </span>
        <span className="block text-[10px] text-text-tertiary">
          {h.acqDate} · FRP {h.frp.toFixed(1)} MW · {h.confidence.trim() || "n/a"} confidence
        </span>
      </span>
      <span className="flex-shrink-0 rounded-full bg-white/[0.05] px-2 py-0.5 font-mono text-[10px] text-text-secondary">
        {distKm == null ? `FRP ${h.frp.toFixed(0)} MW` : `${distKm.toFixed(1)} km`}
      </span>
    </button>
  );
}

/** Probability bar row — per-class share of the model's belief. */
function ProbabilityBar({
  cls,
  probability,
  winner,
}: {
  cls: ModelClass;
  probability: number;
  winner: boolean;
}) {
  const hex = MODEL_CLASS_COLORS[cls];
  const pct = Math.round(probability * 1000) / 10;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className={clsx("text-xs", winner ? "font-semibold text-text-primary" : "text-text-secondary")}>
          {MODEL_CLASS_LABELS[cls]}
          {winner && (
            <span
              className="ml-1.5 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
              style={{ backgroundColor: `${hex}26`, color: hex }}
            >
              predicted
            </span>
          )}
        </span>
        <span className={clsx("font-mono text-xs", winner ? "font-semibold text-text-primary" : "text-text-secondary")}>
          {pct.toFixed(1)}%
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%`, backgroundColor: hex }}
        />
      </div>
    </div>
  );
}

/**
 * Confidence distribution — a single stacked bar of the class probabilities,
 * exactly as the backend returned them. The winning segment is outlined.
 */
function ConfidenceDistribution({
  probabilities,
  predictedClass,
}: {
  probabilities: PredictionResponseDto["probabilities"];
  predictedClass: ModelClass;
}) {
  const total = MODEL_CLASSES.reduce((a, c) => a + (probabilities[c] ?? 0), 0);
  if (total <= 0) return null; // empty payload → no invented bar
  return (
    <div className="mt-6">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary">
          Model belief distribution
        </span>
        <span className="font-mono text-[10px] text-text-tertiary">Σ 100%</span>
      </div>
      <div
        className="mt-1.5 flex h-3 w-full overflow-hidden rounded-full bg-white/[0.06]"
        role="img"
        aria-label={MODEL_CLASSES.map(
          (c) => `${MODEL_CLASS_LABELS[c]} ${((probabilities[c] ?? 0) * 100).toFixed(1)}%`,
        ).join(", ")}
      >
        {MODEL_CLASSES.map((c) => {
          const p = probabilities[c] ?? 0;
          if (p <= 0) return null;
          const winner = c === predictedClass;
          return (
            <div
              key={c}
              className="h-full transition-all duration-500"
              style={{
                width: `${(p / total) * 100}%`,
                backgroundColor: MODEL_CLASS_COLORS[c],
                outline: winner ? "1.5px solid #E6EBF2" : undefined,
                outlineOffset: winner ? "-1.5px" : undefined,
              }}
              title={`${MODEL_CLASS_LABELS[c]} - ${(p * 100).toFixed(1)}%${winner ? " (predicted)" : ""}`}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * Explainability panel — one row per top_contributing_features entry.
 * Contribution = importance × deviation vs the training median, re-derived
 * for display only, never fed back into anything.
 */
function ExplainabilityCard({
  features,
}: {
  features: PredictionResponseDto["top_contributing_features"];
}) {
  if (features.length === 0) {
    return (
      <div className="dash-card rounded-xl p-5">
        <h3 className="font-display text-sm font-semibold text-text-primary">
          Why this prediction
        </h3>
        <p className="mt-2 rounded-lg border border-border-hairline bg-white/[0.02] px-3 py-2 text-xs leading-relaxed text-text-secondary">
          No feature contributions were returned for this prediction - the model
          could not attribute this result to specific inputs.
        </p>
      </div>
    );
  }

  const withScore = [...features]
    .map((f) => ({
      ...f,
      contribution: f.importance * contributionDeviationFor(f.feature, f.value),
    }))
    .sort((a, b) => b.contribution - a.contribution);
  const sum = withScore.reduce((a, f) => a + f.contribution, 0) || 1;

  return (
    <div className="dash-card rounded-xl p-5">
      <h3 className="font-display text-sm font-semibold text-text-primary">
        Why this prediction
      </h3>
      <p className="mt-1 text-[11px] leading-relaxed text-text-tertiary">
        Ranked by contribution = feature importance × deviation from the
        training median (computed by the ML service, displayed verbatim).
      </p>
      <ul className="mt-4 space-y-3">
        {withScore.map((f, i) => {
          const share = Math.max(2, (f.contribution / sum) * 100);
          return (
            <li key={f.feature}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-body text-xs text-text-primary">
                  <span className="mr-1.5 font-mono text-[10px] text-text-tertiary">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {FEATURE_LABELS[f.feature] ?? featureLabel(f.feature)}
                </span>
                <span className="flex-shrink-0 font-mono text-[11px] text-text-secondary">
                  {typeof f.value === "number" ? formatFeatureValue(f.value) : f.value}
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className="h-full rounded-full bg-accent-violet transition-all duration-500"
                    style={{ width: `${Math.min(100, share)}%` }}
                  />
                </div>
                <span
                  className="w-24 flex-shrink-0 text-right font-mono text-[10px] text-text-tertiary"
                  title={`importance ${f.importance.toFixed(4)} × deviation ${contributionDeviationFor(f.feature, f.value).toFixed(2)}`}
                >
                  contribution {f.contribution.toFixed(2)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Small mono readout (matches the facility pages' MonoStat style). */
function MonoStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary">{label}</div>
      <div className="mt-0.5 truncate font-mono text-xs text-text-primary">{value}</div>
    </div>
  );
}

export default function PredictPage() {
  // ── form state: one coordinate box + optional region tag ────────────────
  const [coords, setCoords] = useState("");
  const [region, setRegion] = useState("india");

  // ── request lifecycle: idle | submitting | done | error ─────────────────
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PredictionResponseDto | null>(null);
  // Monotonic request id — only the newest request may render a result.
  const requestSeq = React.useRef(0);

  /** Parse "lat, lng" (comma or whitespace separated, both signed). */
  const parsed = useMemo<{ lat: number; lng: number } | null>(() => {
    const m = coords.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;
    return { lat, lng };
  }, [coords]);

  const validationError = useMemo(() => {
    if (coords.trim() === "") return null; // idle state, not an error
    if (!parsed) return "Enter latitude, longitude (e.g. 30.7333, 76.7794).";
    return null;
  }, [coords, parsed]);

  const runPredict = useCallback(
    async (lat: number, lng: number) => {
      const seq = ++requestSeq.current;
      setSubmitting(true);
      setError(null);
      try {
        const r = await postPredict(lat, lng, region || undefined);
        if (seq === requestSeq.current) setResult(r);
      } catch (err) {
        if (seq === requestSeq.current) {
          setError(err instanceof Error ? err.message : "Prediction request failed.");
          setResult(null);
        }
      } finally {
        if (seq === requestSeq.current) setSubmitting(false);
      }
    },
    [region],
  );

  // ── real time: valid coordinates auto-classify (debounced 700 ms) ──────
  useEffect(() => {
    if (!parsed) return;
    const t = setTimeout(() => void runPredict(parsed.lat, parsed.lng), 700);
    return () => clearTimeout(t);
  }, [parsed, runPredict]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (parsed) void runPredict(parsed.lat, parsed.lng);
    },
    [parsed, runPredict],
  );

  const reset = useCallback(() => {
    requestSeq.current += 1; // invalidate any in-flight auto-classify
    setSubmitting(false);
    setResult(null);
    setError(null);
  }, []);

  /**
   * Live FIRMS detections offered as one-click coordinate fills.
   * Visible BEFORE typing too — the "I don't know coordinates" path should
   * not require already knowing a point. Near an entered point: within
   * NEARBY_RADIUS_KM, closest first. Nothing typed: the strongest live
   * detections right now (highest FRP) as a discovery list.
   */
  const { hotspots } = useFirms([INDIA_BBOX]);
  const nearby = useMemo(() => {
    if (!parsed) {
      // No coordinates yet → show the strongest live detections (discovery).
      return [...hotspots]
        .sort((a, b) => b.frp - a.frp)
        .slice(0, 6)
        .map((h) => ({ h, distKm: null as number | null }));
    }
    return hotspots
      .map((h) => ({
        h,
        distKm: haversineKm(parsed.lat, parsed.lng, h.latitude, h.longitude) as number | null,
      }))
      .filter((x) => x.distKm != null && x.distKm <= NEARBY_RADIUS_KM)
      .sort((a, b) => (a.distKm ?? 0) - (b.distKm ?? 0))
      .slice(0, 6);
  }, [parsed, hotspots]);

  return (
    <div className="pyro-scroll h-full overflow-y-auto bg-gradient-mesh">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-6 p-6 pb-20">
        <header className="pt-4 dash-section" style={{ animationDelay: "0.05s" }}>
          <h1 className="font-display text-2xl font-semibold text-text-primary">
            Hotspot Classifier
          </h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-text-secondary">
            Submit any location and the ML service engineers the full model
            feature vector - detection persistence, FRP statistics, distances to
            infrastructure, land cover, weather - then classifies it with a
            grounded explanation. Exact coordinates aren&apos;t required: live
            detections near your point are offered below the input.
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-[420px_1fr]">
          {/* ── input column ─────────────────────────────────────────── */}
          <div className="flex flex-col gap-4">
            <section className="dash-card rounded-xl p-5 dash-section" style={{ animationDelay: "0.1s" }}>
              <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-text-secondary">
                Point input
              </h2>
              <form className="mt-4 flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
                <CoordinatesField
                  value={coords}
                  onChange={(v) => {
                    setCoords(v);
                    setError(null);
                  }}
                  error={validationError}
                  parsed={parsed}
                />
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-widest text-text-tertiary">
                    Region tag
                  </span>
                  <select
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-text-primary outline-none transition-colors duration-150 focus:border-accent-primary"
                  >
                    <option value="india">India</option>
                    <option value="global">Global</option>
                  </select>
                </label>

                <div className="flex items-center gap-2">
                  <button
                    type="submit"
                    disabled={!parsed || submitting}
                    className={clsx(
                      "flex flex-1 items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-medium transition-colors duration-150",
                      parsed && !submitting
                        ? "bg-accent-primary/20 text-accent-primary ring-1 ring-accent-primary/40 hover:bg-accent-primary/30"
                        : "cursor-not-allowed bg-white/[0.04] text-text-tertiary",
                    )}
                  >
                    {submitting ? (
                      <>
                        <Loader2 size={15} className="animate-spin" />
                        Classifying…
                      </>
                    ) : (
                      <>
                        <Crosshair size={15} />
                        Classify hotspot
                      </>
                    )}
                  </button>
                  <Link
                    href="/map"
                    title="Open the Hotspot Map to pick a location"
                    className="flex h-[42px] w-[42px] items-center justify-center rounded-lg border border-white/[0.08] text-text-secondary transition-colors duration-150 hover:border-border-strong hover:text-text-primary"
                  >
                    <MapPin size={15} />
                  </Link>
                </div>
                <p className="text-[11px] leading-relaxed text-text-tertiary">
                  Only coordinates are collected - the other features are derived
                  from FIRMS history, OSM, land cover, and weather archives for
                  that exact point. Classification starts automatically as you
                  type; first run for a fresh area takes a few seconds while
                  external sources are queried, repeats come from cache.
                </p>
              </form>
            </section>

            {/* live detections - the "I don't know exact coords" path.
                Always visible: before typing it shows the strongest live
                hotspots right now; after typing, those within 50 km. */}
            <section className="dash-card rounded-xl p-5 dash-section" style={{ animationDelay: "0.15s" }}>
              <div className="flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold text-text-primary">
                  {parsed ? "Live detections nearby" : "Strongest live hotspots now"}
                </h2>
                <span className="rounded-full bg-white/[0.05] px-2 py-0.5 font-mono text-[10px] text-text-secondary">
                  {parsed ? `within ${NEARBY_RADIUS_KM} km` : "pick to classify"}
                </span>
              </div>
              {nearby.length === 0 ? (
                <p className="mt-3 text-xs leading-relaxed text-text-tertiary">
                  No live FIRMS detections within {NEARBY_RADIUS_KM} km of this
                  point in the current 10-day window. The classifier still
                  works - it evaluates the point&apos;s environment and fire
                  history regardless.
                </p>
              ) : (
                <>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-text-tertiary">
                    {parsed
                      ? "Not sure of the exact coordinates? Pick a live detection to fill them in."
                      : "No coordinates needed to start - pick any live hotspot and it fills the box and classifies."}
                  </p>
                  <div className="mt-3 flex flex-col gap-2">
                    {nearby.map(({ h, distKm }) => (
                      <NearbyHotspot
                        key={`${h.latitude},${h.longitude}`}
                        h={h}
                        distKm={distKm}
                        onPick={(lat, lng) => setCoords(`${lat.toFixed(4)}, ${lng.toFixed(4)}`)}
                      />
                    ))}
                  </div>
                </>
              )}
            </section>
          </div>

          {/* ── result view ──────────────────────────────────────────── */}
          <section aria-live="polite" className="min-w-0">
            {submitting && (
              <div className="flex h-full min-h-[420px] items-center justify-center rounded-xl dash-card">
                <PyroLoader
                  label="Engineering features & running the model"
                  sub="Querying FIRMS history, OSM infrastructure, land cover, and weather for this exact point"
                />
              </div>
            )}

            {!submitting && error && (
              <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-3 rounded-xl dash-card p-8">
                <AlertTriangle size={22} className="text-status-suspicious" />
                <p className="text-sm font-medium text-text-primary">
                  Classification failed
                </p>
                <p className="max-w-md break-words text-center text-xs leading-relaxed text-text-secondary">
                  {error}
                </p>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  className="mt-1 rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-text-secondary transition-colors duration-150 hover:border-border-strong hover:text-text-primary"
                >
                  Dismiss
                </button>
              </div>
            )}

            {!submitting && !error && !result && (
              <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/[0.09] bg-white/[0.015] p-8 text-center">
                <Crosshair size={20} className="text-text-tertiary" />
                <p className="text-sm text-text-secondary">
                  No classification yet
                </p>
                <p className="max-w-sm text-xs leading-relaxed text-text-tertiary">
                  Type coordinates of a FIRMS hotspot (or any point of interest) -
                  latitude, longitude - and the classifier runs automatically.
                  The result appears here with per-class probabilities, key
                  drivers, and a grounded explanation.
                </p>
              </div>
            )}

            {!submitting && !error && result && (
              <div className="flex flex-col gap-5 animation-fade-in">
                {/* warnings - honest degradation notices */}
                {result.warnings.length > 0 && (
                  <div className="dash-card rounded-xl p-4">
                    <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-status-watch">
                      <FileWarning size={12} />
                      Feature warnings
                    </h3>
                    <ul className="mt-2 space-y-1">
                      {result.warnings.map((w, i) => (
                        <li key={i} className="text-xs leading-relaxed text-text-secondary">
                          · {w}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* headline: predicted category + confidence + risk */}
                <div className="dash-card rounded-xl p-6">
                  <div className="flex flex-wrap items-start justify-between gap-6">
                    <div className="min-w-0">
                      <div className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary">
                        Predicted Hotspot Category
                      </div>
                      <div
                        className="mt-1.5 font-display text-2xl font-semibold leading-tight"
                        style={{ color: MODEL_CLASS_COLORS[result.class] }}
                      >
                        {MODEL_CLASS_LABELS[result.class]}
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-text-tertiary">
                        {result.class}
                      </div>
                    </div>
                    <div className="flex gap-8">
                      <div className="flex flex-col items-center">
                        <span className="font-display text-3xl font-semibold text-text-primary">
                          {(result.confidence * 100).toFixed(1)}
                          <span className="ml-0.5 text-sm text-text-tertiary">%</span>
                        </span>
                        <span className="mt-1 text-[10px] uppercase tracking-wider text-text-tertiary">
                          Confidence
                        </span>
                      </div>
                      <div className="flex flex-col items-center">
                        {result.risk_score == null ? (
                          <>
                            <span className="font-display text-3xl font-semibold text-text-tertiary">
                              -
                            </span>
                            <span className="mt-1 text-[10px] uppercase tracking-wider text-text-tertiary">
                              Risk score
                            </span>
                            <span className="mt-0.5 text-[9px] leading-tight text-text-tertiary">
                              legacy build - unavailable
                            </span>
                          </>
                        ) : (
                          <>
                            <span
                              className="font-display text-3xl font-semibold"
                              style={{
                                color:
                                  result.risk_score >= 66
                                    ? "#E06060"
                                    : result.risk_score >= 33
                                      ? "#E0A84C"
                                      : "#4ECBA0",
                              }}
                            >
                              {result.risk_score.toFixed(1)}
                            </span>
                            <span className="mt-1 text-[10px] uppercase tracking-wider text-text-tertiary">
                              Risk Score
                            </span>
                            <span className="mt-0.5 text-[9px] leading-tight text-text-tertiary">
                              higher = more risk
                            </span>
                            <span
                              className="mt-1 max-w-[140px] text-center text-[9px] leading-tight text-text-tertiary"
                              title="Hotspot scope: based on classification + temporal signals only — no registered facility history at this point."
                            >
                              based on classification + temporal signals only —
                              no registered facility history at this point
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <ConfidenceDistribution probabilities={result.probabilities} predictedClass={result.class} />
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {MODEL_CLASSES.map((cls) => (
                      <ProbabilityBar
                        key={cls}
                        cls={cls}
                        probability={result.probabilities[cls] ?? 0}
                        winner={cls === result.class}
                      />
                    ))}
                  </div>

                  <p className="mt-4 border-t border-white/[0.06] pt-3 text-[11px] leading-relaxed text-text-tertiary">
                    This category is the trained model&apos;s supervised
                    classification of the hotspot - distinct from the
                    rule-based Risk Status (Normal / Watch / Suspicious /
                    Critical) shown on facility pages.
                  </p>
                </div>

                {/* explanation - near the category, not buried */}
                <div className="dash-card rounded-xl p-5">
                  <h3 className="flex items-center gap-2 font-display text-sm font-semibold text-text-primary">
                    Why this classification
                    <span
                      className={clsx(
                        "rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
                        result.explanation_provenance === "template"
                          ? "bg-white/[0.05] text-text-tertiary"
                          : "bg-accent-secondary/15 text-accent-secondary",
                      )}
                    >
                      {result.explanation_provenance === "template"
                        ? "templated"
                        : "grounded GenAI"}
                    </span>
                  </h3>
                  <p className="mt-2.5 whitespace-pre-line text-sm leading-relaxed text-text-secondary">
                    {result.explanation}
                  </p>
                </div>

                {/* key drivers - explainability with real contribution bars */}
                <ExplainabilityCard features={result.top_contributing_features} />

                {/* analyzed location + input summary + timestamp */}
                <div className="dash-card rounded-xl p-5">
                  <h3 className="flex items-center gap-1.5 font-display text-sm font-semibold text-text-primary">
                    <Satellite size={14} className="text-accent-secondary" />
                    Analysis record
                  </h3>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <MonoStat label="Analyzed location" value={`${result.latitude.toFixed(4)}°, ${result.longitude.toFixed(4)}°`} />
                    <MonoStat label="Hotspot ID" value={result.hotspot_id} />
                    <MonoStat
                      label="Timestamp (UTC)"
                      value={new Date(result.prediction_timestamp).toISOString().replace("T", " ").slice(0, 19)}
                    />
                    <MonoStat label="Model version" value={result.model_version} />
                    <MonoStat label="Dataset version" value={result.dataset_version} />
                    <MonoStat label="Schema version" value={result.feature_schema_version} />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {Object.entries(result.feature_provenance).map(([block, src]) => (
                      <span
                        key={block}
                        className={clsx(
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                          src === "median_fallback"
                            ? "bg-status-watch/15 text-status-watch"
                            : "bg-white/[0.04] text-text-secondary",
                        )}
                      >
                        <CheckCircle2 size={9} aria-hidden />
                        {block}: {src}
                      </span>
                    ))}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Link
                      href={`/map?lat=${result.latitude}&lng=${result.longitude}&zoom=12`}
                      className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs text-text-secondary transition-colors duration-150 hover:border-border-strong hover:text-text-primary"
                    >
                      <MapPin size={12} />
                      Inspect on Hotspot Map
                    </Link>
                    <button
                      type="button"
                      onClick={reset}
                      className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs text-text-secondary transition-colors duration-150 hover:border-border-strong hover:text-text-primary"
                    >
                      <RotateCcw size={12} />
                      Clear result
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
