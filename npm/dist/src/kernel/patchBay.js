import { getKernel } from "./manager.js";
const PATH = "_.mesh.patchBay";
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
function applyOp(op, values, params) {
    switch (op) {
        case "multiply":
            return values.reduce((a, b) => a * b, 1);
        case "add":
            return Math.min(1, values.reduce((a, b) => a + b, 0));
        case "min":
            return values.length ? Math.min(...values) : 0;
        case "max":
            return values.length ? Math.max(...values) : 0;
        case "gate": {
            const threshold = params?.threshold ?? 0.5;
            return (values[0] ?? 0) >= threshold ? (values[1] ?? 1) : 0;
        }
        case "power": {
            const exp = params?.exp ?? 2;
            return Math.pow(Math.max(0, values[0] ?? 0), exp);
        }
        default:
            return 0;
    }
}
/**
 * Registers one derived feature in the patch bay.
 *
 * The patch is written to `_.mesh.patchBay.<name>` and will be picked up
 * by `getPatchScorers` on the next call without a server restart.
 *
 * ```ts
 * // Latency × recency — strong only when both signals are high
 * registerPatch({ inputs: ["latency", "recency"], op: "multiply", out: "lat_rec" });
 *
 * // Gate: use resonance score only when recency is fresh (≥ 0.5)
 * registerPatch({ inputs: ["recency", "resonance"], op: "gate", params: { threshold: 0.5 } });
 *
 * // Latency² — punishes high latency more aggressively
 * registerPatch({ inputs: ["latency"], op: "power", params: { exp: 2 }, out: "lat_squared" });
 * ```
 */
export function registerPatch(def) {
    const name = def.out ?? [...def.inputs, def.op].join("_");
    const stored = kernelRead(PATH) ?? {};
    kernelWrite(PATH, { ...stored, [name]: def });
}
/**
 * Removes a patch from the patch bay by its output scorer name.
 *
 * No-op if the name does not exist. The corresponding adaptive weight is
 * not removed — it will simply go unreferenced until the system is reset.
 */
export function unregisterPatch(name) {
    const stored = kernelRead(PATH) ?? {};
    const { [name]: _removed, ...rest } = stored;
    kernelWrite(PATH, rest);
}
/**
 * Returns all registered patches with their resolved output names.
 *
 * The raw kernel subtree is filtered to only include valid patch entries
 * (objects with `inputs` and `op` fields).
 */
export function readPatchBay() {
    const stored = kernelRead(PATH);
    if (!stored || typeof stored !== "object")
        return [];
    return Object.entries(stored)
        .filter(([, v]) => v && typeof v === "object" && Array.isArray(v.inputs) && v.op)
        .map(([name, v]) => ({ ...v, out: name }));
}
/**
 * Materializes all registered patches as `Scorer` instances ready for
 * injection into `computeScoreDetailed` via `extraScorers`.
 *
 * Each patch scorer re-evaluates its named inputs at call time by looking
 * them up in the provided `baseScorers` map. Unknown input names resolve
 * to 0 (safe no-op). Patch-of-patch chaining is not yet supported — inputs
 * must name scorers present in `baseScorers`.
 *
 * Called automatically by `selectMeshClaimant` with the built-in scorer
 * list; direct callers can also use it to introspect the derived feature set.
 *
 * @param baseScorers  Scorers available for input resolution (typically BUILT_IN_SCORERS).
 */
export function getPatchScorers(baseScorers) {
    const patches = readPatchBay();
    const scorerMap = new Map(baseScorers.map((s) => [s.name, s]));
    return patches.map((patch) => ({
        name: patch.out,
        defaultWeight: typeof patch.defaultWeight === "number" ? patch.defaultWeight : 0.1,
        fn: (m, meta, ctx) => {
            const values = patch.inputs.map((name) => {
                const s = scorerMap.get(name);
                if (!s)
                    return 0;
                const raw = s.fn(m, meta, ctx);
                return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
            });
            return applyOp(patch.op, values, patch.params);
        },
    }));
}
/** Clears all registered patches. Call only from test setup. */
export function resetPatchBayForTests() {
    kernelWrite(PATH, {});
}
