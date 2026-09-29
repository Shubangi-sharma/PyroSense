"use client";

import React, { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import {
  Facility,
  FacilityAnalysis,
  FacilityType,
  RiskStatus,
  STATUS_META,
  STATUS_ORDER,
} from "@/lib/types";
import { useAnalyses } from "@/lib/hooks";
import { REGION_BBOXES } from "@/lib/regions";
import { StatusGlyph } from "@/lib/status";
import PinButton from "@/components/PinButton";
import clsx from "clsx";

const TYPES: FacilityType[] = [
  "Refinery",
  "Power Plant",
  "Industrial Site",
  "Mine",
];

const SEVERITY_RANK: Record<RiskStatus, number> = {
  critical: 0,
  suspicious: 1,
  watch: 2,
  unknown: 3,
  normal: 4,
};

/**
 * Pagination: render at most this many cards at once (§5 payload/render
 * discipline). Hundreds of simultaneous cards reflow the grid and jank the
 * showcase; a "Load more" button mounts the next slice on demand.
 */
const PAGE_SIZE = 30;

/**
 * content-visibility lets the browser skip layout/paint for cards scrolled
 * out of view — the same lever as pagination, applied per-card, so even the
 * mounted 30 only cost anything when actually visible.
 */
const cardContentVisibilityStyle: React.CSSProperties = {
  contentVisibility: "auto",
  containIntrinsicSize: "300px 132px",
};

/**
 * Memoised card — a SWR refresh re-renders only cards whose underlying
 * analysis actually changed (§5). The pin button writes to the shared
 * compare store (max 3) without navigating away.
 */
const FacilityCard = React.memo(function FacilityCard({
  analysis,
}: {
  analysis: FacilityAnalysis;
}) {
  const { facility: f, status } = analysis;
  const hex = STATUS_META[status].hex;
  return (
    <div
      style={cardContentVisibilityStyle}
      className="dash-card dash-stat group relative flex flex-col gap-3 overflow-hidden rounded-xl p-5"
    >
      {/* status accent - glow bar echoing the dashboard stat cards */}
      <span
        aria-hidden
        className="absolute left-0 top-0 h-full w-[3px] rounded-l"
        style={{
          backgroundColor: hex,
          boxShadow: `0 0 12px ${hex}66`,
        }}
      />
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-px"
        style={{
          background: `linear-gradient(90deg, transparent 0%, ${hex}55 50%, transparent 100%)`,
          opacity: 0.7,
        }}
      />
      <div className="relative flex items-center justify-between gap-2">
        <Link
          href={`/facilities/${f.id}`}
          className="min-w-0 flex-1 truncate font-display text-sm font-semibold text-text-primary transition-colors duration-150 hover:text-accent-primary"
        >
          {f.name}
        </Link>
        <StatusGlyph status={status} size={9} className="flex-shrink-0" />
        <PinButton facilityId={f.id} facilityName={f.name} asIcon />
      </div>
      <p className="relative text-xs text-text-secondary">
        {f.type} · {f.source === "osm" ? "OpenStreetMap" : f.source}
      </p>
      <div className="relative mt-auto flex items-baseline gap-3 pt-1 font-mono text-xs">
        <span style={{ color: hex }}>risk {analysis.riskScore}</span>
        <span className="text-text-tertiary">
          {analysis.detectionCount > 0
            ? `${analysis.detectionCount} det`
            : "quiet"}
        </span>
        <span className="ml-auto text-text-tertiary">
          {analysis.latestFrp != null ? `${analysis.latestFrp.toFixed(0)} MW` : "-"}
        </span>
      </div>
    </div>
  );
});

function FacilitiesBody() {
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [statusFilter, setStatusFilter] = useState<RiskStatus | null>(null);
  const [typeFilter, setTypeFilter] = useState<FacilityType | null>(null);

  const { analyses, isLoading, error } = useAnalyses(REGION_BBOXES.india);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return analyses
      .filter((a) => {
        const f: Facility = a.facility;
        if (statusFilter && a.status !== statusFilter) return false;
        if (typeFilter && f.type !== typeFilter) return false;
        if (q && !`${f.name} ${f.type}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort(
        (a, b) => SEVERITY_RANK[a.status] - SEVERITY_RANK[b.status] || b.riskScore - a.riskScore,
      );
  }, [analyses, query, statusFilter, typeFilter]);

  /** How many cards are mounted; grows only via the Load more button. */
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Any change to the result set (filters, search, refetch) resets to the
  // first page so the user never lands mid-list on stale pagination.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filtered]);

  const paged = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const hasMore = filtered.length > paged.length;

  return (
    <div className="pyro-scroll h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-6 p-6 pb-20">
        <header className="pt-4">
          <h1 className="font-display text-2xl font-semibold text-text-primary">
            Facility Explorer
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            {isLoading
              ? "Loading classified facilities…"
              : `${analyses.length} industrial sites from OpenStreetMap · status computed by the PYROSENSE backend`}
          </p>
        </header>

        {/* search + filter bar */}
        <section className="flex flex-col gap-3">
          <div className="relative max-w-md">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search facility or type…"
              className="h-10 w-full rounded-lg border border-border-hairline bg-bg-inset pl-9 pr-3 font-mono text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-accent-primary/60 focus:outline-none focus:ring-1 focus:ring-accent-primary/30"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {STATUS_ORDER.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter((cur) => (cur === s ? null : s))}
                aria-pressed={statusFilter === s}
                className={clsx(
                  "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors duration-150",
                  statusFilter === s
                    ? "border-accent-primary bg-accent-primary/15 text-accent-primary"
                    : "border-border-hairline bg-bg-surface text-text-secondary hover:border-border-strong hover:text-text-primary",
                )}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: STATUS_META[s].hex }}
                />
                {STATUS_META[s].label}
              </button>
            ))}
            <span className="mx-1 h-5 w-px bg-border-hairline" aria-hidden />
            {TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTypeFilter((cur) => (cur === t ? null : t))}
                aria-pressed={typeFilter === t}
                className={clsx(
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors duration-150",
                  typeFilter === t
                    ? "border-accent-primary bg-accent-primary/15 text-accent-primary"
                    : "border-border-hairline bg-bg-surface text-text-secondary hover:border-border-strong hover:text-text-primary",
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </section>

        {/* results */}
        <p className="font-mono text-xs text-text-tertiary">
          {isLoading ? "…" : `${filtered.length} of ${analyses.length} facilities`}
        </p>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {isLoading
            ? Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="skeleton-shimmer h-[132px] rounded-xl"
                  aria-hidden
                />
              ))
            : paged.map((a) => <FacilityCard key={a.facility.id} analysis={a} />)}
        </section>

        {/* Load more - mounts the next PAGE_SIZE slice instead of rendering
            every match at once (keeps the grid cheap with 100s of sites). */}
        {hasMore && (
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
              className="rounded-lg border border-border-hairline bg-bg-surface px-6 py-2.5 text-sm font-medium text-text-primary transition-colors duration-150 hover:border-border-strong hover:bg-bg-raised focus:border-accent-primary/60 focus:outline-none focus:ring-1 focus:ring-accent-primary/30"
            >
              Load more
            </button>
            <span className="font-mono text-[11px] text-text-tertiary">
              {paged.length} of {filtered.length} shown
            </span>
          </div>
        )}

        {!isLoading && error && (
          <div className="rounded-xl bg-bg-surface p-10 text-center">
            <p className="text-sm text-text-secondary">
              Facility feed unavailable - the backend could not be reached. Retrying
              automatically.
            </p>
          </div>
        )}

        {!isLoading && !error && filtered.length === 0 && (
          <div className="rounded-xl bg-bg-surface p-10 text-center">
            <p className="text-sm text-text-secondary">
              {analyses.length === 0
                ? "No industrial sites returned for this region yet."
                : "No facilities match the current filters"}
            </p>
            {analyses.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setStatusFilter(null);
                  setTypeFilter(null);
                }}
                className="mt-3 text-xs font-medium text-accent-primary hover:text-accent-secondary"
              >
                Clear all filters
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function FacilitiesPage() {
  return (
    <Suspense fallback={null}>
      <FacilitiesBody />
    </Suspense>
  );
}
