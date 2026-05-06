import type { Server } from "node:http";
import { createMonadApp, type MonadApp } from "./app.js";
import { bootstrapMonad, type MonadBootstrapResult, type MonadLogger, type MonadOptions, type MonadRuntimeConfig } from "./bootstrap.js";
import type { SelfNodeConfig, SelfSurfaceCapacity, SelfSurfaceTrust, SelfSurfaceType } from "./http/selfMapping.js";
/**
 * Options for starting a complete monad.ai HTTP daemon.
 */
export interface StartMonadOptions extends MonadOptions {
    /** Disable periodic snapshot persistence when set to `false`. */
    setupPersistence?: boolean;
}
/**
 * Handles returned by {@link startMonad}.
 */
export interface StartMonadResult {
    app: MonadApp;
    server: Server;
    bootstrap: MonadBootstrapResult;
}
/**
 * Boots the monad runtime, creates the Express app, starts listening, and
 * schedules the local monad heartbeat.
 */
export declare function startMonad(options?: StartMonadOptions): Promise<StartMonadResult>;
export { createMonadApp, bootstrapMonad };
export { announceClaimedNamespaces, findMonadByName, findMonadByNameAsync, findMonadsForNamespace, findMonadsForNamespaceAsync, listMonadIndex, listMonadIndexAsync, readMonadIndexEntry, seedSelfMonadIndexEntry, touchSelfMonadLastSeen, writeMonadIndexEntry, type MonadIndexEntry, } from "./kernel/monadIndex.js";
export { DEFAULT_STALE_MS, matchesMeshSelector, selectMeshClaimant, type MeshRunnerUp, type MeshSelection, } from "./kernel/meshSelect.js";
export { DEFAULT_WEIGHTS, GLOBAL_BACKGROUND_SHARE, LEARNING_RATE, NAMESPACE_MATURITY_SAMPLES, WEIGHT_MIN, getWeightReport, readAdaptiveWeights, resolveAdaptiveWeights, updateAdaptiveWeights, type AdaptiveWeightUpdateOptions, type WeightHealth, type WeightReport, } from "./kernel/adaptiveWeights.js";
export { computeScore, computeScoreDetailed, readClaimMeta, recordForwardResult, writeClaimMeta, type ClaimMeta, type ScoreBreakdown, type Scorer, type ScorerBreakdown, type ScoringContext, type ScoringMode, } from "./kernel/scoring.js";
export { correlateOutcome, recordDecision, type DecisionEntry, } from "./kernel/decisionLog.js";
export { NRP_TEST_CATALOG, type NrpTestCatalogEntry, } from "./testing/nrpTestCatalog.js";
export type { MonadApp, MonadBootstrapResult, MonadLogger, MonadOptions, MonadRuntimeConfig, SelfNodeConfig, SelfSurfaceCapacity, SelfSurfaceTrust, SelfSurfaceType, };
