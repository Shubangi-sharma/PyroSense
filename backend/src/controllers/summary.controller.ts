/**
 * summary.controller — GET /api/facilities/:id/summary
 *
 * Computes the real facts, then asks genaiService for a grounded summary.
 * Response always names the provider that actually served the text
 * ("openrouter" | "template") for debugging (§5).
 */

import { Request, Response } from "express";
import { getAllFacilitiesMerged } from "../db/client.js";
import { analyzeFacility } from "../services/analysisService.js";
import { generateSummary } from "../services/genaiService.js";
import { hasAiProvider } from "../config/env.js";

export async function getSummary(req: Request, res: Response): Promise<void> {
  const id = req.params.id;
  const facility = getAllFacilitiesMerged().find((f) => f.id === id);
  if (!facility) {
    res.status(404).json({ error: `Facility not found: ${id}` });
    return;
  }

  try {
    const { facts, narrative } = await analyzeFacility(facility, new Date());

    // With no AI provider configured, the templated summary IS the product.
    if (!hasAiProvider()) {
      res.status(200).json({ facilityId: id, text: narrative.templatedSummary, provider: "template" });
      return;
    }

    const { text, provider, factsHash } = await generateSummary(facts, narrative.templatedSummary);
    res.status(200).json({ facilityId: id, text, provider, factsHash });
  } catch (err) {
    // Graceful degradation (§6): the endpoint never errors where a summary
    // should be — worst case it serves the deterministic template.
    req.app.get("log")?.warn({ err: String(err), facilityId: id }, "summary generation failed; serving template");
    const { narrative } = await analyzeFacility(facility, new Date());
    res.status(200).json({ facilityId: id, text: narrative.templatedSummary, provider: "template" });
  }
}
