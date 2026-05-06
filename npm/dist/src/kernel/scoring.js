import { getKernel } from "./manager.js";
function nav(root, path) {
    return path.split(".").reduce((p, k) => p[k], root);
}
function claimPath(monadId, namespace) {
    const id = monadId.replace(/[^a-z0-9_.-]/g, "_");
    const ns = namespace.replace(/[^a-z0-9_.-]/g, "_");
    return `_.mesh.monads.${id}.claimed.${ns}`;
}
/**
 * Reads the open `.me` claim metadata for a monad/namespace pair.
 *
 * Returns `{}` when no metadata has been learned yet.
 */
export function readClaimMeta(monadId, namespace) {
    const kernelRead = getKernel();
    const result = kernelRead(claimPath(monadId, namespace));
    return result && typeof result === "object" ? result : {};
}
/**
 * Merges a patch into the open claim metadata subtree.
 *
 * Existing fields are preserved unless overwritten by the patch. This keeps the
 * schema extensible while letting the bridge update operational metrics.
 */
export function writeClaimMeta(monadId, namespace, patch) {
    const existing = readClaimMeta(monadId, namespace);
    nav(getKernel(), claimPath(monadId, namespace))({ ...existing, ...patch });
}
/**
 * Records the outcome of a forwarded mesh request.
 *
 * This is the learning loop. It updates:
 * - decayed `resonance`
 * - failure-penalized `effectiveResonance`
 * - EWMA `avgLatencyMs`
 * - forward/failure counters
 */
export function recordForwardResult(monadId, namespace, elapsedMs, ok) {
    const meta = readClaimMeta(monadId, namespace);
    const prev = {
        resonance: Number(meta.resonance ?? 0),
        avgLatencyMs: Number(meta.avgLatencyMs ?? elapsedMs),
        forwardCount: Number(meta.forwardCount ?? 0),
        failureCount: Number(meta.failureCount ?? 0),
    };
    const rawResonance = prev.resonance * 0.97 + (ok ? 1 : -0.7);
    const resonance = Math.min(Math.max(rawResonance, 0), 1000);
    const totalCount = prev.forwardCount + 1;
    const totalFailures = ok ? prev.failureCount : prev.failureCount + 1;
    const failureRate = totalCount > 0 ? totalFailures / totalCount : 0;
    const effectiveResonance = resonance * (1 - failureRate);
    writeClaimMeta(monadId, namespace, {
        resonance,
        effectiveResonance,
        avgLatencyMs: Math.round(prev.avgLatencyMs * 0.8 + elapsedMs * 0.2),
        forwardCount: totalCount,
        failureCount: totalFailures,
        lastForwardedAt: Date.now(),
    });
}
// ── Built-in scorers ──────────────────────────────────────────────────────────
// Each fn must return a value in [0, 1]. computeScore will clamp if not.
// Weights are overrideable per-claim via _weight_<name> or <name>Weight.
export const BUILT_IN_SCORERS = [
    {
        name: "latency",
        defaultWeight: 0.25,
        fn: (_m, meta) => {
            const ms = Number(meta.avgLatencyMs ?? 200);
            return 1 - ms / 2000; // 0ms→1.0, 2000ms→0, linear
        },
    },
    {
        name: "recency",
        defaultWeight: 0.35,
        fn: (m, _meta, ctx) => {
            const ageSec = (ctx.requestedAt - m.last_seen) / 1000;
            return 1 - ageSec / 300; // linear decay, 0 at 5 min
        },
    },
    {
        name: "resonance",
        defaultWeight: 0.40,
        fn: (_m, meta) => {
            // Prefer effectiveResonance (penalized by failureRate) when available.
            const r = Number(meta.effectiveResonance ?? meta.resonance ?? 0);
            return r / 100; // saturates at 100 effective interactions
        },
    },
];
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
export function computeScoreDetailed(m, meta, ctx, extraScorers = []) {
    const mode = ctx.mode ?? "normalized";
    // Alphabetical sort guarantees determinism regardless of injection order.
    const all = [...BUILT_IN_SCORERS, ...extraScorers].sort((a, b) => a.name.localeCompare(b.name));
    // Weight resolution (highest priority first):
    //   1. per-claim explicit override  (_weight_<name> or <name>Weight in meta)
    //   2. globally learned weight      (ctx.adaptiveWeights[name])
    //   3. scorer hardcoded default     (scorer.defaultWeight)
    const rawWeights = all.map((scorer) => {
        const raw = meta[`_weight_${scorer.name}`] ??
            meta[`${scorer.name}Weight`] ??
            ctx.adaptiveWeights?.[scorer.name] ??
            scorer.defaultWeight;
        const n = Number(raw);
        return Number.isFinite(n) ? Math.max(0, n) : 0;
    });
    const sum = rawWeights.reduce((a, b) => a + b, 0) || 1;
    const breakdown = {};
    let total = 0;
    for (let i = 0; i < all.length; i++) {
        const scorer = all[i];
        const w = mode === "normalized" ? rawWeights[i] / sum : rawWeights[i];
        const raw = scorer.fn(m, meta, ctx);
        const value = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
        const contribution = value * w;
        total += contribution;
        breakdown[scorer.name] = { value, weight: w, contribution };
    }
    return { total, mode, breakdown };
}
/**
 * Computes only the normalized score for a claimant.
 *
 * Use {@link computeScoreDetailed} when debugging or logging why a monad won.
 */
export function computeScore(m, meta, ctx, extraScorers = []) {
    return computeScoreDetailed(m, meta, ctx, extraScorers).total;
}
