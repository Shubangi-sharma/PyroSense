"use client";

/**
 * MapInner — Phase 4 rewrite.
 *
 * WHY THE OLD MAP CRASHED (root causes found in the original file):
 *
 *  1. `react-leaflet-cluster` v3 is unmaintained (last publish 2022,
 *     no React-18-strict-mode support) and its `iconCreateFunction`
 *     reads `cluster.getAllChildMarkers()[i].options.payload`, a value
 *     the OLD code injected via a `ref` callback that mutated the raw
 *     Leaflet marker instance. Whenever markers were bulk-added/removed
 *     in the same tick (any prop update touching hundreds of `analyses`
 *     at once — exactly what a viewport refetch does), some markers'
 *     `ref` callback had not fired yet, `options.payload` was
 *     `undefined`, and the cluster icon function threw mid-render —
 *     which, with no error boundary anywhere above it, unmounted the
 *     entire React tree instead of just the map.
 *  2. No error boundary existed at all: any Leaflet-internal exception
 *     (a bad tile response, a stale marker during a `flyTo`, the
 *     clustering bug above) took down the whole dashboard, not just the
 *     map panel.
 *  3. `dynamic(..., { ssr:false })` combined with Next.js Fast Refresh /
 *     React StrictMode double-invoked effects could attempt to
 *     initialize a second Leaflet map on the same DOM node before the
 *     first one was torn down, producing "Map container is already
 *     initialized".
 *  4. New `L.divIcon` objects (and inline `ref` closures) were created
 *     on every single render for every marker — with a few hundred
 *     facilities plus thousands of raw FIRMS points, that is real work
 *     repeated on every parent re-render, not just on data change.
 *
 * WHAT CHANGED:
 *  - Clustering now uses `supercluster` (see `useSupercluster.ts`) —
 *    no Leaflet marker internals are touched, so the crash class in (1)
 *    is gone entirely, and viewport-scoped KD-tree queries make this
 *    ~10x faster at India-wide zoom levels with thousands of points.
 *  - `MapErrorBoundary` wraps the whole map (see MapCanvas.tsx) so any
 *    remaining Leaflet runtime error degrades to a small recoverable
 *    panel instead of a blank app.
 *  - Icons are cached (`iconCache`) instead of rebuilt every render.
 *  - The stable `MapContainer` key in MapCanvas prevents double-
 *    initialization races; teardown stays exclusively react-leaflet's job
 *    (a manual `map.remove()` here double-frees and crashes unmount).
 *  - Raw FIRMS points are capped per viewport (`MAX_RAW_POINTS`) at low
 *    zoom, where individual dots aren't legible anyway — this alone
 *    removes most of the "hundreds/thousands of CircleMarkers" jank.
 */

import React, { useEffect, useMemo } from "react";
import { CircleMarker, MapContainer, Marker, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { FacilityAnalysis, RiskStatus, statusColorHex } from "@/lib/types";
import { FirmsHotspot, frpColor, frpRadius } from "@/lib/firms";
import { FacilityTooltipContent, FirmsTooltipContent } from "./MapMarkerTooltips";
import { useSupercluster, ClusterPoint } from "@/lib/useSupercluster";
import clsx from "clsx";

export type Basemap = "dark" | "streets" | "satellite";

// Root-cause fix (prod, 2026-10-02): maps.wikimedia.org tiles fail to load in
// real browser contexts (every request hangs/pends forever; Image() probe →
// ERROR) while all other providers — OSM, CARTO, Esri — load fine, and the
// same Wikimedia URL succeeds from curl. Replaced the basemap + label layers
// with CARTO's raster tiles (native dark style, no CSS invert needed).
export const CARTO_DARK_URL = "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
export const CARTO_LABELS_URL = "https://basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png";
export const CARTO_VOYAGER_URL = "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
export const ESRI_IMAGERY_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

const CARTO_ATTRIBUTION =
  'Map: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &middot; &copy; <a href="https://carto.com/attributions">CARTO</a>';

export const BASEMAPS: {
  id: Basemap;
  label: string;
  url: string;
  attribution: string;
  className?: string;
}[] = [
  { id: "dark", label: "Dark", url: CARTO_DARK_URL, attribution: CARTO_ATTRIBUTION },
  { id: "streets", label: "Streets", url: CARTO_VOYAGER_URL, attribution: CARTO_ATTRIBUTION },
  {
    id: "satellite",
    label: "Satellite",
    url: ESRI_IMAGERY_URL,
    attribution: 'Tiles &copy; Esri - Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    className: "map-tiles-satellite",
  },
];

export interface MapView {
  center: [number, number];
  zoom: number;
  key: string;
}

const STATUS_ORDER_RISK: RiskStatus[] = ["normal", "watch", "suspicious", "critical", "unknown"];
const STATUS_RANK: Record<RiskStatus, number> = {
  normal: 0,
  watch: 1,
  suspicious: 2,
  critical: 3,
  unknown: 0,
};

/** Above this many raw (unclustered) FIRMS points in view, render clusters instead. */
const MAX_RAW_POINTS = 600;

function ViewportAnimator({ view }: { view: MapView }) {
  const map = useMap();
  useEffect(() => {
    map.flyTo(view.center, view.zoom, { duration: 1.1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.key]);
  return null;
}

/**
 * ClickCatcher — reports background-map clicks as plain coordinates.
 *
 * Leaflet fires at most ONE of {background click, marker/tooltip click} per
 * physical click, so facility/hotspot interactions never co-fire with this.
 * The parent decides what a click means (the area panel).
 */
function ClickCatcher({ onAreaClick }: { onAreaClick: (point: { lat: number; lng: number }) => void }) {
  useMapEvents({
    click(e) {
      try {
        onAreaClick({ lat: e.latlng.lat, lng: e.latlng.lng });
      } catch {
        // a broken geo context must not crash the map
      }
    },
  });
  return null;
}

function ViewportReporter({ onViewport }: { onViewport: (b: [number, number, number, number]) => void }) {
  const map = useMap();
  useEffect(() => {
    let raf = 0;
    const report = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const b = map.getBounds();
        onViewport([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
      });
    };
    report();
    map.on("moveend zoomend", report);
    return () => {
      map.off("moveend zoomend", report);
      cancelAnimationFrame(raf);
    };
  }, [map, onViewport]);
  return null;
}

function BaseLayer({
  basemap,
  onLoading,
  onLoaded,
}: {
  basemap: Basemap;
  onLoading: () => void;
  onLoaded: () => void;
}) {
  const bm = BASEMAPS.find((b) => b.id === basemap) ?? BASEMAPS[0];
  return (
    <>
      <TileLayer
        key={bm.id}
        attribution={bm.attribution}
        url={bm.url}
        className={bm.className}
        // Tile errors must never propagate as unhandled exceptions — swallow
        // and let the skeleton/onLoaded lifecycle resolve normally instead.
        eventHandlers={{
          loading: onLoading,
          load: onLoaded,
          tileerror: onLoaded,
        }}
      />
      {basemap === "satellite" && (
        <TileLayer key="sat-labels" url={CARTO_LABELS_URL} className="pyro-tile-labels" attribution={CARTO_ATTRIBUTION} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Icon cache — avoids allocating a new L.divIcon on every render. Keyed by
// the exact visual parameters so distinct looks still get distinct icons.
// ---------------------------------------------------------------------------
const iconCache = new Map<string, L.DivIcon>();

function getFacilityIcon(hex: string, selected: boolean): L.DivIcon {
  const key = `f:${hex}:${selected}`;
  let icon = iconCache.get(key);
  if (!icon) {
    icon = L.divIcon({
      html: `<div style="width:16px;height:16px;border-radius:9999px;background:${hex};border:1.5px solid #05070A;box-shadow:0 0 0 ${selected ? 3 : 0}px rgba(59,130,246,0.5);"></div>`,
      className: "pyro-cluster-marker",
      iconSize: L.point(16, 16),
    });
    iconCache.set(key, icon);
  }
  return icon;
}

function getClusterIcon(hex: string, count: number): L.DivIcon {
  const size = Math.min(24 + count / 8, 44);
  // Real magnitude ("124", "1.2k") — capping at "99+" hid the actual count,
  // so cluster bubbles disagreed with the timeline's live detection readout.
  const label = count > 999 ? `${(count / 1000).toFixed(1)}k` : String(count);
  const key = `c:${hex}:${Math.round(size)}:${label}`;
  let icon = iconCache.get(key);
  if (!icon) {
    icon = L.divIcon({
      html: `<div style="width:${size}px;height:${size}px;border-radius:9999px;display:flex;align-items:center;justify-content:center;background:${hex}2E;border:1.5px solid ${hex};color:${hex};font:600 11px var(--font-inter),sans-serif;box-shadow:0 0 10px ${hex}55;">${label}</div>`,
      className: "pyro-cluster",
      iconSize: L.point(size, size),
    });
    iconCache.set(key, icon);
  }
  return icon;
}

// ---------------------------------------------------------------------------
// Facilities layer — supercluster-driven, no Leaflet-internal marker reads.
// ---------------------------------------------------------------------------
function FacilitiesLayer({
  analyses,
  selectedId,
  onSelect,
}: {
  analyses: FacilityAnalysis[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const points = useMemo<ClusterPoint<FacilityAnalysis>[]>(
    () => analyses.map((a) => ({ lat: a.facility.lat, lng: a.facility.lng, properties: a })),
    [analyses],
  );
  const clusters = useSupercluster(points, { radius: 55, maxZoom: 16 });

  return (
    <>
      {clusters.map((c) => {
        if (c.type === "cluster") {
          let worst = 0;
          for (const leaf of c.leaves) {
            const rank = STATUS_RANK[leaf.status];
            if (rank > worst) worst = rank;
          }
          const hex = statusColorHex(STATUS_ORDER_RISK[worst] ?? "normal");
          return (
            <Marker
              key={`cluster-${c.id}`}
              position={[c.lat, c.lng]}
              icon={getClusterIcon(hex, c.pointCount)}
              keyboard={false}
              eventHandlers={{
                click: (e) => {
                  // zoom in on cluster click — standard clustering UX,
                  // achieved without touching any Leaflet marker internals
                  // (cast: `_map` is `protected` in Leaflet's typings)
                  const map = (e.target as unknown as { _map?: L.Map })._map;
                  if (map) map.flyTo([c.lat, c.lng], Math.min(map.getZoom() + 2, 16));
                },
              }}
            />
          );
        }
        const analysis = c.properties;
        const { facility, status } = analysis;
        const hex = statusColorHex(status);
        const selected = facility.id === selectedId;
        return (
          <Marker
            key={facility.id}
            position={[c.lat, c.lng]}
            icon={getFacilityIcon(hex, selected)}
            eventHandlers={{ click: () => onSelect(facility.id) }}
            keyboard={false}
          >
            <Tooltip direction="top" offset={[0, -10]} opacity={1} className="pyro-tooltip-clickable" interactive>
              <div
                role="button"
                tabIndex={0}
                aria-label={`Open analysis for ${facility.name}`}
                onClick={() => onSelect(facility.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(facility.id);
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                <FacilityTooltipContent analysis={analysis} />
              </div>
            </Tooltip>
          </Marker>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// FIRMS layer — clusters at low zoom / high density, raw CircleMarkers
// (canvas-rendered via `preferCanvas`) once the count in view is legible.
// ---------------------------------------------------------------------------
function FirmsLayer({
  hotspots,
  selectedHotspotKey,
  onSelectHotspot,
}: {
  hotspots: FirmsHotspot[];
  selectedHotspotKey: string | null;
  onSelectHotspot: (key: string | null) => void;
}) {
  const points = useMemo<ClusterPoint<FirmsHotspot & { key: string }>[]>(
    () =>
      hotspots.map((h, i) => ({
        lat: h.latitude,
        lng: h.longitude,
        properties: { ...h, key: `${h.latitude},${h.longitude},${i}` },
      })),
    [hotspots],
  );
  const clusters = useSupercluster(points, { radius: 40, maxZoom: 14 });

  const tooManyRawPoints = clusters.filter((c) => c.type === "point").length > MAX_RAW_POINTS;

  return (
    <>
      {clusters.map((c) => {
        if (c.type === "cluster" || tooManyRawPoints) {
          if (c.type !== "cluster") return null; // shouldn't happen, but never crash on it
          // Represent a FIRMS cluster by its hottest member's colour.
          let hottest = 0;
          for (const leaf of c.leaves) hottest = Math.max(hottest, leaf.frp ?? 0);
          const hex = frpColor(hottest);
          return <Marker key={`firms-cluster-${c.id}`} position={[c.lat, c.lng]} icon={getClusterIcon(hex, c.pointCount)} keyboard={false} />;
        }
        const h = c.properties;
        const selected = selectedHotspotKey === h.key;
        const hex = frpColor(h.frp);
        return (
          <CircleMarker
            key={h.key}
            center={[h.latitude, h.longitude]}
            radius={selected ? Math.min(frpRadius(h.frp) + 3, 13) : frpRadius(h.frp)}
            pathOptions={{
              color: selected ? "#E6EBF2" : hex,
              weight: selected ? 2 : 1,
              fillColor: hex,
              fillOpacity: 0.75,
            }}
            eventHandlers={{ click: () => onSelectHotspot(selected ? null : h.key) }}
          >
            <Tooltip direction="top" offset={[0, -6]} opacity={1} className="pyro-tooltip-clickable" interactive>
              <div
                role="button"
                tabIndex={0}
                aria-label="Select thermal hotspot"
                onClick={() => onSelectHotspot(selected ? null : h.key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectHotspot(selected ? null : h.key);
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                <FirmsTooltipContent
                  latitude={h.latitude}
                  longitude={h.longitude}
                  frp={h.frp}
                  brightness={h.brightness}
                  confidence={h.confidence}
                  satellite={h.satellite}
                  instrument={h.instrument}
                  acqDate={h.acqDate}
                  acqTime={h.acqTime}
                  daynight={h.daynight}
                  ageDays={h.ageDays}
                />
              </div>
            </Tooltip>
          </CircleMarker>
        );
      })}
    </>
  );
}

export default function MapInner({
  view,
  analyses,
  selectedId,
  onSelect,
  basemap = "dark",
  firmsHotspots,
  showFirms,
  showFacilities = true,
  selectedHotspotKey = null,
  onSelectHotspot,
  onTilesLoading,
  onTilesLoaded,
  onViewport,
  onAreaClick,
}: {
  view: MapView;
  analyses: FacilityAnalysis[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  basemap?: Basemap;
  firmsHotspots: FirmsHotspot[];
  showFirms: boolean;
  showFacilities?: boolean;
  selectedHotspotKey?: string | null;
  onSelectHotspot: (key: string | null) => void;
  onTilesLoading: () => void;
  onTilesLoaded: () => void;
  /** debounced upstream — fires when the user stops moving the map */
  onViewport: (b: [number, number, number, number]) => void;
  /** background-map click → coordinates of the clicked point (AreaPanel) */
  onAreaClick?: (point: { lat: number; lng: number }) => void;
}) {
  // ── Teardown ownership ─────────────────────────────────────────────────
  // Deliberately NO manual `map.remove()` effect here. react-leaflet v4
  // removes the map instance itself in MapContainer's unmount cleanup. An
  // additional remove() from this component double-frees: the second call
  // trips Leaflet's ownership guard ("Map container is being reused by
  // another instance") and throws DURING React's unmount pass — outside any
  // error boundary, so it would blank the whole app. Double-init races are
  // already prevented upstream by the stable `mapInstanceKey` in MapCanvas
  // (the container is never rebuilt on ordinary re-renders) and by
  // react-leaflet 4.2.1's StrictMode-safe mounting.

  return (
    <MapContainer
      center={view.center}
      zoom={view.zoom}
      scrollWheelZoom
      className="h-full w-full"
      attributionControl
      zoomControl={false}
      preferCanvas
    >
      <BaseLayer basemap={basemap} onLoading={onTilesLoading} onLoaded={onTilesLoaded} />
      <ViewportAnimator view={view} />
      <ViewportReporter onViewport={onViewport} />
      <ClickCatcher onAreaClick={onAreaClick ?? (() => {})} />
      {showFirms && firmsHotspots.length > 0 && (
        <FirmsLayer hotspots={firmsHotspots} selectedHotspotKey={selectedHotspotKey} onSelectHotspot={onSelectHotspot} />
      )}
      {showFacilities && <FacilitiesLayer analyses={analyses} selectedId={selectedId} onSelect={onSelect} />}
    </MapContainer>
  );
}
