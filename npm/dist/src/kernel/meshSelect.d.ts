import { type MonadIndexEntry } from "./monadIndex.js";
import { type ScoreBreakdown, type Scorer } from "./scoring.js";
export declare const DEFAULT_STALE_MS = 300000;
/**
 * The second-best claimant observed during a mesh selection pass.
 *
 * Capturing this in the same O(N) scan lets the bridge log winner/runner-up
 * margin without recomputing scores.
 */
export type MeshRunnerUp = {
    entry: MonadIndexEntry;
    score: number;
    breakdown: ScoreBreakdown;
};
/**
 * Result of selecting a monad for a namespace.
 *
 * `mesh-claim` means the highest-scored eligible claimant won. `exploration`
 * means the decision margin was low and the runner-up was intentionally tried
 * to gather comparative feedback. `name-selector` means the caller bypassed
 * scoring by asking for a specific monad.
 */
export type MeshSelection = {
    entry: MonadIndexEntry;
    reason: "name-selector" | "mesh-claim" | "exploration";
    score?: number;
    breakdown?: ScoreBreakdown;
    runnerUp?: MeshRunnerUp;
};
/**
 * Tests whether a monad entry satisfies a selector constraint.
 *
 * The selector uses the same DNF grammar as self mapping:
 * `device:macbook|host:edge;tag:primary`. Empty selectors always match.
 */
export declare function matchesMeshSelector(entry: MonadIndexEntry, selectorRaw: string | null): boolean;
/**
 * Scope-chain selection for `monad[frank]` path syntax.
 *
 * Traversal order for monadId="frank" in namespace="suign.cleaker.me":
 *   1. frank claiming exact namespace  (suign.cleaker.me)
 *   2. frank claiming rootspace        (cleaker.me)
 *   3. null → 404
 *
 * Backward-compatible: absent scope_path on old entries is treated as "/".
 */
export declare function selectMeshClaimantByScope(opts: {
    monadId: string;
    namespace: string;
    selfEndpoint: string;
    selfMonadId: string;
    stalenessMs?: number;
    now?: number;
}): Promise<MeshSelection | null>;
/**
 * Selects the best mesh claimant for a namespace request.
 *
 * Selection proceeds in this order:
 * 1. explicit `monadSelector` lookup, if present
 * 2. namespace claim filtering
 * 3. selector constraint filtering
 * 4. scoring via `computeScoreDetailed`
 * 5. optional epsilon-greedy exploration for low-margin decisions
 */
export declare function selectMeshClaimant(opts: {
    monadSelector: string;
    namespace: string;
    selfEndpoint: string;
    selfMonadId: string;
    selectorConstraint?: string | null;
    stalenessMs?: number;
    now?: number;
    extraScorers?: Scorer[];
    explorationRate?: number;
}): Promise<MeshSelection | null>;
