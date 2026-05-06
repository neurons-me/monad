import express from "express";
import { getWeightReport } from "../kernel/adaptiveWeights.js";

/**
 * GET /.mesh/weights
 *
 * Returns the current globally learned scorer weights with change context
 * and runtime health signals.
 *
 * Response fields:
 * - `current`        — learned weights right now
 * - `defaults`       — hardcoded starting values
 * - `delta`          — current − defaults per scorer (positive = reinforced)
 * - `updateCount`    — total gradient steps applied since last reset
 * - `lastUpdatedAt`  — Unix ms timestamp of last update (null if never)
 * - `stable`         — true when all deltas are within 5% of defaults
 * - `health`         — runtime learning health signals (dominantScorer,
 *                      deadScorer, oscillation, noLearning)
 * - `namespace`      — optional namespace-local/blended weights when
 *                      `?namespace=...` is provided
 *
 * Example:
 *   curl http://localhost:8161/.mesh/weights
 *   curl "http://localhost:8161/.mesh/weights?namespace=suis-macbook-air.local"
 */
export function createMeshWeightsRouter(): express.Router {
  const router = express.Router();

  router.get("/.mesh/weights", (req, res) => {
    const namespace = String((req.query as any)?.namespace || "").trim();
    const report = getWeightReport(namespace || undefined);
    return res.json({
      ok: true,
      ...report,
      _hint: "delta = current − defaults. Positive: scorer reinforced by good outcomes. Negative: penalized by failures.",
    });
  });

  return router;
}
