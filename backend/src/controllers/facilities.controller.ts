/**
 * facilities.controller — facility list + computed analyses (§7 API shape).
 *
 * The facility list comes from the DB (Overpass is ingestion-only).
 * Analyses are computed per region + time window and served through the
 * analysis cache, so the frontend never pulls the entire dataset in one
 * response — it always asks for a region/time window (§6).
 */

import { Request, Response } from "express";
import { LIVE_WINDOW_DAYS } from "../config/regions.js";
import { FacilityRow, getAllFacilities, getAllFacilitiesMerged } from "../db/client.js";
import { cacheKeys, getAnalysesCached, getFacilitiesCached } from "../services/cacheService.js";
import { analyzeAllFacilities, analyzeFacility, predictedFireTag } from "../services/analysisService.js";
import { isValidBbox } from "../services/overpassClient.js";
import { proxyObservations } from "../services/mlProxyService.js";
import type { FireTagEnvironment, FireTagWeather } from "../services/fireTagService.js";

const json = (res: Response, code: number, body: unknown): void => {
  res.status(code).json(body);
};

/** GET /api/facilities?bbox=w,s,e,n — facilities inside an optional bbox. */
export function getFacilities(req: Request, res: Response): void {
  const bbox = (req.query.bbox as string | undefined) ?? "";
  if (bbox && !isValidBbox(bbox)) {
    json(res, 400, { error: "bbox must be west,south,east,north as numbers" });
    return;
  }

  const facilities = getFacilitiesCached(() => getAllFacilitiesMerged()) as FacilityRow[];
  let out = facilities;

  if (bbox) {
    const [w, s, e, n] = bbox.split(",").map(Number);
    if ([w, s, e, n].every((v) => Number.isFinite(v))) {
      out = facilities.filter(
        (f) => f.lat >= s! && f.lat <= n! && f.lng >= w! && f.lng <= e!,
      );
    }
  }

  json(res, 200, { facilities: out, count: out.length });
}

/** GET /api/analyses?bbox=&from=&to= — classified facilities for a window. */
export async function getAnalyses(req: Request, res: Response): Promise<void> {
  const bbox = (req.query.bbox as string | undefined) ?? "";
  if (bbox && !isValidBbox(bbox)) {
    json(res, 400, { error: "bbox must be west,south,east,north as numbers" });
    return;
  }
  const from = (req.query.from as string | undefined) ?? "0001-01-01";
  const to = (req.query.to as string | undefined) ?? "9999-12-31";

  const key = cacheKeys.analyses(bbox || "all", from, to);
  const analyses = await getAnalysesCached(key, () => {
    const [w, s, e, n] = bbox ? bbox.split(",").map(Number) : [];
    const bboxObj =
      bbox && [w, s, e, n].every((v) => Number.isFinite(v))
        ? { west: w!, south: s!, east: e!, north: n! }
        : undefined;
    return analyzeAllFacilities(new Date(), bboxObj);
  });

  // Same contract as the firms CSV route: the browser may reuse the response
  // for 5 minutes, so showcase page-to-page navigations hit the network only
  // when SWR's own revalidation actually needs data. The TTL mirrors the
  // analysis cache; ingestion invalidation keeps it correct server-side.
  res.setHeader("Cache-Control", "public, max-age=300");
  json(res, 200, {
    analyses,
    count: analyses.length,
    window: { live: LIVE_WINDOW_DAYS, from, to },
  });
}

/**
 * GET /api/facilities/:id/analyses — full classification + narrative for one.
 *
 * The Predicted Fire Type is ENRICHED with live environment observations
 * (land cover + surroundings from the ML service's feature modules) — the
 * environment often decides between e.g. "agricultural burn" and
 * "industrial incident" near an untagged "Industrial Site #…". Failure of
 * the ML service is non-fatal: the tag falls back to fire-physics evidence
 * and the response notes the degradation. The unified Risk Score composes
 * in the same non-fatal style (missing signal → renormalize).
 */
export async function getFacilityAnalysis(req: Request, res: Response): Promise<void> {
  const id = req.params.id;
  const facility = getAllFacilitiesMerged().find((f) => f.id === id);
  if (!facility) {
    json(res, 404, { error: `Facility not found: ${id}` });
    return;
  }

  // Risk composition (live ML calls inside) and environment enrichment run
  // in PARALLEL lanes — both hit pyrosense_ml, and sequential awaiting would
  // double the detail page's ML latency for no benefit.
  const [analysis, enrichment] = await Promise.all([
    analyzeFacility(facility, new Date()),
    (async (): Promise<{
      environment: FireTagEnvironment | null;
      weather: FireTagWeather | null;
      tagProvenance: "ml_observations" | "fire_physics_only";
    }> => {
      let environment: FireTagEnvironment | null = null;
      let weather: FireTagWeather | null = null;
      let tagProvenance: "ml_observations" | "fire_physics_only" = "fire_physics_only";
      try {
        const { status, body } = await proxyObservations(facility.lat, facility.lng);
        if (status === 200 && body && typeof body === "object") {
          const obs = body as {
            land_cover?: { ratios?: Record<string, number | null>; dominant?: string | null; vegetation_ratio?: number | null; provenance?: string };
            surroundings?: { distances_km?: Record<string, number | null>; proximity_flags?: Record<string, boolean | null>; provenance?: string };
            weather?: {
              mean_temperature_c?: number | null;
              max_temperature_c?: number | null;
              mean_relative_humidity?: number | null;
              min_relative_humidity?: number | null;
              mean_wind_speed_ms?: number | null;
              max_wind_speed_ms?: number | null;
              total_precipitation?: number | null;
              provenance?: string;
            };
          };
          const lcProv = obs.land_cover?.provenance;
          const sProv = obs.surroundings?.provenance;
          const wProv = obs.weather?.provenance;
          const degraded = lcProv === "unavailable" && sProv === "unavailable";
          if (!degraded) {
            environment = {
              landCover: obs.land_cover?.ratios,
              dominantLandCover: obs.land_cover?.dominant ?? null,
              vegetationRatio: obs.land_cover?.vegetation_ratio ?? null,
              distancesKm: obs.surroundings?.distances_km,
              proximityFlags: obs.surroundings?.proximity_flags,
              degraded,
            };
            tagProvenance = "ml_observations";
          }
          // Weather feeds the tag whenever the ML service returned ANY weather
          // provenance (open-meteo / forecast / cache) — null fields inside are
          // handled per-feature by the scorer.
          if (wProv && wProv !== "unavailable") {
            const w = obs.weather ?? {};
            weather = {
              meanTemperatureC: w.mean_temperature_c ?? null,
              maxTemperatureC: w.max_temperature_c ?? null,
              meanRelativeHumidity: w.mean_relative_humidity ?? null,
              minRelativeHumidity: w.min_relative_humidity ?? null,
              meanWindSpeedMs: w.mean_wind_speed_ms ?? null,
              maxWindSpeedMs: w.max_wind_speed_ms ?? null,
              totalPrecipitation: w.total_precipitation ?? null,
            };
            if (tagProvenance === "fire_physics_only") tagProvenance = "ml_observations";
          }
        }
      } catch {
        // ML service unreachable — tag stays fire-physics-only (honest fallback).
      }
      return { environment, weather, tagProvenance };
    })(),
  ]);

  const { classification, narrative, persistence, fireCharacteristics, predictedTag, riskScore } = analysis;
  const { environment, weather, tagProvenance } = enrichment;

  const enrichedTag = predictedFireTag(facility, classification, environment, weather, fireCharacteristics.latestBrightnessK);

  json(res, 200, {
    facility,
    classification,
    narrative: {
      whatChanged: narrative.whatChanged,
      timeline: narrative.timeline,
      templatedSummary: narrative.templatedSummary,
      classification: narrative.classification,
      classificationLabel: narrative.classificationLabel,
      riskScore: {
        riskScore: riskScore.riskScore,
        riskScoreProvenance: riskScore.riskScoreProvenance,
        riskScoreComputedAt: riskScore.computedAt,
        riskScoreLive: riskScore.live,
      },
    },
    // Unified Risk Score (live detail path) — surfaced at top level too so
    // clients never re-derive it from the classification object.
    riskScore: {
      riskScore: riskScore.riskScore,
      riskScoreProvenance: riskScore.riskScoreProvenance,
      riskScoreComputedAt: riskScore.computedAt,
      riskScoreLive: riskScore.live,
    },
    // PDF §4 field groups computed from the stored FIRMS archive.
    persistence,
    fireCharacteristics,
    // Contextual predicted fire type (environment-enriched when available).
    predictedTag: {
      tag: enrichedTag.tag,
      confidence: enrichedTag.confidence,
      reasons: enrichedTag.reasons,
      provenance: tagProvenance,
    },
  });
}
