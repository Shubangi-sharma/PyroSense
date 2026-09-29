/**
 * v1.route — public-facing BFF routes over the pyrosense_ml internal API.
 *
 * Versioned (Phase 3 §3.2) so the frontend rewrite and any future model swap
 * don't have to happen in lockstep. All responses carry a `meta` block with
 * data_timestamp + versions (Phase 3 §3.3 contract discipline) — the
 * frontend legend shows "as of <data_timestamp>" instead of implying live
 * certainty.
 *
 * Degradation contract: when pyrosense_ml is unreachable (breaker open), a
 * cached response is served with meta.stale=true; with no cache, 503 with a
 * structured error — the map degrades to stale-but-labeled, never hangs.
 */

import { Router } from "express";
import express from "express";
import { LRUCache } from "lru-cache";
import h3 from "h3-js";
import { z } from "zod";
import {
  fetchCellRisk,
  fetchHotspots,
  fetchRiskBatch,
  lastGood,
  rememberGood,
  triggerPipeline,
  type MlHotspotSummary,
} from "../services/mlClient.js";
import { computeHotspotRiskScore } from "../services/riskScoreService.js";
import { httpLog } from "../lib/logger.js";

export const v1Router = Router();

/* ── LRU: viewport risk tiles + hotspot lists ──────────────────────────── */

const riskTileCache = new LRUCache<string, object>({ max: 500, ttl: 1000 * 60 * 5 });
const hotspotCache = new LRUCache<string, object>({ max: 200, ttl: 1000 * 60 * 2 });

function bboxHash(bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number }): string {
  return [bbox.minLat, bbox.minLng, bbox.maxLat, bbox.maxLng].map((v) => v.toFixed(2)).join(",");
}

/* ── Request schemas (Node→client boundary) ────────────────────────────── */

const BboxSchema = z.object({
  minLat: z.coerce.number().finite().gte(-90).lte(90),
  maxLat: z.coerce.number().finite().gte(-90).lte(90),
  minLng: z.coerce.number().finite().gte(-180).lte(180),
  maxLng: z.coerce.number().finite().gte(-180).lte(180),
});

const RiskQuerySchema = BboxSchema.extend({
  h3Cells: z.string().optional(), // comma-separated; overrides bbox when present
  zoomBucket: z.coerce.number().int().min(0).max(22).optional(),
});

const HotspotsQuerySchema = BboxSchema.partial().extend({
  type: z.string().optional(),
  persistent: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(20000).optional(),
});

/* ── Helpers ───────────────────────────────────────────────────────────── */

function meta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data_timestamp: new Date().toISOString(),
    stale: false,
    ...extra,
  };
}

function degrade(res: import("express").Response, cachePrefix: string, key: string): void {
  const good = lastGood(cachePrefix, key);
  if (good) {
    res.status(200).json({
      ...(good.body as object),
      meta: { ...meta(), stale: true, age_ms: good.ageMs },
    });
  } else {
    res.status(503).json({
      error: "ML service unavailable — no cached data for this area",
      meta: meta(),
    });
  }
}

/* ── GET /api/v1/risk?bbox=... | h3Cells=a,b,c ─────────────────────────── */

v1Router.get("/api/v1/risk", async (req, res) => {
  const parsed = RiskQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid bbox/h3Cells query", issues: parsed.error.issues });
    return;
  }
  const { h3Cells, ...bbox } = parsed.data;

  let cells: string[];
  if (h3Cells) {
    cells = h3Cells.split(",").map((c) => c.trim()).filter(Boolean);
  } else {
    // Server-side H3 filling of the viewport: derive the cells from the bbox
    // at res-7. Import lazily so the route module stays light.
    const h3 = await import("h3-js");
    const cellsSet = new Set<string>();
    const ring: number[][] = [
      [bbox.minLng, bbox.minLat],
      [bbox.maxLng, bbox.minLat],
      [bbox.maxLng, bbox.maxLat],
      [bbox.minLng, bbox.maxLat],
      [bbox.minLng, bbox.minLat],
    ];
    for (const c of h3.polygonToCells(ring as unknown as number[][][], 7)) cellsSet.add(c);
    cells = [...cellsSet];
  }

  if (cells.length === 0) {
    res.json({ risks: {}, missing: [], meta: meta() });
    return;
  }
  if (cells.length > 5000) {
    res.status(413).json({ error: `viewport too large: ${cells.length} cells (max 5000)` });
    return;
  }

  const cacheKey = `risk:${bboxHash(bbox)}:${h3Cells ? "cells" : `z${parsed.data.zoomBucket ?? "auto"}`}`;
  const cached = riskTileCache.get(cacheKey);
  if (cached) {
    res.json({ ...(cached as object), meta: { ...(meta() as object), cached: true } });
    return;
  }

  const result = await fetchRiskBatch(cells);
  if (!result) {
    degrade(res, "riskTile", cacheKey);
    return;
  }

  const body = {
    risks: result.risks,
    missing: result.missing,
    meta: meta({ model_version: Object.values(result.risks)[0]?.model_version ?? null }),
  };
  rememberGood("riskTile", cacheKey, body);
  riskTileCache.set(cacheKey, body);
  res.json(body);
});

/* ── GET /api/v1/hotspots?bbox=...&type=...&persistent=true ────────────── */

v1Router.get("/api/v1/hotspots", async (req, res) => {
  const parsed = HotspotsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid query", issues: parsed.error.issues });
    return;
  }
  const { type, persistent, limit, ...bbox } = parsed.data;

  const cacheKey = `hotspots:${JSON.stringify(parsed.data)}`;
  const cached = hotspotCache.get(cacheKey);
  if (cached) {
    res.json({ ...(cached as object), meta: { ...(meta() as object), cached: true } });
    return;
  }

  const ml = await fetchHotspots({
    minLat: bbox.minLat,
    maxLat: bbox.maxLat,
    minLng: bbox.minLng,
    maxLng: bbox.maxLng,
    type,
    persistent: persistent === undefined ? undefined : persistent === "true",
    limit,
  });

  if (!ml) {
    degrade(res, "hotspots", cacheKey);
    return;
  }

  // Contract: every hotspot carries the contextual-label caveat flag the UI
  // must surface (PDF caveat #1) plus the Needs Review path.
  const hotspots = ml.hotspots.map((h: MlHotspotSummary) => ({
    ...h,
    contextual_note:
      "Context-derived classification — not an independent ignition cause",
  }));

  const body = {
    count: hotspots.length,
    hotspots,
    classes: ml.classes,
    meta: meta({ model_version: ml.model_version, feature_schema_version: ml.feature_schema_version }),
  };
  rememberGood("hotspots", cacheKey, body);
  hotspotCache.set(cacheKey, body);
  res.json(body);
});

/* ── POST /api/v1/pipeline/run — ops handle (Node cron nightly; manual) ─── */

v1Router.post("/api/v1/pipeline/run", express.json({ limit: "8kb" }), async (req, res) => {
  // Long-running by design: ingest → weather → aggregate → risk → hotspots.
  // Raise the socket ceiling above mlClient's 600 s pipeline budget.
  req.socket.setTimeout(600_000);
  const days = Math.min(Math.max(Number(req.body?.days) || 10, 1), 30);
  const report = await triggerPipeline(days);
  if (!report) {
    res.status(502).json({ error: "ML pipeline failed or ML service unavailable", meta: meta() });
    return;
  }
  res.json({ report, meta: meta() });
});

/* ── GET /api/v1/risk-score?lat=…&lng=… — unified Risk Score for a point ── */
/**
 * The unified Risk Score for an arbitrary point (hotspot views): base(FRP
 * anomalies near the point via classifyFromDetections) + environment(live
 * classification risk) + temporal(stored GRU prediction for the H3-r7 cell).
 * An unregistered hotspot has no facility detection history, so its base
 * component is legitimately thin — the UI labels this case (§2.6 of
 * docs/RISK_SCORE_UNIFICATION.md).
 */
v1Router.get("/api/v1/risk-score", async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    res.status(400).json({ error: "lat and lng are required as finite numbers" });
    return;
  }

  // Hotspot composition: environment + temporal only — an unregistered
  // point has no facility detection history to anchor a base signal (§2.6).
  const risk = await computeHotspotRiskScore(lat, lng);

  res.json({
    latitude: lat,
    longitude: lng,
    h3_cell: h3.latLngToCell(lat, lng, 7),
    ...risk,
    scope: "hotspot",
    meta: meta(),
  });
});

/* ── GET /api/v1/cells/:h3 — one cell: hotspots + 1/3/7-day risk + overall ── */

v1Router.get("/api/v1/cells/:h3", async (req, res) => {
  const h3Cell = req.params.h3;
  if (!/^[0-9a-f]+$/i.test(h3Cell) || h3Cell.length < 10) {
    res.status(400).json({ error: "invalid H3 cell id" });
    return;
  }

  const cacheKey = `cell:${h3Cell}`;
  const cached = hotspotCache.get(cacheKey);
  if (cached) {
    res.json({ ...(cached as object), meta: { ...(meta() as object), cached: true } });
    return;
  }

  // Fetch cell risk + nearby hotspots in the same pass (parallel lanes).
  // Hotspots are narrowed to the cell's own bbox (h3.cellToBoundary) so a
  // single-cell request no longer scans/returns up to 50 hotspots worldwide.
  const h3 = await import("h3-js");
  const boundary = h3.cellToBoundary(h3Cell);
  const lats = boundary.map((p) => p[0]);
  const lngs = boundary.map((p) => p[1]);
  const [risk, hotspots] = await Promise.all([
    fetchCellRisk(h3Cell),
    fetchHotspots({
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLng: Math.min(...lngs),
      maxLng: Math.max(...lngs),
      limit: 50,
    }),
  ]);

  if (!risk && !hotspots) {
    degrade(res, "cell", cacheKey);
    return;
  }

  const body = {
    h3_cell: h3Cell,
    risk:
      risk === null
        ? { status: "unavailable", note: "ML service unavailable or no stored prediction" }
        : { status: risk.status, horizons: risk.horizons, overall: risk.overall, data_timestamp: risk.data_timestamp },
    hotspots: hotspots?.hotspots ?? [],
    classes: hotspots?.classes ?? [],
    meta: meta(),
  };
  rememberGood("cell", cacheKey, body);
  hotspotCache.set(cacheKey, body);
  res.json(body);
});
