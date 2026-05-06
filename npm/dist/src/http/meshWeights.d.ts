import express from "express";
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
export declare function createMeshWeightsRouter(): express.Router;
