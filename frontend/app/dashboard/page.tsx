"use client";

/**
 * Command Dashboard — operational overview.
 *
 * Removed: north/west/other region stat tiles (no longer region-scoped).
 * Added: incident feed, ML pipeline status card, richer facility table.
 */

import React, { useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  Eye,
  Flame,
  Radio,
  ShieldAlert,
  TrendingUp,
} from "lucide-react";
import { FacilityAnalysis, RiskStatus, statusColorHex, STATUS_META } from "@/lib/types";
import PyroLoader from "@/components/PyroLoader";
import { useAnalyses, useFirms, useCommand } from "@/lib/hooks";
import { REGION_BBOXES } from "@/lib/regions";
import { StatusBadge, StatusGlyph } from "@/lib/status";
import type { MapView } from "@/components/MapInner";

const MapInner = dynamic(() => import("@/components/MapInner"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center">
      <PyroLoader label="Rendering live overview" compact />
    </div>
  ),
});

const RANK: Record<RiskStatus, number> = {
  critical: 0,
  suspicious: 1,
  watch: 2,
  unknown: 3,
  normal: 4,
};

const PREVIEW_VIEW: MapView = {
  center: [22.0, 79.0],
  zoom: 5,
  key: "dashboard-preview",
};

/* ------------------------------------------------------------------ */
/* small reusable pieces                                                */
/* ------------------------------------------------------------------ */

function MetricCard({
  icon: Icon,
  label,
  value,
  accent,
  loading,
}: {
  icon: React.ElementType;
  label: string;
  value: number | string;
  accent?: string;
  loading?: boolean;
}) {
  return (
    <div className="dash-card dash-stat rounded-xl p-4" style={{ "--stat-accent": accent ?? "rgba(91,155,213,0.3)" } as React.CSSProperties}>
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: `${accent ?? "rgba(91,155,213,0.3)"}15` }}>
          <Icon size={15} style={{ color: accent ?? "#5B9BD5" }} className="opacity-70" />
        </div>
        <span className="text-xs text-text-secondary">{label}</span>
      </div>
      <div className={`mt-3 font-display text-2xl font-semibold leading-none text-text-primary ${loading ? "animate-pulse" : ""}`}>
        {loading ? "-" : value}
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  linkText,
  linkHref,
}: {
  title: string;
  linkText?: string;
  linkHref?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="font-display text-[13px] font-semibold uppercase tracking-wider text-text-tertiary">
        {title}
      </h2>
      {linkText && linkHref && (
        <Link
          href={linkHref}
          className="group flex items-center gap-1 text-xs text-accent-primary transition-colors hover:text-accent-secondary"
        >
          {linkText}
          <ArrowUpRight size={12} className="transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
        </Link>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */

export default function DashboardPage() {
  const router = useRouter();

  const { analyses, isLoading: analysesLoading } = useAnalyses(REGION_BBOXES.india);
  const { hotspots, isLoading: firmsLoading } = useFirms(REGION_BBOXES.india);
  const { command } = useCommand();

  const loading = analysesLoading || (firmsLoading && analyses.length === 0);

  /* derived stats */
  const statusCounts = useMemo(() => {
    const counts: Record<RiskStatus, number> = { critical: 0, suspicious: 0, watch: 0, normal: 0, unknown: 0 };
    for (const a of analyses) counts[a.status]++;
    return counts;
  }, [analyses]);

  const totalFacilities = command?.facilitiesMonitored ?? analyses.length;
  const totalDetections = hotspots.length;
  const avgFrp = useMemo(() => {
    if (hotspots.length === 0) return 0;
    return Math.round(hotspots.reduce((s, h) => s + h.frp, 0) / hotspots.length);
  }, [hotspots]);

  const handlePreviewSelect = React.useCallback(
    (id: string) => router.push(`/facilities/${id}`),
    [router],
  );

  /* top facilities needing attention (unified Risk Score, higher = more risk) */
  const topFacilities = useMemo(
    () =>
      [...analyses]
        .sort((a, b) => RANK[a.status] - RANK[b.status] || b.riskScore - a.riskScore)
        .slice(0, 6),
    [analyses],
  );

  /* priority list from command view */
  const priorityList = useMemo(
    () => command?.priorityList?.slice(0, 10) ?? [],
    [command],
  );

  /* category counts */
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of command?.priorityList ?? []) {
      counts.set(f.classificationLabel, (counts.get(f.classificationLabel) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [command]);

  return (
    <div className="pyro-scroll h-full overflow-y-auto bg-gradient-mesh">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-6 p-5 pb-20 lg:p-6">
        {/* header */}
        <header className="flex flex-col gap-1 pt-3 sm:flex-row sm:items-baseline sm:justify-between">
          <div>
            <h1 className="font-display text-xl font-semibold text-text-primary sm:text-2xl">
              Command Dashboard
            </h1>
            <p className="mt-0.5 text-sm text-text-secondary">
              Real-time monitoring overview · {totalFacilities} facilities tracked
            </p>
          </div>
          <span className="font-mono text-[10px] text-text-tertiary">
            VIIRS S-NPP + NOAA-20
          </span>
        </header>

        {/* ── metrics row ──────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <MetricCard icon={Eye} label="Monitored Facilities" value={totalFacilities} loading={loading} />
          <MetricCard icon={Flame} label="Detections (10d)" value={totalDetections} accent="rgba(224,168,76,0.5)" loading={loading} />
          <MetricCard icon={AlertTriangle} label="Critical" value={statusCounts.critical} accent="rgba(224,96,96,0.5)" loading={loading} />
          <MetricCard icon={Activity} label="Suspicious" value={statusCounts.suspicious} accent="rgba(224,138,82,0.5)" loading={loading} />
          <MetricCard icon={Radio} label="Avg FRP (MW)" value={avgFrp} accent="rgba(79,179,179,0.5)" loading={loading} />
        </div>

        {/* ── status breakdown bar ─────────────────────────────────── */}
        {!loading && analyses.length > 0 && (
          <div className="dash-card rounded-xl p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-medium text-text-secondary">Facility Status Distribution</span>
              <span className="font-mono text-[10px] text-text-tertiary">{analyses.length} total</span>
            </div>
            {/* visual bar */}
            <div className="flex h-2.5 overflow-hidden rounded-full bg-bg-inset">
              {(["critical", "suspicious", "watch", "normal", "unknown"] as RiskStatus[])
                .filter((s) => statusCounts[s] > 0)
                .map((s) => (
                  <div
                    key={s}
                    className="transition-all duration-500"
                    style={{
                      width: `${(statusCounts[s] / analyses.length) * 100}%`,
                      backgroundColor: STATUS_META[s].hex,
                    }}
                  />
                ))}
            </div>
            {/* legend */}
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
              {(["critical", "suspicious", "watch", "normal", "unknown"] as RiskStatus[])
                .filter((s) => statusCounts[s] > 0)
                .map((s) => (
                  <span key={s} className="flex items-center gap-1.5">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: STATUS_META[s].hex }} />
                    <span className="text-[11px] text-text-secondary">{STATUS_META[s].label}</span>
                    <span className="font-mono text-[11px] text-text-primary">{statusCounts[s]}</span>
                  </span>
                ))}
            </div>
          </div>
        )}

        {/* ── two-column: map + top alerts ─────────────────────────── */}
        <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
          {/* map preview */}
          <div className="flex flex-col gap-3">
            <SectionHeader title="Live Overview" linkText="Full map" linkHref="/map" />
            <div className="relative h-[380px] overflow-hidden rounded-xl border border-border-hairline lg:h-[440px]">
              <MapInner
                view={PREVIEW_VIEW}
                analyses={analyses}
                selectedId={null}
                onSelect={handlePreviewSelect}
                firmsHotspots={hotspots}
                showFirms
                onSelectHotspot={() => {}}
                onTilesLoading={() => {}}
                onTilesLoaded={() => {}}
                onViewport={() => {}}
              />
            </div>
          </div>

          {/* top alerts */}
          <div className="flex flex-col gap-3">
            <SectionHeader title="Needs Attention" linkText="AI assistant" linkHref="/chat" />
            {loading ? (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-[100px] skeleton-shimmer rounded-xl" />
                ))}
              </div>
            ) : topFacilities.length === 0 ? (
              <div className="dash-card flex items-center justify-center rounded-xl p-10">
                <p className="text-sm text-text-secondary">All facilities within baseline.</p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {topFacilities.map((a: FacilityAnalysis) => (
                  <Link
                    key={a.facility.id}
                    href={`/facilities/${a.facility.id}`}
                    className="dash-card group flex items-center gap-3 rounded-xl p-3.5"
                  >
                    <StatusGlyph status={a.status} size={10} className="flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text-primary group-hover:text-accent-primary">
                        {a.facility.name}
                      </p>
                      <p className="mt-0.5 truncate font-mono text-[10px] text-text-tertiary">
                        {a.facility.type} · {a.detectionCount} det · risk {a.riskScore}
                        {a.latestFrp != null ? ` · ${a.latestFrp.toFixed(0)} MW` : ""}
                      </p>
                    </div>
                    <StatusBadge status={a.status} />
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── category mix - single horizontal strip, no wrapping grid ── */}
        {!loading && categoryCounts.length > 0 && (
          <div className="flex flex-col gap-3">
            <SectionHeader title="Behavioural Categories" />
            <div className="dash-card flex flex-row items-center gap-6 overflow-x-auto rounded-xl px-5 py-3.5">
              {categoryCounts.map(([label, n]) => (
                <div
                  key={label}
                  className="flex flex-shrink-0 items-center gap-2.5"
                >
                  <span className="font-display text-lg font-semibold leading-none text-text-primary">
                    {n}
                  </span>
                  <span className="whitespace-nowrap text-[11px] leading-tight text-text-secondary">
                    {label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── priority table ───────────────────────────────────────── */}
        {priorityList.length > 0 && (
          <div className="flex flex-col gap-3">
            <SectionHeader title="Risk-Ranked Priority List" linkText="Analytics" linkHref="/analytics" />
            <div className="overflow-x-auto rounded-xl border border-border-hairline" style={{ background: "rgba(15,19,24,0.5)" }}>
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-border-hairline text-[10px] uppercase tracking-widest text-text-tertiary">
                    <th className="px-4 py-2.5 font-medium">#</th>
                    <th className="px-4 py-2.5 font-medium">Facility</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium text-right">Risk Score</th>
                    <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Classification</th>
                  </tr>
                </thead>
                <tbody>
                  {priorityList.map((fac, i) => {
                    const hex = statusColorHex(fac.status as RiskStatus);
                    return (
                      <tr
                        key={fac.id}
                        onClick={() => router.push(`/facilities/${fac.id}`)}
                        className="cursor-pointer border-b border-border-hairline transition-colors last:border-b-0 hover:bg-white/[0.015]"
                      >
                        <td className="px-4 py-3 font-mono text-[11px] text-text-tertiary">
                          {String(i + 1).padStart(2, "0")}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: hex }} />
                            <span className="truncate text-sm text-text-primary">{fac.name}</span>
                            <span className="hidden flex-shrink-0 font-mono text-[10px] text-text-tertiary md:inline">
                              {fac.type}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={fac.status as RiskStatus} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span
                            className="font-mono text-xs font-semibold"
                            style={{ color: hex }}
                            title={`Signals: ${fac.riskScoreProvenance.join(" + ")} · ${fac.riskScoreLive ? "live, just computed" : `as of ${new Date(fac.riskScoreComputedAt).toISOString().slice(0, 16).replace("T", " ")} UTC`}`}
                          >
                            {fac.riskScore}
                          </span>
                        </td>
                        <td className="hidden px-4 py-3 sm:table-cell">
                          <span className="inline-flex items-center gap-1 rounded-md border border-border-hairline bg-bg-inset/50 px-2 py-0.5 text-[10px] text-text-secondary">
                            {fac.classificationLabel}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
