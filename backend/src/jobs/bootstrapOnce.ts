/**
 * bootstrapOnce — run-once startup bootstrap for FRESH deploys.
 *
 * A newly deployed backend starts with an empty SQLite file: no facilities,
 * no detections, so every dashboard surface renders zeroes until the 15-min
 * cron happens to land (and facility ingestion NEVER runs — it is a manual
 * CLI job, not scheduled). This module fixes first-paint emptiness:
 *
 *   1. user_facilities empty + seed CSV shipped in the image → ingest it.
 *   2. firms_detections empty → run one live FIRMS refresh + matching now.
 *
 * It never blocks server start (server.ts fires it without awaiting) and
 * never runs twice per process. Failures are logged, not thrown — the
 * scheduled pipeline is the safety net.
 */

import fs from "node:fs";
import path from "node:path";
import { db, getAllUserFacilities, getCoverage } from "../db/client.js";
import { ingestUserDataset } from "./ingestUserDataset.js";
import { refreshLive } from "./refreshLiveFirms.js";
import { runMatchingJob } from "./runMatching.js";
import { ingestLog as log } from "../lib/logger.js";

let started = false;

export function bootstrapOnce(): void {
  if (started) return;
  started = true;

  void (async () => {
    // 1. Seed the facility master list when the table is empty.
    if (getAllUserFacilities().length === 0) {
      const csvPath = path.resolve(process.cwd(), "data/user_facilities.csv");
      if (fs.existsSync(csvPath)) {
        try {
          await ingestUserDataset();
          log.info({ rows: getAllUserFacilities().length }, "bootstrap: user facilities seeded");
        } catch (err) {
          log.error({ err: String(err) }, "bootstrap: user facility seeding failed");
        }
      } else {
        log.warn({ csvPath }, "bootstrap: no facilities in DB and seed CSV missing");
      }
    }

    // 2. First FIRMS refresh so the map/dashboard has detections on arrival.
    const coverage = getCoverage();
    if (coverage.rows === 0) {
      try {
        const { inserted } = await refreshLive();
        log.info({ inserted }, "bootstrap: first live refresh done");
        if (inserted > 0) {
          const matchResult = await runMatchingJob();
          log.info(matchResult, "bootstrap: first matching done");
        }
      } catch (err) {
        log.error({ err: String(err) }, "bootstrap: first refresh failed (15-min cron will retry)");
      }
    } else {
      log.info({ rows: coverage.rows }, "bootstrap: detections already present — skipping seed refresh");
    }
  })();
}

// Re-exported read so server.ts can log what bootstrap found without
// touching db/ internals directly.
export { db };
