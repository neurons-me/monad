import { getKernel } from "./manager.js";
/**
 * Starting weights for the three built-in scorers.
 *
 * These are the values used until the learning loop has accumulated enough
 * evidence to shift them. They match the `defaultWeight` fields in scoring.ts
 * exactly; keeping them in sync is a semantic constraint, not a mechanical one.
 */
export const DEFAULT_WEIGHTS = {
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
const GLOBAL_PATH = "_.mesh.adaptiveWeights";
const NS_ROOT = "_.mesh.nsWeights";
const touchedNamespaces = new Set();
function kernelRead(path) {
    try {
        return getKernel()(path);
    }
    catch {
        return undefined;
    }
}
function kernelWrite(path, value) {
    try {
        path.split(".").reduce((proxy, key, i, arr) => i === arr.length - 1 ? proxy[key](value) : proxy[key], getKernel());
    }
    catch { }
}
function readStoredMeta(stored) {
    const meta = stored && typeof stored === "object" ? stored._meta : null;
    return {
        updateCount: typeof meta?.updateCount === "number" ? meta.updateCount : 0,
        lastUpdatedAt: typeof meta?.lastUpdatedAt === "number" ? meta.lastUpdatedAt : null,
        rewardHistory: Array.isArray(meta?.rewardHistory) ? meta.rewardHistory : [],
        sampleCount: typeof meta?.sampleCount === "number" ? meta.sampleCount : 0,
    };
}
function sanitizeNamespace(namespace) {
    return String(namespace || "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
}
function namespacePath(namespace) {
    return `${NS_ROOT}.${sanitizeNamespace(namespace)}`;
}
function readWeightsAt(path, defaults = DEFAULT_WEIGHTS) {
    const stored = kernelRead(path);
    if (!stored || typeof stored !== "object")
        return null;
    const out = {};
    for (const [k, def] of Object.entries(defaults)) {
        const v = stored[k];
        out[k] = typeof v === "number" && Number.isFinite(v) ? Math.max(WEIGHT_MIN, v) : def;
    }
    for (const [k, v] of Object.entries(stored)) {
        if (k === "_meta")
            continue;
        if (!(k in out) && typeof v === "number" && Number.isFinite(v)) {
            out[k] = Math.max(WEIGHT_MIN, v);
        }
    }
    return out;
}
function deltaFromDefaults(weights) {
    const delta = {};
    for (const [k, v] of Object.entries(weights)) {
        const def = DEFAULT_WEIGHTS[k] ?? v;
        delta[k] = parseFloat((v - def).toFixed(5));
    }
    return delta;
}
function maturityForSamples(sampleCount) {
    return Math.min(1, Math.max(0, sampleCount) / NAMESPACE_MATURITY_SAMPLES);
}
function computeHealth(current, delta, updateCount, rewardHistory) {
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
            if (Math.sign(recent[i]) !== Math.sign(recent[i - 1]))
                signChanges++;
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
export function readAdaptiveWeights() {
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
export function getWeightReport(namespace) {
    const stored = kernelRead(GLOBAL_PATH);
    const current = readAdaptiveWeights();
    const { updateCount, lastUpdatedAt, rewardHistory } = readStoredMeta(stored);
    const delta = deltaFromDefaults(current);
    const stable = Object.entries(delta).every(([k, d]) => Math.abs(d) < (DEFAULT_WEIGHTS[k] ?? 0.33) * 0.05);
    const health = computeHealth(current, delta, updateCount, rewardHistory);
    const report = { current, defaults: { ...DEFAULT_WEIGHTS }, delta, updateCount, lastUpdatedAt, stable, health };
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
function blendWeights(global, ns, maturity) {
    const out = {};
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
export function resolveAdaptiveWeights(namespace) {
    const global = readAdaptiveWeights();
    if (!namespace)
        return global;
    const nsPath = namespacePath(namespace);
    const stored = kernelRead(nsPath);
    const ns = readWeightsAt(nsPath, global);
    if (!stored || !ns)
        return global;
    const { sampleCount } = readStoredMeta(stored);
    return blendWeights(global, ns, maturityForSamples(sampleCount));
}
function applyDeltaToWeights(current, reward, breakdown, learningRate, share) {
    const updated = { ...current };
    for (const [name, info] of Object.entries(breakdown)) {
        if (!Number.isFinite(info.contribution))
            continue;
        const delta = learningRate * reward * info.contribution * share;
        const prev = updated[name] ?? DEFAULT_WEIGHTS[name] ?? 1 / 3;
        updated[name] = Math.max(WEIGHT_MIN, prev + delta);
    }
    return updated;
}
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
export function updateAdaptiveWeights(reward, breakdown, optionsOrLearningRate = LEARNING_RATE) {
    if (!Number.isFinite(reward) || reward === 0)
        return;
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
export function resetAdaptiveWeightsForTests() {
    kernelWrite(GLOBAL_PATH, {
        ...DEFAULT_WEIGHTS,
        _meta: { lastUpdatedAt: null, updateCount: 0, rewardHistory: [] },
    });
    for (const ns of touchedNamespaces) {
        kernelWrite(`${NS_ROOT}.${ns}`, null);
    }
    touchedNamespaces.clear();
}
