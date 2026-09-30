/**
 * app.ts — Express application assembly (§1).
 *
 * Order matters: compression → CORS → request logger → rate limiters →
 * routes → 404 → centralized error handler. Nothing here starts a server
 * or a timer; that is server.ts's job (tests can import app.ts alone).
 */

import express, { Express } from "express";
import compression from "compression";
import cors from "cors";
import { env, isOriginAllowed } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { apiLimiter } from "./middleware/rateLimiter.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { facilitiesRouter } from "./routes/facilities.route.js";
import { analysesRouter } from "./routes/analyses.route.js";
import { firmsRouter } from "./routes/firms.route.js";
import { summaryRouter } from "./routes/summary.route.js";
import { healthRouter } from "./routes/health.route.js";
import { chatRouter } from "./routes/chat.route.js";
import { commandRouter } from "./routes/command.route.js";
import { predictRouter } from "./routes/predict.route.js";
import { v1Router } from "./routes/v1.route.js";
import helmet from "helmet";

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.set("x-powered-by", false);
  app.disable("etag");

  app.use(compression());
  app.use(
    cors({
      // Reflect the request origin when it matches an allowed pattern
      // (localhost/127.0.0.1/LAN-IP on any port by default) — so the frontend
      // keeps working no matter which port the dev server lands on.
      origin: (origin, cb) => cb(null, isOriginAllowed(origin) ? origin : false),
      methods: ["GET", "POST"],
      credentials: false,
    }),
  );
  app.use(requestLogger);
  app.use("/api", apiLimiter);

  app.use("/api/facilities", facilitiesRouter);
  app.use("/api/analyses", analysesRouter);
  app.use("/api/firms", firmsRouter);
  app.use("/api/facilities", summaryRouter); // mounts GET /api/facilities/:id/summary
  app.use("/api/chat", chatRouter);
  app.use("/api/command", commandRouter);
  app.use("/health", healthRouter);
  // Pass-through proxy to the pyrosense_ml service (predict + ml read APIs).
  // Mounted with full paths so the shared /api rate limiter does NOT apply
  // twice; the predict route carries its own tighter bucket.
  app.use(predictRouter);
  // Phase 3: versioned BFF routes over pyrosense_ml's internal API
  // (risk/hotspots/cells). Same reasoning: full paths, own rate bucket via
  // the shared /api limiter applying once here.
  app.use(v1Router);

  // Root identity probe — nicer for uptime monitors than a bare 404.
  app.get("/", (_req, res) => {
    res.json({ service: "pyrosense-2aif", status: "ok" });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

