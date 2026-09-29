"use client";

import React from "react";
import { MousePointerClick, Satellite } from "lucide-react";
import {
  FacilityAnalysis,
  RiskStatus,
  STATUS_META,
  statusColorHex,
} from "@/lib/types";
import { FirmsHotspot, frpColor } from "@/lib/firms";
import { StatusGlyph } from "@/lib/status";
import clsx from "clsx";

/**
 * Shared rich hover card for map markers (facility + FIRMS hotspot).
 *
 * Rendered INSIDE react-leaflet <Tooltip>, so the outer positioning,
 * opacity and the CSS class for the clickable affordance are applied by the
 * parent — this component only supplies readable, well-structured content.
 */

/** Small label/value row — mono value, muted label, no truncation. */
function Row({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className={clsx("flex items-baseline justify-between gap-4", className)}>
      <span className="font-body text-[11px] leading-tight text-text-secondary">{label}</span>
      <span className="font-mono text-[11px] font-medium leading-tight text-text-primary">{value}</span>
    </div>
  );
}

/** Bottom affordance bar shared by both card types. */
export function TooltipActionHint({
  label,
  tone = "blue",
}: {
  label: string;
  tone?: "blue" | "cyan";
}) {
  return (
    <div
      className={clsx(
        "mt-2.5 flex items-center justify-center gap-1.5 border-t pt-2 text-[10px] font-medium uppercase tracking-wider",
        "border-border-hairline",
        tone === "cyan" ? "text-accent-secondary" : "text-accent-primary",
      )}
    >
      <MousePointerClick size={11} aria-hidden />
      {label}
    </div>
  );
}

/** Status pill: shape glyph + tag + label, tinted with the status colour. */
export function TooltipStatusPill({ status }: { status: RiskStatus }) {
  const hex = statusColorHex(status);
  const meta = STATUS_META[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-body text-[10px] font-semibold uppercase tracking-wider"
      style={{ backgroundColor: `${hex}26`, color: hex }}
    >
      <StatusGlyph status={status} size={7} />
      {meta.label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Facility hover card                                                 */
/* ------------------------------------------------------------------ */

export function FacilityTooltipContent({
  analysis,
}: {
  analysis: FacilityAnalysis;
}) {
  const { facility, status, riskScore, latestFrp, nearestKm, detectionCount } = analysis;
  const hex = statusColorHex(status);

  return (
    <div className="min-w-[240px] select-none">
      {/* header - name + type/OSM id */}
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <div className="font-display text-[13px] font-semibold leading-snug text-text-primary">
            {facility.name}
          </div>
          <div className="mt-0.5 font-body text-[10px] uppercase tracking-wider text-text-tertiary">
            {facility.type} · OSM {facility.id.replace("osm-", "")}
          </div>
        </div>
        {/* status pill top-right; coloured ring echoes the marker */}
        <div className="ml-auto flex-shrink-0" style={{ color: hex }}>
          <TooltipStatusPill status={status} />
        </div>
      </div>

      {/* score + key signal stats in a tinted strip - readable on any basemap */}
      <div
        className="mt-2.5 rounded-lg border border-border-hairline px-2.5 py-2"
        style={{ backgroundColor: "rgba(5, 7, 10, 0.55)" }}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="font-body text-[10px] font-semibold uppercase tracking-widest text-text-tertiary">
            Risk Score
          </span>
          <span className="font-mono text-sm font-bold" style={{ color: hex }}>
            {riskScore}
            <span className="text-text-tertiary">/100</span>
          </span>
        </div>
        <div className="mt-1.5 space-y-1">
          <Row
            label="Detections (10d)"
            value={detectionCount > 0 ? `${detectionCount}` : "none"}
          />
          <Row label="Latest FRP" value={latestFrp != null ? `${latestFrp.toFixed(1)} MW` : "-"} />
          <Row
            label="Nearest detection"
            value={nearestKm != null ? `${nearestKm.toFixed(1)} km` : "-"}
          />
          <Row
            label="Coordinates"
            value={`${facility.lat.toFixed(2)}°, ${facility.lng.toFixed(2)}°`}
          />
        </div>
      </div>

      <TooltipActionHint label="Click to open analysis" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* FIRMS hotspot hover card                                            */
/* ------------------------------------------------------------------ */

/** 0–9 days ago → compact relative label. */
function ageLabel(ageDays: number): string {
  if (ageDays <= 0) return "today";
  if (ageDays === 1) return "yesterday";
  return `${ageDays}d ago`;
}

export function FirmsTooltipContent({
  latitude,
  longitude,
  frp,
  brightness,
  confidence,
  satellite,
  instrument,
  acqDate,
  acqTime,
  daynight,
  ageDays,
}: {
  latitude: number;
  longitude: number;
  frp: number;
  brightness: number;
  confidence: string;
  satellite: string;
  instrument: string;
  acqDate: string;
  acqTime: string;
  daynight: "D" | "N";
  ageDays: number;
}) {
  const t = acqTime.padStart(4, "0");
  const conf = confidence.trim() || "n/a";
  return (
    <div className="min-w-[220px] select-none">
      <div className="flex items-center gap-2">
        <Satellite size={13} className="flex-shrink-0 text-accent-secondary" aria-hidden />
        <span className="font-display text-[13px] font-semibold leading-tight text-text-primary">
          Thermal hotspot
        </span>
        {ageDays >= 0 && (
          <span className="ml-auto rounded-full border border-border-hairline bg-bg-inset px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-wider text-text-secondary">
            {ageLabel(ageDays)}
          </span>
        )}
      </div>

      <div
        className="mt-2 rounded-lg border border-border-hairline px-2.5 py-2"
        style={{ backgroundColor: "rgba(5, 7, 10, 0.55)" }}
      >
        <div className="space-y-1">
          <Row label="Fire radiative power" value={`${frp.toFixed(1)} MW`} />
          <Row label="Brightness (I4)" value={`${brightness.toFixed(1)} K`} />
          <Row label="Confidence" value={conf.toUpperCase()} />
          <Row label="Source" value={`${satellite} ${instrument}`.trim() || "VIIRS"} />
          <Row
            label="Acquired (UTC)"
            value={`${acqDate} ${t.slice(0, 2)}:${t.slice(2, 4)} · ${daynight === "D" ? "day" : "night"}`}
          />
          <Row
            label="Coordinates"
            value={`${latitude.toFixed(3)}°, ${longitude.toFixed(3)}°`}
          />
        </div>
      </div>

      <TooltipActionHint label="Click to select & view details" tone="cyan" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* FIRMS hotspot slide-over study card                                 */
/* ------------------------------------------------------------------ */

/**
 * Deep-dive card for a pinned FIRMS hotspot (map page slide-over). Explains
 * what each sensor quantity means and how the corroboration radius is used,
 * so the detection's pattern can actually be studied.
 */
export function FirmsHotspotDetail({ hotspot }: { hotspot: FirmsHotspot }) {
  const hex = frpColor(hotspot.frp);
  const conf = hotspot.confidence.trim() || "n/a";
  const rows: [string, string][] = [
    ["Fire radiative power", `${hotspot.frp.toFixed(1)} MW`],
    ["Brightness (I-band)", `${hotspot.brightness.toFixed(1)} K`],
    ["Confidence", conf.toUpperCase()],
    ["Coordinates", `${hotspot.latitude.toFixed(4)}°, ${hotspot.longitude.toFixed(4)}°`],
  ];
  return (
    <section className="dash-card rounded-xl p-4">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: hex }} />
        <span className="font-display text-sm font-semibold text-text-primary">
          Detection metrics
        </span>
        <span
          className="ml-auto rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider"
          style={{ borderColor: `${hex}66`, color: hex }}
        >
          {hotspot.ageDays === 0 ? "Today" : hotspot.ageDays === 1 ? "Yesterday" : `${hotspot.ageDays} days ago`}
        </span>
      </div>
      <div className="mt-3 grid gap-1.5">
        {rows.map(([label, value]) => (
          <Row key={label} label={label} value={value} />
        ))}
        <Row
          label="Acquired (UTC)"
          value={`${hotspot.acqDate} ${hotspot.acqTime.padStart(4, "0").slice(0, 2)}:${hotspot.acqTime.padStart(4, "0").slice(2, 4)} · ${hotspot.daynight === "D" ? "day" : "night"} pass`}
        />
      </div>
      <p className="mt-3 border-t border-border-hairline pt-3 text-xs leading-relaxed text-text-secondary">
        Fire Radiative Power (FRP) measures the radiant heat output of the fire
        in megawatts - higher FRP means a larger or hotter fire. VIIRS 375 m
        imagery reports these anomalies roughly every 3 hours; a cluster of
        detections over multiple days indicates persistent activity rather
        than a one-off event.
      </p>
    </section>
  );
}
