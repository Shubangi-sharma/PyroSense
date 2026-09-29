"use client";

import React from "react";
import {
  ChevronDown,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  Satellite,
  X,
} from "lucide-react";
import FacilityDetailPanel from "./FacilityDetailPanel";

import { FirmsHotspotDetail } from "./MapMarkerTooltips";
import FreshnessBadge from "./FreshnessBadge";
import { frpBandIndex } from "./MapCanvas";
import { FRP_BANDS, type FirmsHotspot } from "@/lib/firms";
import {
  fetchViewportRisk,
  ViewportRiskError,
  type ViewportRiskResponse,
} from "@/lib/opsApi";
import { HORIZON_LABELS, RISK_LEVEL_COLORS, RISK_LEVEL_LABELS, type RiskHorizon } from "@/lib/riskApi";
import type { Detection, FacilityAnalysis, FacilityNarrative, RiskStatus } from "@/lib/types";
import { STATUS_META, STATUS_ORDER, statusColorHex } from "@/lib/types";
import { haversineKm } from "@/lib/geo";
import clsx from "clsx";

/**
 * Client-side mirror of the BFF's H3 res-7 cell budget: viewports wider
 * than ~150 km per axis fill more than the 5000-cell cap, so the server
 * answers 413. Pre-checking here keeps the console clean (no failed
 * requests on the default India view) and renders the same honest
 * "zoom in" state instantly, without a round-trip.
 */
const MAX_RISK_VIEWPORT_SPAN_KM = 150;

function bboxSpanKm(bbox: DrawerBBox): number {
  const latSpan = Math.abs(bbox.north - bbox.south) * 111;
  const midLat = Math.min(89, Math.max(-89, (bbox.north + bbox.south) / 2));
  const lngSpan = Math.abs(bbox.east - bbox.west) * 111 * Math.cos((midLat * Math.PI) / 180);
  return Math.max(latSpan, lngSpan);
}

/**
 * DetailDrawer — the map page's PERSISTENT detail pane (not a slide-over).
 *
 * Exactly one state renders at a time, driven by the page's selection state:
 *   1. "empty"    — live summary of the current viewport: hotspot count,
 *                   FRP-band breakdown, facility risk-status breakdown and a
 *                   freshness chip (newest real detection timestamp via
 *                   FreshnessBadge — no timestamp field is invented).
 *   2. "facility" — wraps the existing FacilityDetailPanel (single source of
 *                   truth for facility detail content; never duplicated).
 *   3. "hotspot"  — pinned FIRMS detection: real sensor fields only (FRP,
 *                   brightness, confidence, coordinates, acquisition) via
 *                   FirmsHotspotDetail, plus the corroboration list.
 *   (The old "cell" state is gone: H3 cell ids meant nothing to map
 *   readers, so background clicks now open the plain-language AreaPanel
 *   rendered by the map page itself.)
 *
 * Layout: right pane (~380px) on `lg:`+ — the breakpoint the app's page grids
 * already use for major layout switches — and a bottom sheet below it. The
 * pane is collapsible via the toggle button; any new selection auto-expands
 * it (handled by the parent page).
 *
 * Honesty rule (docs/decisions-and-faq.md): FIRMS detections carry NO
 * hotspot-type or risk-horizon fields anywhere in the current API contract,
 * so none are shown here (a per-detection classification is listed under
 * "Where this could improve" in the docs).
 */

export type DetailDrawerSelection =
  | { kind: "empty" }
  | {
      kind: "facility";
      analysis: FacilityAnalysis;
      narrative: FacilityNarrative | null;
      summary: { text: string; provider: string } | null;
      timelineActiveIndex?: number | null;
      onClose: () => void;
      onViewSatellite: () => void;
      onOpenFullPage: () => void;
    }
  | {
      kind: "hotspot";
      hotspot: FirmsHotspot;
      relatedFacilities: FacilityAnalysis[];
      onClose: () => void;
      onSelectFacility: (id: string) => void;
      onViewSatellite: () => void;
    };

/* ------------------------------------------------------------------ */
/* empty state — live viewport summary                                 */
/* ------------------------------------------------------------------ */

/**
 * A BBox as the lib/regions type (west/south/east/north degrees).
 */
export interface DrawerBBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Viewport GRU risk signals (GET /api/v1/risk) — the batch counterpart of
 * the per-cell CellPanel. Only meaningful for zoomed-in viewports: the BFF
 * fills the bbox with H3 res-7 cells and refuses anything above 5000 cells
 * (413), which this section renders as an honest "zoom in" state instead of
 * pretending the data exists. `meta.stale` (ML down, cache served) is shown.
 */
function ViewportRiskSection({ bbox }: { bbox: DrawerBBox }) {
  const [data, setData] = React.useState<ViewportRiskResponse | null>(null);
  const [tooLarge, setTooLarge] = React.useState(false);
  const [unavailable, setUnavailable] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    // Too-wide viewport → skip the request entirely (the server would 413).
    if (bboxSpanKm({ west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north }) > MAX_RISK_VIEWPORT_SPAN_KM) {
      setData(null);
      setTooLarge(true);
      setUnavailable(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setData(null);
    setTooLarge(false);
    setUnavailable(false);
    setLoading(true);
    fetchViewportRisk({
      minLat: bbox.south,
      maxLat: bbox.north,
      minLng: bbox.west,
      maxLng: bbox.east,
    })
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ViewportRiskError && err.status === 413) setTooLarge(true);
        else setUnavailable(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bbox.west, bbox.south, bbox.east, bbox.north]);

  const levelCounts = React.useMemo(() => {
    const counts: Record<string, number> = { HIGH: 0, MODERATE: 0, LOW: 0 };
    if (data) for (const entry of Object.values(data.risks)) counts[entry.overall] = (counts[entry.overall] ?? 0) + 1;
    return counts;
  }, [data]);

  /** The furthest-out horizon that actually carries a threshold signal. */
  const headlineHorizon: RiskHorizon = "7day";

  return (
    <section className="dash-card rounded-xl p-4">
      <div className="flex items-baseline gap-2">
        <h3 className="font-display text-sm font-semibold text-text-primary">
          GRU risk signals
        </h3>
        <span className="text-[10px] text-text-tertiary">· this view</span>
        {data?.meta.stale && (
          <span className="ml-auto rounded-full bg-bg-raised px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-status-watch">
            stale
          </span>
        )}
      </div>
      <p className="mt-1 text-[10px] leading-snug text-text-tertiary">
        {HORIZON_LABELS[headlineHorizon]} horizon · threshold signals, not
        probabilities
      </p>
      {loading ? (
        <p className="mt-3 text-xs text-text-tertiary">Checking stored predictions…</p>
      ) : tooLarge ? (
        <p className="mt-3 text-xs text-text-tertiary">
          Zoom in - risk signals are computed per ~9 km² H3 cell, so very large
          views are not scored.
        </p>
      ) : unavailable ? (
        <p className="mt-3 text-xs text-text-tertiary">
          Risk signals unavailable (ML service unreachable and no cached data
          for this area).
        </p>
      ) : data && Object.keys(data.risks).length === 0 ? (
        <p className="mt-3 text-xs text-text-tertiary">
          No stored predictions for this view yet - run the ML pipeline (Settings → System status) to generate them.
        </p>
      ) : data ? (
        <>
          <div className="mt-3 grid gap-1.5">
            {(Object.keys(levelCounts) as (keyof typeof levelCounts)[]).map((level) => (
              <span key={level} className="flex items-center gap-2">
                <span
                  className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                  style={{ backgroundColor: RISK_LEVEL_COLORS[level] ?? "#78808C" }}
                />
                <span className="text-[11px] text-text-secondary">
                  {RISK_LEVEL_LABELS[level] ?? level}
                </span>
                <span className="ml-auto font-mono text-[11px] text-text-primary">
                  {levelCounts[level]}
                </span>
              </span>
            ))}
          </div>
          <p className="mt-2.5 text-[10px] leading-snug text-text-tertiary">
            {Object.keys(data.risks).length} scored cells · {data.missing.length} without stored history
            {data.meta.cached ? " · cached" : ""} - click a cell on the map for horizons 1/3/7.
          </p>
        </>
      ) : null}
    </section>
  );
}

function EmptySummary({
  hotspots,
  analyses,
  viewportBbox,
}: {
  hotspots: FirmsHotspot[];
  analyses: FacilityAnalysis[];
  viewportBbox: DrawerBBox | null;
}) {
  /** Real FRP-band classification — the same one the markers/legend use. */
  const bandCounts = React.useMemo(() => {
    const counts: [number, number, number] = [0, 0, 0];
    for (const h of hotspots) counts[frpBandIndex(h.frp)]++;
    return counts;
  }, [hotspots]);

  /** Facility risk-status breakdown (statuses are backend-computed). */
  const statusCounts = React.useMemo(() => {
    const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<
      RiskStatus,
      number
    >;
    for (const a of analyses) counts[a.status] = (counts[a.status] ?? 0) + 1;
    return counts;
  }, [analyses]);

  /** Newest REAL detection timestamp in view — no invented fetch-time field. */
  const latest = React.useMemo(() => {
    let acc: Detection | null = null;
    for (const h of hotspots) {
      if (
        !acc ||
        h.acqDate > acc.acqDate ||
        (h.acqDate === acc.acqDate && h.acqTime > acc.acqTime)
      ) {
        acc = h;
      }
    }
    return acc;
  }, [hotspots]);

  const latestMeta = latest
    ? {
        data_timestamp: `${latest.acqDate}T${latest.acqTime
          .padStart(4, "0")
          .slice(0, 2)}:${latest.acqTime.padStart(4, "0").slice(2, 4)}:00Z`,
      }
    : null;

  const visibleStatuses = STATUS_ORDER.filter((s) => statusCounts[s] > 0);

  return (
    <>
      <section className="dash-card rounded-xl p-4">
        <div className="flex items-baseline gap-2">
          <span className="font-display text-3xl font-bold leading-none text-text-primary">
            {hotspots.length}
          </span>
          <span className="text-xs text-text-secondary">
            hotspots in the current view
          </span>
        </div>
        <div className="mt-1 text-[11px] text-text-tertiary">
          {analyses.length} monitored facilities in view
        </div>
        <div className="mt-3">
          <FreshnessBadge meta={latestMeta} label="Data as of" />
          <p className="mt-1.5 text-[10px] leading-snug text-text-tertiary">
            Newest VIIRS detection in the current view
            {latest
              ? ` · ${latest.acqDate} ${latest.acqTime
                  .padStart(4, "0")
                  .slice(0, 2)}:${latest.acqTime.padStart(4, "0").slice(2, 4)} UTC`
              : ""}
          </p>
        </div>
      </section>

      <section className="dash-card rounded-xl p-4">
        <h3 className="font-display text-sm font-semibold text-text-primary">
          Hotspots by FRP band
        </h3>
        <div className="mt-3 grid gap-1.5">
          {FRP_BANDS.map((band, i) => (
            <span key={band.label} className="flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                style={{ backgroundColor: band.color }}
              />
              <span className="font-mono text-[11px] text-text-secondary">
                {band.label}
              </span>
              <span className="ml-auto font-mono text-[11px] text-text-primary">
                {bandCounts[i]}
              </span>
            </span>
          ))}
        </div>
      </section>

      {viewportBbox && <ViewportRiskSection bbox={viewportBbox} />}

      <section className="dash-card rounded-xl p-4">
        <h3 className="font-display text-sm font-semibold text-text-primary">
          Facilities by risk status
        </h3>
        {visibleStatuses.length === 0 ? (
          <p className="mt-2 text-xs text-text-tertiary">
            No facilities in the current view.
          </p>
        ) : (
          <div className="mt-3 grid gap-1.5">
            {visibleStatuses.map((s) => (
              <span key={s} className="flex items-center gap-2">
                <span
                  className="inline-block h-2 w-2 flex-shrink-0 rounded-sm"
                  style={{ backgroundColor: statusColorHex(s) }}
                />
                <span className="text-[11px] text-text-secondary">
                  {STATUS_META[s].label}
                </span>
                <span className="ml-auto font-mono text-[11px] text-text-primary">
                  {statusCounts[s]}
                </span>
              </span>
            ))}
          </div>
        )}
      </section>

    </>
  );
}

/* ------------------------------------------------------------------ */
/* the drawer                                                          */
/* ------------------------------------------------------------------ */

const STATE_TITLE: Record<DetailDrawerSelection["kind"], string> = {
  empty: "Live summary",
  facility: "Facility detail",
  hotspot: "Hotspot detail",
};

export default function DetailDrawer({
  collapsed,
  onToggleCollapsed,
  selection,
  viewportHotspots,
  viewportAnalyses,
  viewportBbox = null,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  selection: DetailDrawerSelection;
  /** detections currently shown on the map (already filter-narrowed) */
  viewportHotspots: FirmsHotspot[];
  /** classified facilities currently shown on the map */
  viewportAnalyses: FacilityAnalysis[];
  /** live map viewport (debounced) for the batch risk-signal section */
  viewportBbox?: DrawerBBox | null;
}) {
  return (
    <aside
      aria-label="Details panel"
      className={clsx(
        "flex flex-shrink-0 flex-col border-t border-border-hairline bg-bg-base transition-[height] duration-300 lg:border-l lg:border-t-0 lg:transition-[width]",
        collapsed ? "h-11 lg:h-full lg:w-12" : "h-[42vh] lg:h-full lg:w-[380px]",
      )}
    >
      {collapsed ? (
        /* collapsed strip: full-width bar (bottom sheet) / narrow rail (pane) */
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Expand details panel"
          aria-expanded={false}
          className="flex h-full w-full items-center justify-center text-text-tertiary transition-colors duration-150 hover:bg-bg-raised hover:text-text-primary"
        >
          <ChevronUp size={16} className="lg:hidden" />
          <ChevronsLeft size={16} className="hidden lg:block" />
        </button>
      ) : (
        <>
          {/* slim bar: state label + collapse toggle */}
          <div className="flex h-10 flex-shrink-0 items-center gap-2 border-b border-border-hairline px-3">
            <span className="font-body text-[10px] font-semibold uppercase tracking-widest text-text-tertiary">
              {STATE_TITLE[selection.kind]}
            </span>
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label="Collapse details panel"
              aria-expanded={true}
              className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg text-text-tertiary transition-colors duration-150 hover:bg-bg-raised hover:text-text-primary"
            >
              <ChevronDown size={15} className="lg:hidden" />
              <ChevronsRight size={15} className="hidden lg:block" />
            </button>
          </div>

          {/* 1. nothing selected → live viewport summary */}
          {selection.kind === "empty" && (
            <div className="pyro-scroll min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
              <EmptySummary
                hotspots={viewportHotspots}
                analyses={viewportAnalyses}
                viewportBbox={viewportBbox}
              />
            </div>
          )}

          {/* 2. facility selected → existing FacilityDetailPanel, wrapped */}
          {selection.kind === "facility" && (
            <div className="flex min-h-0 flex-1 flex-col">
              <FacilityDetailPanel
                analysis={selection.analysis}
                narrative={selection.narrative}
                summary={selection.summary}
                timelineActiveIndex={selection.timelineActiveIndex}
                onClose={selection.onClose}
                onViewSatellite={selection.onViewSatellite}
                onOpenFullPage={selection.onOpenFullPage}
              />
            </div>
          )}

          {/* 3. FIRMS hotspot selected → real sensor fields only */}
          {selection.kind === "hotspot" && (
            <>
              <div className="flex items-start gap-3 border-b border-border-hairline p-5 pb-4">
                <div className="min-w-0">
                  <h2 className="font-display text-lg font-semibold leading-snug text-text-primary">
                    Thermal hotspot
                  </h2>
                  <p className="mt-0.5 text-xs text-text-secondary">
                    {selection.hotspot.satellite} {selection.hotspot.instrument} · VIIRS
                    active-fire detection
                  </p>
                </div>
                <button
                  type="button"
                  onClick={selection.onClose}
                  aria-label="Close hotspot detail"
                  className="ml-auto flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-text-tertiary transition-colors duration-150 hover:bg-bg-raised hover:text-text-primary"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="pyro-scroll min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
                <FirmsHotspotDetail hotspot={selection.hotspot} />

                <button
                  type="button"
                  onClick={selection.onViewSatellite}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-border-hairline bg-bg-raised py-2.5 text-xs font-medium text-text-secondary transition-colors duration-150 hover:border-border-strong hover:text-text-primary"
                >
                  <Satellite size={14} />
                  View satellite
                </button>
                {selection.relatedFacilities.length > 0 && (
                  <section>
                    <h3 className="font-display text-sm font-semibold text-text-primary">
                      Nearby facilities - is this hotspot corroborated?
                    </h3>
                    <p className="mt-1 text-xs leading-snug text-text-secondary">
                      Facilities whose corroboration radius (5 km) covers this
                      detection. Their classification already includes it.
                    </p>
                    <div className="mt-3 space-y-2">
                      {selection.relatedFacilities.map((a) => (
                        <button
                          key={a.facility.id}
                          type="button"
                          onClick={() => selection.onSelectFacility(a.facility.id)}
                          className="flex w-full items-center gap-3 rounded-lg border border-border-hairline bg-white/[0.02] px-3 py-2.5 text-left transition-colors duration-150 hover:border-border-strong hover:bg-white/[0.04]"
                        >
                          <span
                            className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
                            style={{ backgroundColor: statusColorHex(a.status) }}
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-text-primary">
                              {a.facility.name}
                            </span>
                            <span className="block text-xs text-text-secondary">
                              {a.facility.type} · {a.detectionCount} det · risk {a.riskScore}
                            </span>
                          </span>
                          <span className="ml-auto flex-shrink-0 font-mono text-[11px] text-text-secondary">
                            {haversineKm(
                              selection.hotspot.latitude,
                              selection.hotspot.longitude,
                              a.facility.lat,
                              a.facility.lng,
                            ).toFixed(1)}{" "}
                            km
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                {selection.relatedFacilities.length === 0 && (
                  <p className="rounded-lg border border-border-hairline bg-bg-raised px-3 py-2 text-xs text-text-secondary">
                    No monitored facility within 15 km - this is likely biomass
                    burning or an unmonitored source, not industrial activity.
                  </p>
                )}
              </div>
            </>
          )}
        </>
      )}
    </aside>
  );
}
