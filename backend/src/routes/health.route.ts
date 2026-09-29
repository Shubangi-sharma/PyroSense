import { Router, Request, Response } from "express";
import { getCoverage } from "../db/client.js";
import { getState } from "../db/client.js";

export const healthRouter = Router();

healthRouter.get("/", (_req: Request, res: Response) => {
  const coverage = getCoverage();
  res.status(200).json({
    status: "ok",
    uptimeSec: Math.round(process.uptime()),
    db: coverage,
    lastRefresh: getState("refresh:lastCompletedAt"),
    lastArchive: getState("archive:lastCompletedAt"),
    // Two facility-ingest paths write different state keys: the Overpass job
    // writes "facilities:lastCompletedAt", the user-dataset CSV seeder used
    // by bootstrapOnce writes "dataset:lastCompletedAt". Report whichever
    // ran last so first-paint CSV seeding is visible in /health.
    lastFacilityIngest:
      [getState("facilities:lastCompletedAt"), getState("dataset:lastCompletedAt")]
        .filter(Boolean)
        .sort()
        .pop() ?? null,
  });
});
