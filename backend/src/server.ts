/**
 * server.ts — entry point: starts the HTTP server and schedules cron jobs
 * (§1). Jobs live in jobs/ and are imported here, and only here.
 *
 * Post-refresh pipeline:
 *   refreshLive() → runMatchingJob() → updateFingerprints() → invalidateCaches
 */

import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { db, getAllFacilitiesMerged } from "./db/client.js";
import { refreshLive } from "./jobs/refreshLiveFirms.js";
import { runMatchingJob } from "./jobs/runMatching.js";
import { updateFingerprints } from "./services/fingerprintService.js";
import { triggerPipeline } from "./services/mlClient.js";
import { bootstrapOnce } from "./jobs/bootstrapOnce.js";
import cron from "node-cron";

const log = logger.child({ module: "server" });

const app = createApp();
app.set("log", logger);

/** Full pipeline: refresh → match → fingerprint. */
async function runPipeline(): Promise<void> {
  try {
    const refreshResult = await refreshLive();
    log.info({ inserted: refreshResult.inserted }, "refresh done, running matching");

    if (refreshResult.inserted > 0) {
      const matchResult = await runMatchingJob();
      log.info(matchResult, "matching done, updating fingerprints");

      const facilities = getAllFacilitiesMerged();
      if (facilities.length > 0) {
        // Only update fingerprints for facilities with recent activity to keep it fast
        const updated = updateFingerprints(facilities);
        log.info({ updated }, "fingerprints updated");
      }
    }
  } catch (err) {
    log.error({ err: String(err) }, "pipeline failed");
  }
}

// Fresh-deploy bootstrap: seed facilities + first refresh (fire-and-forget,
// never blocks the listen — see jobs/bootstrapOnce.ts).
bootstrapOnce();

const server = app.listen(env.PORT, "0.0.0.0", () => {
  log.info({ port: env.PORT, host: "0.0.0.0", cors: env.CORS_ORIGIN }, "PYROSENSE backend listening");

  // ── recurring jobs ────────────────────────────────────────────────────
  // Full pipeline every 15 minutes: refresh → match → fingerprint.
  cron.schedule("*/15 * * * *", () => {
    runPipeline().catch((err) => log.error({ err: String(err) }, "scheduled pipeline failed"));
  });
  log.info("scheduled full pipeline (refresh → match → fingerprint) every 15 minutes");

  // Phase 2C/3: nightly ML pipeline via pyrosense_ml (weather → H3 aggregate
  // → GRU risk → hotspot persistence). Node's node-cron stays the single
  // scheduler (PDF §2.2) — it just triggers FastAPI's batch endpoint now.
  // 02:30 IST-ish nightly; weather fetch lands rows up to the archive's ~6-day
  // lag, so days=10 covers the fill window.
  cron.schedule("30 21 * * *", () => {
    triggerPipeline(10).then((report) => {
      if (report) log.info({ report }, "ML pipeline triggered");
      else log.error("ML pipeline trigger failed (breaker or transport)");
    });
  });
  log.info("scheduled ML pipeline trigger (pyrosense_ml) nightly at 21:30 UTC");
});

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "shutting down");
  server.close(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  });
  // Force-exit if close hangs (open keep-alive sockets, etc.)
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    log.error(
      { port: env.PORT },
      `Port ${env.PORT} is already in use — stop the other process or set PORT to a free port in backend/.env`,
    );
  } else {
    log.error({ err: String(err) }, "server error");
  }
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error({ reason: String(reason) }, "unhandled rejection");
});
process.on("uncaughtException", (err) => {
  "use strict";
  log.error({ err: String(err) }, "uncaught exception — exiting");
  process.exit(1);
});

