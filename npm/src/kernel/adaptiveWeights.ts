import { getKernel } from "./manager.js";
import type { ScorerBreakdown } from "./scoring.js";

/**
 * Starting weights for the three built-in scorers.
 *
 * These are the values used until the learning loop has accumulated enough
 * evidence to shift them. They match the `defaultWeight` fields in scoring.ts
 * exactly; keeping them in sync is a semantic constraint, not a mechanical one.
 */
export const DEFAULT_WEIGHTS: Record<string, number> = {
  latency: 0.25,
  recency: 0.35,
  resonance: 0.40,
};

/**
 * Gradient step size (α) applied per forward result.
 *
 * Small by design: `Δweight = α × reward × contribution` at α = 0.01
 * produces sub-1% shifts per step, keeping the weight trajectory smooth and
 * preventing oscillation after a burst of unusual outcomes.
 */
export const LEARNING_RATE = 0.01;

/**
 * Hard floor on any learned weight.
 *
 * No scorer can drop below 1% influence regardless of how many negative
 * rewards it accumulates. This ensures every signal remains recoverable:
 * if a scorer later becomes genuinely useful, it can climb back up.
 */
export const WEIGHT_MIN = 0.01;

/** Number of namespace samples required before namespace-local weights fully dominate reads. */
export const NAMESPACE_MATURITY_SAMPLES = 200;

/** Minimum share of every namespaced reward still attributed to the global prior. */
export const GLOBAL_BACKGROUND_SHARE = 0.05;

/** Maximum number of recent reward values retained for oscillation detection. */
const REWARD_HISTORY_SIZE = 20;

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

const GLOBAL_PATH = "_.mesh.adaptiveWeights";
const NS_ROOT = "_.mesh.nsWeights";
const touchedNamespaces = new Set<string>();

function kernelRead(path: string): unknown {
  try {
    return (getKernel() as unknown as (p: string) => unknown)(path);
  } catch {
    return undefined;
  }
}

function kernelWrite(path: string, value: unknown): void {
  try {
    path.split(".").reduce((proxy: any, key: string, i, arr) =>
      i === arr.length - 1 ? proxy[key](value) : proxy[key], getKernel());
  } catch {}
}

function readStoredMeta(stored: unknown): {
  updateCount: number;
  lastUpdatedAt: number | null;
  rewardHistory: number[];
  sampleCount: number;
} {
  const meta = stored && typeof stored === "object" ? (stored as any)._meta : null;
  return {
    updateCount: typeof meta?.updateCount === "number" ? meta.updateCount : 0,
    lastUpdatedAt: typeof meta?.lastUpdatedAt === "number" ? meta.lastUpdatedAt : null,
    rewardHistory: Array.isArray(meta?.rewardHistory) ? meta.rewardHistory : [],
    sampleCount: typeof meta?.sampleCount === "number" ? meta.sampleCount : 0,
  };
}

function sanitizeNamespace(namespace: string): string {
  return String(namespace || "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
}

function namespacePath(namespace: string): string {
  return `${NS_ROOT}.${sanitizeNamespace(namespace)}`;
}

function readWeightsAt(path: string, defaults: Record<string, number> = DEFAULT_WEIGHTS): Record<string, number> | null {
  const stored = kernelRead(path);
  if (!stored || typeof stored !== "object") return null;

  const out: Record<string, number> = {};
  for (const [k, def] of Object.entries(defaults)) {
    const v = (stored as Record<string, unknown>)[k];
    out[k] = typeof v === "number" && Number.isFinite(v) ? Math.max(WEIGHT_MIN, v) : def;
  }
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    if (k === "_meta") continue;
    if (!(k in out) && typeof v === "number" && Number.isFinite(v)) {
      out[k] = Math.max(WEIGHT_MIN, v);
    }
  }
  return out;
}

function deltaFromDefaults(weights: Record<string, number>): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const [k, v] of Object.entries(weights)) {
    const def = DEFAULT_WEIGHTS[k] ?? v;
    delta[k] = parseFloat((v - def).toFixed(5));
  }
  return delta;
}

function maturityForSamples(sampleCount: number): number {
  return Math.min(1, Math.max(0, sampleCount) / NAMESPACE_MATURITY_SAMPLES);
}

function computeHealth(
  current: Record<string, number>,
  delta: Record<string, number>,
  updateCount: number,
  rewardHistory: number[],
): WeightHealth {
  const weights = Object.entries(current);
  const weightSum = weights.reduce((s, [, v]) => s + v, 0) || 1;

  const dominant = weights.find(([, v]) => v / weightSum > 0.70);
  const dominantScorer = dominant ? dominant[0] : null;

  const dead = weights.find(([, v]) => v < WEIGHT_MIN * 2);
  const deadScorer = dead ? dead[0] : null;

  // Oscillation: >40% sign changes over the last 10 rewards, requires ≥5 samples.
  const recent = rewardHistory.slice(-10);
  let oscillation = false;
  if (recent.length >= 5) {
    let signChanges = 0;
    for (let i = 1; i < recent.length; i++) {
      if (Math.sign(recent[i]!) !== Math.sign(recent[i - 1]!)) signChanges++;
    }
    oscillation = signChanges / (recent.length - 1) > 0.40;
  }

  const maxAbsDelta = Math.max(...Object.values(delta).map(Math.abs));
  const noLearning = updateCount >= 10 && maxAbsDelta < 0.002;

  return { dominantScorer, deadScorer, oscillation, noLearning };
}

/**
 * Returns the current globally learned scorer weights.
 *
 * Falls back to {@link DEFAULT_WEIGHTS} for any key missing or invalid in
 * the kernel. Custom scorer weights added by the learning loop are also
 * returned. The `_meta` internal field is always excluded.
 */
export function readAdaptiveWeights(): Record<string, number> {
  return readWeightsAt(GLOBAL_PATH) ?? { ...DEFAULT_WEIGHTS };
}

/**
 * Returns a full weight report: current values, defaults, per-scorer delta,
 * update metadata, stability flag, and runtime health signals.
 *
 * Used by `GET /.mesh/weights` and `MONAD_DEBUG_WEIGHTS=1` logging.
 *
 * When `namespace` is provided, the report includes namespace-local weights
 * and the blended weights used by `selectMeshClaimant`.
 */
export function getWeightReport(namespace?: string): WeightReport {
  const stored = kernelRead(GLOBAL_PATH);
  const current = readAdaptiveWeights();
  const { updateCount, lastUpdatedAt, rewardHistory } = readStoredMeta(stored);

  const delta = deltaFromDefaults(current);

  const stable = Object.entries(delta).every(
    ([k, d]) => Math.abs(d) < (DEFAULT_WEIGHTS[k] ?? 0.33) * 0.05,
  );

  const health = computeHealth(current, delta, updateCount, rewardHistory);

  const report: WeightReport = { current, defaults: { ...DEFAULT_WEIGHTS }, delta, updateCount, lastUpdatedAt, stable, health };

  if (namespace) {
    const nsPath = namespacePath(namespace);
    const nsStored = kernelRead(nsPath);
    const nsWeights = readWeightsAt(nsPath, current);
    if (nsWeights) {
      const { sampleCount } = readStoredMeta(nsStored);
      const maturity = maturityForSamples(sampleCount);
      report.namespace = {
        namespace,
        sampleCount,
        maturity,
        current: nsWeights,
        delta: deltaFromDefaults(nsWeights),
        blended: blendWeights(current, nsWeights, maturity),
      };
    }
  }

  return report;
}

function blendWeights(global: Record<string, number>, ns: Record<string, number>, maturity: number): Record<string, number> {
  const out: Record<string, number> = {};
  const keys = new Set([...Object.keys(global), ...Object.keys(ns)]);
  for (const k of keys) {
    const g = global[k] ?? DEFAULT_WEIGHTS[k] ?? ns[k] ?? 0;
    const n = ns[k] ?? g;
    out[k] = g * (1 - maturity) + n * maturity;
  }
  return out;
}

/**
 * Resolves the adaptive weights for one request.
 *
 * This is the read-side blend used by the hot path. It performs at most two
 * kernel reads: global weights plus namespace-local weights if they exist.
 * Namespaces are never initialized on read.
 */
export function resolveAdaptiveWeights(namespace?: string): Record<string, number> {
  const global = readAdaptiveWeights();
  if (!namespace) return global;

  const nsPath = namespacePath(namespace);
  const stored = kernelRead(nsPath);
  const ns = readWeightsAt(nsPath, global);
  if (!stored || !ns) return global;

  const { sampleCount } = readStoredMeta(stored);
  return blendWeights(global, ns, maturityForSamples(sampleCount));
}

function applyDeltaToWeights(
  current: Record<string, number>,
  reward: number,
  breakdown: Record<string, ScorerBreakdown>,
  learningRate: number,
  share: number,
): Record<string, number> {
  const updated: Record<string, number> = { ...current };
  for (const [name, info] of Object.entries(breakdown)) {
    if (!Number.isFinite(info.contribution)) continue;
    const delta = learningRate * reward * info.contribution * share;
    const prev = updated[name] ?? DEFAULT_WEIGHTS[name] ?? 1 / 3;
    updated[name] = Math.max(WEIGHT_MIN, prev + delta);
  }
  return updated;
}

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
export function updateAdaptiveWeights(
  reward: number,
  breakdown: Record<string, ScorerBreakdown>,
  optionsOrLearningRate: AdaptiveWeightUpdateOptions | number = LEARNING_RATE,
): void {
  if (!Number.isFinite(reward) || reward === 0) return;

  const opts = typeof optionsOrLearningRate === "number"
    ? { learningRate: optionsOrLearningRate }
    : optionsOrLearningRate;
  const learningRate = opts.learningRate ?? LEARNING_RATE;
  const namespace = opts.namespace?.trim();

  const stored = kernelRead(GLOBAL_PATH);
  const { updateCount, rewardHistory } = readStoredMeta(stored);
  const current = readAdaptiveWeights();

  const nextHistory = [...rewardHistory.slice(-(REWARD_HISTORY_SIZE - 1)), reward];

  let globalShare = 1;
  let nsShare = 0;

  if (namespace) {
    const nsKey = sanitizeNamespace(namespace);
    touchedNamespaces.add(nsKey);
    const nsPath = `${NS_ROOT}.${nsKey}`;
    const nsStored = kernelRead(nsPath);
    const nsMeta = readStoredMeta(nsStored);
    const nextSampleCount = nsMeta.sampleCount + 1;
    nsShare = maturityForSamples(nextSampleCount);
    globalShare = Math.max(GLOBAL_BACKGROUND_SHARE, 1 - nsShare);

    if (nsShare > 0) {
      const nsCurrent = readWeightsAt(nsPath, current) ?? { ...current };
      const nsUpdated = applyDeltaToWeights(nsCurrent, reward, breakdown, learningRate, nsShare);
      const nsHistory = [...nsMeta.rewardHistory.slice(-(REWARD_HISTORY_SIZE - 1)), reward];

      kernelWrite(nsPath, {
        ...nsUpdated,
        _meta: {
          sampleCount: nextSampleCount,
          lastUpdatedAt: Date.now(),
          updateCount: nsMeta.updateCount + 1,
          rewardHistory: nsHistory,
        },
      });
    }
  }

  const updated = applyDeltaToWeights(current, reward, breakdown, learningRate, globalShare);

  kernelWrite(GLOBAL_PATH, {
    ...updated,
    _meta: {
      lastUpdatedAt: Date.now(),
      updateCount: updateCount + 1,
      rewardHistory: nextHistory,
    },
  });
}

/** Resets learned weights to defaults. Call only from test setup. */
export function resetAdaptiveWeightsForTests(): void {
  kernelWrite(GLOBAL_PATH, {
    ...DEFAULT_WEIGHTS,
    _meta: { lastUpdatedAt: null, updateCount: 0, rewardHistory: [] },
  });
  for (const ns of touchedNamespaces) {
    kernelWrite(`${NS_ROOT}.${ns}`, null);
  }
  touchedNamespaces.clear();
}
