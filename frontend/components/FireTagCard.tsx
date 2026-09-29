"use client";

/**
 * FireTagCard — the Predicted Fire Type card.
 *
 * The backend predicts what is actually burning (agricultural burn, forest
 * fire, campfire, industrial incident, refinery fire, waste burning …) from
 * fire physics + environment + weather + brightness. This component is
 * presentation-only: it renders the prediction chip, its confidence, and the
 * evidence lines verbatim. Unknown/absent tags render an honest quiet state —
 * never a fabricated category.
 *
 * Three presentations:
 *  - FireTagChip   — inline chip (headers, comparison rows).
 *  - FireTagFocus  — compact "focus" panel for directly under the Risk
 *                    score: the prediction is the visual priority there,
 *                    but styling stays inside the dashboard theme (status
 *                    colour + hairline border, no foreign chrome).
 *  - default card  — full evidence list for the facility page's right rail.
 */

import React from "react";
import { Flame, RefreshCw } from "lucide-react";
import { fireTagMeta } from "@/lib/types";

export function FireTagChip({
  tag,
  confidence,
  className = "",
}: {
  tag: string;
  confidence?: number;
  className?: string;
}) {
  const meta = fireTagMeta(tag);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${className}`}
      style={{ backgroundColor: `${meta.hex}22`, color: meta.hex }}
      title={meta.blurb}
    >
      <Flame size={10} aria-hidden />
      {meta.label}
      {typeof confidence === "number" && confidence > 0 && (
        <span className="font-mono text-[10px] font-medium opacity-80">
          {Math.round(confidence * 100)}%
        </span>
      )}
    </span>
  );
}

/**
 * FireTagFocus — compact prediction panel that sits directly below the
 * Risk-Score ring. The tag colour (not a new card style) carries the
 * identity, so it reads as part of the existing theme while standing out
 * as the "what is actually burning" callout.
 */
export function FireTagFocus({
  tag,
  confidence,
  reasons,
  provenance,
  onOpenFull,
}: {
  tag: string | undefined | null;
  confidence?: number;
  /** top evidence lines (1–2 shown; the full list lives on the page) */
  reasons?: string[];
  /** "ml_observations" = env-enriched; anything else = physics-only fallback */
  provenance?: string;
  /** open the full facility page where the complete card lives */
  onOpenFull?: () => void;
}) {
  const meta = fireTagMeta(tag);
  const enriched = provenance === "ml_observations";
  const unknown = !tag || tag === "unknown";

  return (
    <section
      className="relative overflow-hidden rounded-xl border p-4"
      style={{
        borderColor: `${meta.hex}55`,
        background: `linear-gradient(135deg, ${meta.hex}14 0%, rgba(255,255,255,0.02) 60%)`,
      }}
      aria-label="Predicted fire type"
    >
      <div className="flex items-center gap-3">
        <span
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${meta.hex}26`, color: meta.hex }}
        >
          <Flame size={16} aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary">
            Predicted fire type
          </div>
          <div className="truncate font-display text-sm font-semibold" style={{ color: meta.hex }}>
            {meta.label}
            {typeof confidence === "number" && confidence > 0 && (
              <span className="ml-2 font-mono text-[11px] font-medium text-text-secondary">
                {Math.round(confidence * 100)}%
              </span>
            )}
          </div>
        </div>
        <span
          className="ml-auto flex-shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
          style={{
            backgroundColor: enriched ? "rgba(79,179,179,0.14)" : "rgba(255,255,255,0.05)",
            color: enriched ? "#4FB3B3" : "#78808C",
          }}
          title={
            enriched
              ? "Prediction uses live environment + weather data (land cover, surroundings, climate)"
              : "ML environment unavailable — predicted from fire physics only"
          }
        >
          {enriched ? "env-aware" : "fire physics"}
        </span>
      </div>

      {!unknown && reasons && reasons.length > 0 && (
        <ul className="mt-2.5 space-y-1">
          {reasons.slice(0, 2).map((r, i) => (
            <li key={i} className="flex items-start gap-1.5 text-[11px] leading-snug text-text-secondary">
              <span
                aria-hidden
                className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full"
                style={{ backgroundColor: meta.hex }}
              />
              <span className="min-w-0">{r}</span>
            </li>
          ))}
        </ul>
      )}

      {unknown && (
        <p className="mt-2 text-[11px] leading-snug text-text-tertiary">{meta.blurb}</p>
      )}

      {onOpenFull && (
        <button
          type="button"
          onClick={onOpenFull}
          className="mt-2.5 flex items-center gap-1 text-[10px] font-medium text-text-tertiary transition-colors duration-150 hover:text-text-primary"
        >
          <RefreshCw size={9} aria-hidden className="rotate-90" />
          Full evidence on facility page
        </button>
      )}
    </section>
  );
}

export default function FireTagCard({
  tag,
  confidence,
  reasons,
  provenance,
  compact = false,
}: {
  tag: string | undefined | null;
  confidence?: number;
  reasons?: string[];
  /** "ml_observations" = environment-enriched; anything else = physics-only fallback */
  provenance?: string;
  compact?: boolean;
}) {
  const meta = fireTagMeta(tag);
  const enriched = provenance === "ml_observations";

  return (
    <section className="dash-card rounded-xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-sm font-semibold text-text-primary">
          Predicted fire type
        </h3>
        <span
          className="rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
          style={{
            backgroundColor: enriched ? "rgba(79,179,179,0.14)" : "rgba(255,255,255,0.05)",
            color: enriched ? "#4FB3B3" : "#78808C",
          }}
          title={
            enriched
              ? "Prediction uses live environment data (land cover + surroundings + weather)"
              : "ML environment unavailable — predicted from fire physics only"
          }
        >
          {enriched ? "env-aware" : "fire physics"}
        </span>
      </div>

      <div className="mt-3 flex items-center gap-2.5">
        <FireTagChip tag={tag ?? "unknown"} />
        {typeof confidence === "number" && confidence > 0 && (
          <div className="min-w-0">
            <div className="font-mono text-xs text-text-primary">
              {Math.round(confidence * 100)}% confidence
            </div>
          </div>
        )}
      </div>

      {!compact && reasons && reasons.length > 0 && (
        <ul className="mt-3 space-y-1">
          {reasons.slice(0, 6).map((r, i) => (
            <li
              key={i}
              className="flex items-start gap-1.5 text-[11px] leading-snug text-text-secondary"
            >
              <span
                aria-hidden
                className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full"
                style={{ backgroundColor: meta.hex }}
              />
              {r}
            </li>
          ))}
        </ul>
      )}

      {(!reasons || reasons.length === 0) && (
        <p className="mt-2 text-[11px] leading-snug text-text-tertiary">{meta.blurb}</p>
      )}
    </section>
  );
}
