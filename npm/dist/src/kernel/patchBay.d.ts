import type { Scorer } from "./scoring.js";
/**
 * Composition operation applied to the resolved input values.
 *
 * All operations work on values in [0, 1] and return a value in [0, 1]:
 * - `multiply` — product (AND-like: both signals must be high)
 * - `add`      — sum clamped to 1 (OR-like: either signal being high is enough)
 * - `min`      — weakest signal wins (bottleneck / gating)
 * - `max`      — strongest signal wins (union / fallback)
 * - `gate`     — pass inputs[1] through only when inputs[0] ≥ threshold, else 0
 * - `power`    — inputs[0] raised to `params.exp` (sharpens or softens curves)
 */
export type PatchOp = "multiply" | "add" | "min" | "max" | "gate" | "power";
/**
 * Declaration of one derived feature in the patch bay.
 *
 * Stored verbatim in `_.mesh.patchBay.<out>` so the full graph is readable
 * from the kernel without any code introspection.
 */
export type PatchDef = {
    /**
     * Names of existing scorers whose outputs feed into this patch.
     *
     * Must reference built-in scorer names (`"latency"`, `"recency"`,
     * `"resonance"`) or custom scorers passed via `extraScorers`. Order
     * matters for `gate` (inputs[0] = condition, inputs[1] = pass-through)
     * and `power` (inputs[0] = base).
     *
     * Patch-of-patch chaining is not yet supported — inputs must resolve
     * to base scorers.
     */
    inputs: string[];
    /** Composition operation applied to the resolved input values. */
    op: PatchOp;
    /**
     * Output scorer name. Auto-generated as `[...inputs, op].join("_")` when
     * omitted. Must be unique across built-ins and all registered patches.
     */
    out?: string;
    /**
     * Op-specific parameters.
     *
     * - `gate`:  `{ threshold: 0.5 }` — minimum value of inputs[0] to open the gate
     * - `power`: `{ exp: 2 }` — exponent applied to inputs[0]
     */
    params?: Record<string, number>;
    /**
     * Starting weight for adaptive learning.
     *
     * Defaults to 0.1 — deliberately low so the learning loop determines
     * whether the interaction is meaningful before it dominates selection.
     */
    defaultWeight?: number;
};
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
export declare function registerPatch(def: PatchDef): void;
/**
 * Removes a patch from the patch bay by its output scorer name.
 *
 * No-op if the name does not exist. The corresponding adaptive weight is
 * not removed — it will simply go unreferenced until the system is reset.
 */
export declare function unregisterPatch(name: string): void;
/**
 * Returns all registered patches with their resolved output names.
 *
 * The raw kernel subtree is filtered to only include valid patch entries
 * (objects with `inputs` and `op` fields).
 */
export declare function readPatchBay(): Array<PatchDef & {
    out: string;
}>;
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
export declare function getPatchScorers(baseScorers: Scorer[]): Scorer[];
/** Clears all registered patches. Call only from test setup. */
export declare function resetPatchBayForTests(): void;
