"use client";

/**
 * Compare page (Track D) — side-by-side view of 1–3 pinned facilities.
 *
 * Every number is the backend's computed classification (same /api/analyses
 * + /api/facilities/:id/analyses endpoints the rest of the app uses); the
 * FRP trend chart is built from the facility's real stored detections (same
 * /api/firms source as the map). Risk Status here is the monitoring
 * vocabulary — never mixed with the ML Predicted Fire Type, which is shown
 * as its own chip per column.
 *
 * The pinned selection lives in lib/compare.ts (localStorage) so pins made
 * anywhere in the app (Facility Explorer cards, the map's detail panel, or a
 * facility's full page) survive the navigation here. One pin renders a
 * single column (still useful); two or three render side by side.
 */

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ReTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { GitCompareArrows, MapPin, X } from "lucide-react";
import PyroLoader from "@/components/PyroLoader";
import { useAnalyses, useFirms } from "@/lib/hooks";
import { useCompareIds, COMPARE_MAX } from "@/lib/compare";
import { INDIA_BBOX } from "@/lib/regions";
import { StatusBadge, StatusGlyph } from "@/lib/status";
import { RiskStatus, STATUS_META, fireTagMeta } from "@/lib/types";
import type { FacilityAnalysis } from "@/lib/types";
import type { WhatChangedRowDto } from "@/lib/api";
import { fetchFacilityAnalysis } from "@/lib/api";
import { haversineKm } from "@/lib/geo";
import type { FirmsHotspot } from "@/lib/firms";

const AXIS = { fill: "#96A3B5", fontSize: 11 } as const;
const GRID = "#1F2733";

const tooltipStyle = {
  backgroundColor: "rgba(12, 15, 19, 0.95)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 10,
  fontSize: 12,
  color: "#E6ECF4",
  boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
};

const COMPARE_COLORS = ["#5B9BD5", "#E0A84C", "#9186C4"];

export default function ComparePage() {
  const { ids, hydrated, remove, clear } = useCompareIds();
  const { analyses, isLoading } = useAnalyses([INDIA_BBOX]);
  const { hotspots, isLoading: firmsLoading } = useFirms([INDIA_BBOX]);

  // Per-facility narratives (What Changed) — fetched once per pinned facility.
  const [narratives, setNarratives] = useState<Record<string, WhatChangedRowDto[]>>({});
  useEffect(() => {
    let cancelled = false;
    for (const id of ids) {
      if (narratives[id]) continue;
      fetchFacilityAnalysis(id)
        .then((r) => {
          if (!cancelled) setNarratives((cur) => ({ ...cur, [id]: r.narrative.whatChanged }));
        })
        .catch(() => {
          if (!cancelled) setNarratives((cur) => ({ ...cur, [id]: [] }));
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(",")]);

  // Resolve pinned ids against the analyses list (cheap — already cached by SWR).
  const resolved = useMemo(
    () =>
      ids
        .map((id) => analyses.find((a) => a.facility.id === id))
        .filter((a): a is FacilityAnalysis => !!a),
    [ids, analyses],
  );

  // Per-facility real FRP trend (mean FRP per active day, from stored detections).
  const trends = useMemo(() => {
    const map = new Map<string, { day: string; frp: number }[]>();
    for (const a of resolved) {
      const f = a.facility;
      const near = hotspots.filter(
        (h) => haversineKm(f.lat, f.lng, h.latitude, h.longitude) <= 5,
      );
      const byDay = new Map<string, { sum: number; n: number }>();
      for (const h of near) {
        const e = byDay.get(h.acqDate) ?? { sum: 0, n: 0 };
        e.sum += h.frp;
        e.n += 1;
        byDay.set(h.acqDate, e);
      }
      map.set(
        f.id,
        [...byDay.entries()]
          .sort((x, y) => x[0].localeCompare(y[0]))
          .map(([day, v]) => ({ day: day.slice(5), frp: Math.round((v.sum / v.n) * 10) / 10 })),
      );
    }
    return map;
  }, [resolved, hotspots]);

  const chartData = useMemo(() => {
    // Merge per-facility series on the union of days.
    const days = new Set<string>();
    for (const series of trends.values()) for (const p of series) days.add(p.day);
    const sorted = [...days].sort();
    return sorted.map((day) => {
      const row: Record<string, string | number | null> = { day };
      resolved.forEach((a) => {
        const series = trends.get(a.facility.id);
        const point = series?.find((p) => p.day === day);
        row[a.facility.name] = point?.frp ?? null;
      });
      return row;
    });
  }, [resolved, trends]);

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center">
        <PyroLoader label="Loading comparison" compact />
      </div>
    );
  }

  return (
    <div className="pyro-scroll h-full overflow-y-auto bg-gradient-mesh">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-6 p-6 pb-20">
        <header className="pt-4">
          <h1 className="flex items-center gap-2.5 font-display text-2xl font-semibold text-text-primary">
            <GitCompareArrows size={20} className="text-accent-primary" />
            Facility Comparison
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-text-secondary">
            Side-by-side view of pinned facilities — Risk Scores, risk status,
            predicted fire type and real FRP behaviour. Pin facilities from the
            Facility Explorer, the Hotspot Map panel, or any facility page.
          </p>
        </header>

        {ids.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-text-tertiary">
              {ids.length}/{COMPARE_MAX} pinned
              {resolved.length < ids.length ? ` · ${resolved.length} resolved in view` : ""}
            </span>
            <button
              type="button"
              onClick={clear}
              className="text-xs font-medium text-accent-primary transition-colors duration-150 hover:text-accent-secondary"
            >
              Clear pins
            </button>
          </div>
        )}

        {isLoading && (
          <div className="flex h-40 items-center justify-center">
            <PyroLoader label="Loading classifications" compact />
          </div>
        )}

        {!isLoading && ids.length === 0 && (
          <div className="map-glass flex flex-col items-center gap-3 rounded-xl p-12 text-center">
            <GitCompareArrows size={22} className="text-text-tertiary" />
            <p className="text-sm text-text-secondary">
              Pin up to {COMPARE_MAX} facilities to compare
            </p>
            <p className="max-w-md text-xs leading-relaxed text-text-tertiary">
              Use the pin button on any Facility Explorer card, in the Hotspot
              Map&apos;s detail panel, or on a facility&apos;s full page — then
              return here for the side-by-side view.
            </p>
            <Link
              href="/facilities"
              className="mt-1 rounded-lg border border-accent-primary/30 bg-accent-primary/15 px-3 py-1.5 text-xs font-medium text-accent-primary transition-colors duration-150 hover:bg-accent-primary/25"
            >
              <MapPin size={12} className="mr-1.5 inline" />
              Go to Facility Explorer
            </Link>
          </div>
        )}

        {!isLoading && ids.length > 0 && resolved.length < ids.length && (
          <p className="map-glass rounded-lg px-3 py-2 text-xs text-text-secondary">
            Some pinned facilities are outside the current region window and
            couldn&apos;t be resolved here — they stay pinned and will appear
            when their region is loaded.
          </p>
        )}

        {resolved.length > 0 && (
          <>
            {/* FRP trend - real stored detections, mean FRP per active day */}
            {resolved.length >= 2 && (
              <section className="dash-card rounded-xl p-5">
                <h3 className="font-display text-sm font-semibold text-text-primary">
                  FRP trend — mean MW per active day (last 10 days)
                </h3>
                <p className="mt-0.5 text-[11px] text-text-tertiary">
                  Built from the same stored FIRMS detections the classification
                  uses. Gaps = no detections that day.
                </p>
                <div className="mt-4 h-[260px]">
                  {firmsLoading ? (
                    <div className="skeleton-shimmer h-full w-full rounded-lg" aria-hidden />
                  ) : chartData.length === 0 ? (
                    <div className="flex h-full items-center justify-center px-6 text-center text-xs text-text-tertiary">
                      No detections near any pinned facility in the current
                      window — nothing to plot without real data.
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={chartData} margin={{ top: 6, right: 12, bottom: 0, left: -18 }}>
                        <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                        <XAxis dataKey="day" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
                        <YAxis tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} unit=" MW" />
                        <ReTooltip contentStyle={tooltipStyle} />
                        {resolved.map((a, i) => (
                          <Line
                            key={a.facility.id}
                            type="monotone"
                            dataKey={a.facility.name}
                            stroke={COMPARE_COLORS[i % COMPARE_COLORS.length]}
                            strokeWidth={2}
                            dot={{ r: 2 }}
                            connectNulls
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </section>
            )}

            {/* side-by-side columns (1–3, grid auto-fits) */}
            <section
              className={
                resolved.length === 1
                  ? "grid gap-4 md:grid-cols-2"
                  : "grid gap-4 md:grid-cols-2 lg:grid-cols-3"
              }
            >
              {resolved.map((a, i) => (
                <CompareCard
                  key={a.facility.id}
                  analysis={a}
                  trend={trends.get(a.facility.id) ?? []}
                  color={COMPARE_COLORS[i % COMPARE_COLORS.length]}
                  whatChanged={narratives[a.facility.id] ?? null}
                  onRemove={() => remove(a.facility.id)}
                />
              ))}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/** One facility's comparison column — all values backend-computed. */
function CompareCard({
  analysis,
  trend,
  color,
  whatChanged,
  onRemove,
}: {
  analysis: FacilityAnalysis;
  trend: { day: string; frp: number }[];
  color: string;
  whatChanged: WhatChangedRowDto[] | null;
  onRemove: () => void;
}) {
  const a = analysis;
  const tagMeta = fireTagMeta(a.predictedTag?.tag);
  const hasTag = a.predictedTag && a.predictedTag.tag !== "unknown";

  return (
    <div className="dash-card flex flex-col gap-4 rounded-xl p-5">
      <div className="flex items-start gap-2">
        <span
          className="mt-1.5 inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        <div className="min-w-0">
          <Link
            href={`/facilities/${a.facility.id}`}
            className="block truncate font-display text-sm font-semibold text-text-primary transition-colors duration-150 hover:text-accent-primary"
          >
            {a.facility.name}
          </Link>
          <p className="text-xs text-text-secondary">{a.facility.type}</p>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Unpin ${a.facility.name}`}
          className="ml-auto flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-text-tertiary transition-colors duration-150 hover:text-text-primary"
        >
          <X size={13} />
        </button>
      </div>

      <div className="flex items-center justify-between gap-2">
        <StatusBadge status={a.status} />
        <span
          className="font-mono text-sm text-text-primary"
          title={`Risk Score — higher = more risk${a.riskScoreProvenance?.length ? ` · signals: ${a.riskScoreProvenance.join(" + ")}` : ""}`}
        >
          risk {a.riskScore}
          <span className="text-text-tertiary">/100</span>
        </span>
      </div>

      {/* predicted fire type — contextual, distinct from risk status */}
      <div
        className="flex items-center gap-1.5 self-start rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
        style={{ backgroundColor: `${tagMeta.hex}22`, color: tagMeta.hex }}
        title={tagMeta.blurb}
      >
        {hasTag ? tagMeta.label : "Fire type unclassified"}
        {hasTag && a.predictedTag!.confidence > 0 && (
          <span className="font-mono opacity-80">
            {Math.round(a.predictedTag!.confidence * 100)}%
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg border border-border-hairline bg-white/[0.02] px-2.5 py-2">
          <div className="text-[9px] uppercase tracking-wider text-text-tertiary">Detections (10d)</div>
          <div className="mt-0.5 font-mono text-text-primary">{a.detectionCount}</div>
        </div>
        <div className="rounded-lg border border-border-hairline bg-white/[0.02] px-2.5 py-2">
          <div className="text-[9px] uppercase tracking-wider text-text-tertiary">Live mean FRP</div>
          <div className="mt-0.5 font-mono text-text-primary">
            {a.liveMeanFrp != null ? `${a.liveMeanFrp.toFixed(1)} MW` : "-"}
          </div>
        </div>
        <div className="rounded-lg border border-border-hairline bg-white/[0.02] px-2.5 py-2">
          <div className="text-[9px] uppercase tracking-wider text-text-tertiary">Baseline FRP</div>
          <div className="mt-0.5 font-mono text-text-primary">
            {a.baselineMeanFrp != null ? `${a.baselineMeanFrp.toFixed(1)} MW` : "-"}
          </div>
        </div>
        <div className="rounded-lg border border-border-hairline bg-white/[0.02] px-2.5 py-2">
          <div className="text-[9px] uppercase tracking-wider text-text-tertiary">Latest FRP</div>
          <div className="mt-0.5 font-mono text-text-primary">
            {a.latestFrp != null ? `${a.latestFrp.toFixed(1)} MW` : "-"}
          </div>
        </div>
      </div>

      {/* mini FRP trend */}
      <div className="h-[110px]">
        {trend.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center text-[11px] text-text-tertiary">
            No detections in window
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={trend} margin={{ top: 4, right: 0, bottom: 0, left: -30 }}>
              <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="day" tick={{ fill: "#6B7787", fontSize: 9 }} tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis tick={{ fill: "#6B7787", fontSize: 9 }} tickLine={false} axisLine={{ stroke: GRID }} />
              <ReTooltip contentStyle={tooltipStyle} />
              <Bar dataKey="frp" fill={color} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* what changed - real backend rows, fetched per pinned facility */}
      <WhatChangedMini rows={whatChanged ?? []} loading={whatChanged == null} />
    </div>
  );
}

/** Compact what-changed list (real backend rows). */
function WhatChangedMini({
  rows,
  loading,
}: {
  rows: WhatChangedRowDto[];
  loading?: boolean;
}) {
  if (loading) {
    return <div className="skeleton-shimmer h-16 rounded-lg" aria-hidden />;
  }
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-border-hairline bg-bg-raised px-2.5 py-2 text-[11px] text-text-secondary">
        No change signals computed for this facility yet.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {rows.slice(0, 4).map((r, i) => (
        <li key={i} className="flex items-start gap-1.5 text-[11px] leading-snug">
          <StatusGlyph
            status={(r.severity ?? (r.kind === "ok" ? "normal" : "watch")) as RiskStatus}
            size={7}
            className="mt-1 flex-shrink-0"
          />
          <span className="text-text-secondary">{r.text}</span>
          {r.value && (
            <span className="ml-auto flex-shrink-0 pl-1 font-mono text-text-primary">{r.value}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
