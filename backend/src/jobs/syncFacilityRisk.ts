/**
 * syncFacilityRiskJob — pull the per-facility cached Risk Score components
 * (environment + temporal) from pyrosense_ml and upsert them into
 * facility_risk_cache.
 *
 * Direction: Node PUSHES its exact facility set (getAllFacilitiesMerged() —
 * the same facility list every downstream stage tracks) to
 * pyrosense_ml's POST /internal/facility-risk/sync. The facility-set
 * mismatch worry is structurally resolved: the ML service never derives its
 * own facility list, it answers for exactly the ids Node sends.
 *
 * Schedule: daily at 22:15 UTC — 45 min after the 21:30 UTC pipeline trigger
 * that recomputes risk_predictions (the temporal component's source), so the
 * sync reads freshly-written predictions.
 *
 * Failure is non-fatal by design: the breaker-protected client returns null
 * and the previous cache row (with its computed_at) keeps serving — bulk
 * views stay degraded-but-labeled, never broken.
 */

import { getAllFacilitiesMerged, upsertFacilityRiskCache, tx } from "../db/client.js";
import { syncFacilityRisk } from "../services/mlClient.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ module: "jobs.syncFacilityRisk" });

export async function runFacilityRiskSync(): Promise<{ synced: number } | null> {
  const facilities = getAllFacilitiesMerged();
  if (facilities.length === 0) return null;

  const result = await syncFacilityRisk(
    facilities.map((f) => ({ id: f.id, lat: f.lat, lng: f.lng })),
  );
  if (!result) {
    log.warn("facility-risk sync failed (ML service unavailable or breaker open)");
    return null;
  }

  tx(() => {
    for (const r of result.rows) {
      upsertFacilityRiskCache({
        facility_id: r.facility_id,
        environment_signal: r.environment_signal,
        temporal_signal: r.temporal_signal,
        temporal_source: r.temporal_source,
        computed_at: r.computed_at,
      });
    }
  });

  log.info({ synced: result.synced }, "facility-risk components synced");
  return { synced: result.synced };
}
