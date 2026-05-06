import type { MonadIndexEntry } from "./monadIndex.js";
/**
 * Open claim metadata stored under `_.mesh.monads.<id>.claimed.<namespace>`.
 *
 * This is intentionally an open schema. The built-in scorers read common fields
 * such as `effectiveResonance` and `avgLatencyMs`, while custom scorers may read
 * any additional field the `.me` tree learns over time.
 */
export type ClaimMeta = Record<string, unknown>;
/**
 * Controls how scorer weights are interpreted.
 *
 * - `normalized`: production default; weights are divided by their sum, so
 *   totals stay in `[0, 1]`.
 * - `raw`: experimental/debug mode; weights are used as provided and totals may
 *   exceed `1`.
 */
export type ScoringMode = "normalized" | "raw";
/**
 * Per-request context supplied to scoring.
 *
 * `namespace` and `requestedAt` make scoring deterministic for a request. Future
 * scorers may also use `pathPrefix` for workload-specific policy.
 */
export type ScoringContext = {
    namespace: string;
    requestedAt: number;
    pathPrefix?: string;
    mode?: ScoringMode;
    /**
     * Globally learned scorer weights (Phase 7).
     *
     * Injected by `selectMeshClaimant` from `_.mesh.adaptiveWeights`. Overrides
     * `scorer.defaultWeight` but yields to per-claim `_weight_<name>` values.
     *
     * Weight resolution order (highest priority first):
     *   1. `meta._weight_<name>` — per-claim explicit override
     *   2. `ctx.adaptiveWeights[name]` — this field (online-learned prior)
     *   3. `scorer.defaultWeight` — hardcoded fallback
     */
    adaptiveWeights?: Record<string, number>;
};
/**
 * A pluggable scorer in the mesh decision pipeline.
 *
 * Scorers should return a value in `[0, 1]`. The engine clamps invalid or
 * out-of-range values, so custom scorers cannot corrupt normalized mode.
 */
export type Scorer = {
    name: string;
    defaultWeight: number;
    fn: (m: MonadIndexEntry, meta: ClaimMeta, ctx: ScoringContext) => number;
};
/**
 * Reads the open `.me` claim metadata for a monad/namespace pair.
 *
 * Returns `{}` when no metadata has been learned yet.
 */
export declare function readClaimMeta(monadId: string, namespace: string): ClaimMeta;
/**
 * Merges a patch into the open claim metadata subtree.
 *
 * Existing fields are preserved unless overwritten by the patch. This keeps the
 * schema extensible while letting the bridge update operational metrics.
 */
export declare function writeClaimMeta(monadId: string, namespace: string, patch: ClaimMeta): void;
/**
 * Records the outcome of a forwarded mesh request.
 *
 * This is the learning loop. It updates:
 * - decayed `resonance`
 * - failure-penalized `effectiveResonance`
 * - EWMA `avgLatencyMs`
 * - forward/failure counters
 */
export declare function recordForwardResult(monadId: string, namespace: string, elapsedMs: number, ok: boolean): void;
export declare const BUILT_IN_SCORERS: Scorer[];
/** Per-scorer explanation emitted by {@link computeScoreDetailed}. */
export type ScorerBreakdown = {
    value: number;
    weight: number;
    contribution: number;
};
/** Full scoring explanation for one claimant. */
export type ScoreBreakdown = {
    total: number;
    mode: ScoringMode;
    breakdown: Record<string, ScorerBreakdown>;
};
/**
 * Computes a claimant score and returns a full per-scorer explanation.
 *
 * This is the primary implementation. {@link computeScore} delegates here, so
 * the score and introspection path can never drift apart.
 *
 * Contracts in normalized mode:
 * - `total` is always in `[0, 1]`
 * - same inputs produce the same output
 * - NaN/Infinity never propagate
 * - scaling every weight by the same constant does not change the result
 */
export declare function computeScoreDetailed(m: MonadIndexEntry, meta: ClaimMeta, ctx: ScoringContext, extraScorers?: Scorer[]): ScoreBreakdown;
/**
 * Computes only the normalized score for a claimant.
 *
 * Use {@link computeScoreDetailed} when debugging or logging why a monad won.
 */
export declare function computeScore(m: MonadIndexEntry, meta: ClaimMeta, ctx: ScoringContext, extraScorers?: Scorer[]): number;
