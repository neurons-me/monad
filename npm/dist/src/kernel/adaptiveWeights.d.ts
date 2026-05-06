import type { ScorerBreakdown } from "./scoring.js";
/**
 * Starting weights for the three built-in scorers.
 *
 * These are the values used until the learning loop has accumulated enough
 * evidence to shift them. They match the `defaultWeight` fields in scoring.ts
 * exactly; keeping them in sync is a semantic constraint, not a mechanical one.
 */
export declare const DEFAULT_WEIGHTS: Record<string, number>;
/**
 * Gradient step size (α) applied per forward result.
 *
 * Small by design: `Δweight = α × reward × contribution` at α = 0.01
 * produces sub-1% shifts per step, keeping the weight trajectory smooth and
 * preventing oscillation after a burst of unusual outcomes.
 */
export declare const LEARNING_RATE = 0.01;
/**
 * Hard floor on any learned weight.
 *
 * No scorer can drop below 1% influence regardless of how many negative
 * rewards it accumulates. This ensures every signal remains recoverable:
 * if a scorer later becomes genuinely useful, it can climb back up.
 */
export declare const WEIGHT_MIN = 0.01;
/** Number of namespace samples required before namespace-local weights fully dominate reads. */
export declare const NAMESPACE_MATURITY_SAMPLES = 200;
/** Minimum share of every namespaced reward still attributed to the global prior. */
export declare const GLOBAL_BACKGROUND_SHARE = 0.05;
/**
 * Runtime health signals for the adaptive learning loop.
 *
 * These are diagnostic, not prescriptive — they surface conditions that
 * warrant attention, not automatic corrections. All four can be false
 * simultaneously on a healthy, well-calibrated system.
 */
export type WeightHealth = {
    /**
     * Name of a scorer that has captured more than 70% of total weight.
     *
     * A dominant scorer means the other signals are largely ignored. This may
     * be correct (e.g., resonance is genuinely the best predictor) or a sign
     * of overfitting to a narrow workload. Inspect the scorer delta table in
     * the offline analyzer to distinguish the two.
     *
     * `null` if no scorer exceeds the threshold.
     */
    dominantScorer: string | null;
    /**
     * Name of a scorer whose weight has dropped near the `WEIGHT_MIN` floor.
     *
     * A dead scorer is effectively not participating in selection. If the
     * scorer encodes a signal that should matter (e.g., latency for a
     * latency-sensitive workload), the learning loop may have over-penalized
     * it from early failures. Consider raising its per-claim `_weight_<name>`
     * override to inject a floor above `WEIGHT_MIN`.
     *
     * `null` if no scorer is near the floor.
     */
    deadScorer: string | null;
    /**
     * True when the recent reward signal alternates sign frequently.
     *
     * Computed over the last 10 rewards: if more than 40% of consecutive
     * pairs change sign, the learning loop is receiving contradictory signal.
     * Common causes: two claimants with similar scores and opposite reliability
     * profiles, or an exploration rate that is too high for the current mesh size.
     */
    oscillation: boolean;
    /**
     * True when 10 or more updates have been applied but no weight has moved
     * more than 0.002 from its default.
     *
     * Possible causes: all requests are going to name-selector monads (no
     * mesh-claim decisions), zero-contribution breakdowns (scorer values are
     * all zero), or the bridge is not calling `correlateOutcome`. Check that
     * `MONAD_DEBUG_WEIGHTS=1` shows updates after forwarded requests.
     */
    noLearning: boolean;
};
/**
 * A point-in-time snapshot of learned scorer weights with change context.
 *
 * Returned by {@link getWeightReport} and exposed via `GET /.mesh/weights`.
 */
export type WeightReport = {
    /** Current learned weights (same keys as {@link DEFAULT_WEIGHTS} plus any custom scorers). */
    current: Record<string, number>;
    /** Baseline values the system started from (hard-coded defaults). */
    defaults: Record<string, number>;
    /** `current - defaults` per scorer; positive = reinforced, negative = penalized. */
    delta: Record<string, number>;
    /** Total number of gradient steps applied since the daemon started (or since last reset). */
    updateCount: number;
    /** Unix millisecond timestamp of the most recent weight update, or null if never updated. */
    lastUpdatedAt: number | null;
    /**
     * True when no delta exceeds 5% of its default weight.
     *
     * A stable system has not yet learned much, or has converged back to
     * near-default weights after a period of learning. Not necessarily a
     * problem — a homogeneous mesh naturally converges to defaults.
     */
    stable: boolean;
    /** Diagnostic health signals for the learning loop. See {@link WeightHealth}. */
    health: WeightHealth;
    /** Namespace-local report when `getWeightReport(namespace)` is requested. */
    namespace?: {
        namespace: string;
        sampleCount: number;
        maturity: number;
        current: Record<string, number>;
        delta: Record<string, number>;
        blended: Record<string, number>;
    };
};
/**
 * Returns the current globally learned scorer weights.
 *
 * Falls back to {@link DEFAULT_WEIGHTS} for any key missing or invalid in
 * the kernel. Custom scorer weights added by the learning loop are also
 * returned. The `_meta` internal field is always excluded.
 */
export declare function readAdaptiveWeights(): Record<string, number>;
/**
 * Returns a full weight report: current values, defaults, per-scorer delta,
 * update metadata, stability flag, and runtime health signals.
 *
 * Used by `GET /.mesh/weights` and `MONAD_DEBUG_WEIGHTS=1` logging.
 *
 * When `namespace` is provided, the report includes namespace-local weights
 * and the blended weights used by `selectMeshClaimant`.
 */
export declare function getWeightReport(namespace?: string): WeightReport;
/**
 * Resolves the adaptive weights for one request.
 *
 * This is the read-side blend used by the hot path. It performs at most two
 * kernel reads: global weights plus namespace-local weights if they exist.
 * Namespaces are never initialized on read.
 */
export declare function resolveAdaptiveWeights(namespace?: string): Record<string, number>;
export type AdaptiveWeightUpdateOptions = {
    namespace?: string;
    learningRate?: number;
};
/**
 * Applies one online gradient step to the globally learned weights.
 *
 * ```
 * Δweight = learningRate × reward × contribution
 * ```
 *
 * Scorers with high contribution to a good outcome get heavier; scorers
 * that pushed a bad decision get lighter. The update is idempotent with
 * respect to sign: a series of failures will keep driving a weight toward
 * `WEIGHT_MIN` but can never push it below that floor.
 *
 * NaN and zero rewards are ignored (no-ops).
 *
 * @param reward     Continuous reward signal in [−1, 1]; from {@link correlateOutcome}.
 * @param breakdown  Per-scorer contributions from the decision being evaluated.
 * @param optionsOrLearningRate  Either a legacy numeric learning rate, or an
 * options object with `namespace` and/or `learningRate`.
 */
export declare function updateAdaptiveWeights(reward: number, breakdown: Record<string, ScorerBreakdown>, optionsOrLearningRate?: AdaptiveWeightUpdateOptions | number): void;
/** Resets learned weights to defaults. Call only from test setup. */
export declare function resetAdaptiveWeightsForTests(): void;
