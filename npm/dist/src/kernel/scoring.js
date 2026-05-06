import { getKernel } from "./manager.js";
function nav(root, path) {
    return path.split(".").reduce((p, k) => p[k], root);
}
function claimPath(monadId, namespace) {
    const id = monadId.replace(/[^a-z0-9_.-]/g, "_");
    const ns = namespace.replace(/[^a-z0-9_.-]/g, "_");
    return `_.mesh.monads.${id}.claimed.${ns}`;
}
// ── Claim meta I/O ────────────────────────────────────────────────────────────
export function readClaimMeta(monadId, namespace) {
    const kernelRead = getKernel();
    const result = kernelRead(claimPath(monadId, namespace));
    return result && typeof result === "object" ? result : {};
}
export function writeClaimMeta(monadId, namespace, patch) {
    const existing = readClaimMeta(monadId, namespace);
    nav(getKernel(), claimPath(monadId, namespace))({ ...existing, ...patch });
}
// ── Learning loop ─────────────────────────────────────────────────────────────
// Called by the bridge after every forwarded request.
// Updates resonance (with decay), EWMA latency, and derived effectiveResonance.
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
const BUILT_IN = [
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
// ── computeScore ──────────────────────────────────────────────────────────────
// Contracts (normalized mode):
//   • score ∈ [0, 1] always
//   • same inputs → same score (deterministic)
//   • NaN / Infinity in meta or scorer output → treated as 0 / 1 respectively
//   • scaling all weights by any constant → identical result
//
// raw mode: weights used as-is, score unbounded (for debugging/experiments).
export function computeScore(m, meta, ctx, extraScorers = []) {
    const mode = ctx.mode ?? "normalized";
    // Alphabetical order guarantees identical results regardless of injection order.
    const all = [...BUILT_IN, ...extraScorers].sort((a, b) => a.name.localeCompare(b.name));
    const weights = all.map((scorer) => {
        const raw = meta[`_weight_${scorer.name}`] ?? meta[`${scorer.name}Weight`] ?? scorer.defaultWeight;
        const n = Number(raw);
        return Number.isFinite(n) ? Math.max(0, n) : 0;
    });
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    return all.reduce((acc, scorer, i) => {
        const w = mode === "normalized" ? weights[i] / sum : weights[i];
        const raw = scorer.fn(m, meta, ctx);
        const v = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
        return acc + v * w;
    }, 0);
}
