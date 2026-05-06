/**
 * patchBay.test.ts — Declarative Signal Composition for Custom Scorers
 *
 * WHAT IS THE PATCH BAY?
 * Think of the three built-in scorers (latency, recency, resonance) as signal wires
 * coming out of an audio mixing board. The patch bay lets you COMBINE those signals
 * in new ways WITHOUT writing any scorer code:
 *
 *   registerPatch({ inputs: ["latency", "recency"], op: "multiply", out: "lat_rec" })
 *
 * This creates a NEW scorer called "lat_rec" whose value = latency × recency.
 * What does that measure? A node that is BOTH fast AND recently seen — a tighter
 * quality gate than either signal alone.
 *
 * AVAILABLE OPERATIONS:
 *   multiply: product of all inputs (all must be high for the result to be high)
 *   add:      sum, clamped to 1.0 (any high input helps)
 *   min:      weakest input wins (bottleneck — everything must be good)
 *   max:      strongest input wins (best-of — one good signal is enough)
 *   gate:     if input[0] >= threshold → pass input[1] through; else → 0
 *   power:    input[0] ^ exponent (sharpens contrast between good and bad nodes)
 *
 * THE TWO LAYERS:
 *   Patch bay: YOU decide which signals to combine and how (structural)
 *   Adaptive weights: the SYSTEM learns how much weight to give each patch (learned)
 *   They are independent — patches are wired connections, weights are attention.
 *
 * HOW PATCHES BECOME SCORERS:
 *   registerPatch(...)         → stores the patch definition in the kernel
 *   getPatchScorers(builtIns)  → materializes patch definitions into Scorer objects
 *   computeScoreDetailed(..., patchScorers) → includes patch values in the score
 *
 * WHAT WE TEST (4 groups):
 *   1. Registration and storage — CRUD for patch definitions
 *   2. getPatchScorers — materialization into usable Scorer objects
 *   3. Op correctness — each operation produces the right math
 *   4. Integration with computeScoreDetailed — patches appear in breakdown and score
 *
 * TEST FIXTURE VALUES:
 *   HALF_META: avgLatencyMs=1000, effectiveResonance=50
 *     → latency scorer:   1 - 1000/2000 = 0.5
 *     → resonance scorer: 50/100 = 0.5
 *   freshCtx: requestedAt = entry.last_seen (node just checked in)
 *     → recency scorer: 1.0 (perfectly fresh)
 *
 * So in every "op correctness" test:
 *   latency = 0.5, recency = 1.0, resonance = 0.5
 */

import { describe, it, beforeEach, expect } from "vitest";
import {
  registerPatch,
  unregisterPatch,
  readPatchBay,
  getPatchScorers,
  resetPatchBayForTests,
} from "../../src/kernel/patchBay.js";
import { BUILT_IN_SCORERS, computeScoreDetailed } from "../../src/kernel/scoring.js";
import type { MonadIndexEntry } from "../../src/kernel/monadIndex.js";

// Helper: minimal MonadIndexEntry with controllable last_seen for recency tests
function makeEntry(overrides: Partial<MonadIndexEntry> = {}): MonadIndexEntry {
  return {
    monad_id: "test",
    namespace: "ns",
    endpoint: "http://localhost:9001",
    last_seen: Date.now(),
    tags: [],
    ...overrides,
  } as MonadIndexEntry;
}

// Meta that produces predictable base scorer values:
//   latency  = 1 - 1000/2000 = 0.5   (average speed)
//   resonance = 50/100        = 0.5   (average reputation)
const HALF_META = { avgLatencyMs: 1000, effectiveResonance: 50 };

// Ctx where requestedAt == entry.last_seen → recency = 1.0 (perfectly fresh)
// Recency = 1 means the node just checked in THIS instant
function freshCtx(entry: MonadIndexEntry) {
  return { namespace: "ns", requestedAt: entry.last_seen };
}

// ── 1. Registration and storage ───────────────────────────────────────────────

describe("patchBay — registration and storage", () => {
  // Reset before each test so patches from one test don't leak into another.
  // The patch bay lives in the kernel, so it persists between tests without this reset.
  beforeEach(() => resetPatchBayForTests());

  it("starts empty", () => {
    // WHAT: On a fresh system, there are no registered patches.
    // WHY: If leftover patches from a previous run existed, every test would be
    //      contaminated with unexpected extra scorers.
    expect(readPatchBay()).toHaveLength(0);
  });

  it("registerPatch stores a patch and readPatchBay returns it", () => {
    // WHAT: Register a patch that multiplies latency × recency into a new scorer "lat_rec".
    //       Then read the patch bay and verify the stored definition is correct.
    //
    // The stored patch should contain:
    //   out:    "lat_rec"            (the name of the new synthetic scorer)
    //   inputs: ["latency","recency"] (the signals being combined)
    //   op:     "multiply"           (how they're combined)
    registerPatch({ inputs: ["latency", "recency"], op: "multiply", out: "lat_rec" });
    const patches = readPatchBay();
    expect(patches).toHaveLength(1);
    expect(patches[0]!.out).toBe("lat_rec");
    expect(patches[0]!.inputs).toEqual(["latency", "recency"]);
    expect(patches[0]!.op).toBe("multiply");
  });

  it("auto-generates output name when out is omitted", () => {
    // WHAT: When you don't specify `out`, the patch bay generates a name automatically.
    //       The auto-name format is: "<input1>_<input2>_<op>"
    //
    // inputs=["latency","recency"], op="add" → out="latency_recency_add"
    //
    // WHY: Convenience for quick one-off patches where the auto-name is descriptive enough.
    registerPatch({ inputs: ["latency", "recency"], op: "add" });
    const patches = readPatchBay();
    expect(patches[0]!.out).toBe("latency_recency_add");
  });

  it("multiple patches coexist", () => {
    // WHAT: Register two different patches. Both should be stored independently.
    //   "a" = latency × recency (correlation: need BOTH speed and freshness)
    //   "b" = resonance² (squaring sharpens the reputation signal)
    registerPatch({ inputs: ["latency", "recency"], op: "multiply", out: "a" });
    registerPatch({ inputs: ["resonance"],           op: "power",    out: "b", params: { exp: 2 } });
    expect(readPatchBay()).toHaveLength(2);
  });

  it("registering same name overwrites the previous entry", () => {
    // WHAT: Register two patches with the same output name "x". The second one wins.
    //
    // First:  x = latency × recency (multiply, 2 inputs)
    // Second: x = latency²          (power exp=2, 1 input)
    //
    // After both: only the "power" definition remains (op changed from multiply to power).
    //
    // WHY: This lets you iterate on a patch definition without accumulating duplicates.
    //      "registerPatch with the same name" = update the patch.
    registerPatch({ inputs: ["latency", "recency"], op: "multiply", out: "x" });
    registerPatch({ inputs: ["latency"],             op: "power",    out: "x", params: { exp: 2 } });
    const patches = readPatchBay();
    expect(patches).toHaveLength(1);        // still just one patch named "x"
    expect(patches[0]!.op).toBe("power");   // second registration won
  });

  it("unregisterPatch removes an entry", () => {
    // WHAT: Register a patch, then remove it by name. The patch bay should be empty again.
    // WHY: Allows runtime removal of patches (e.g., during configuration updates
    //      or when disabling a feature flag that added the patch).
    registerPatch({ inputs: ["latency", "recency"], op: "multiply", out: "lat_rec" });
    unregisterPatch("lat_rec");
    expect(readPatchBay()).toHaveLength(0);
  });

  it("unregisterPatch is a no-op for unknown names", () => {
    // WHAT: Try to remove a patch that doesn't exist. Should not throw.
    // WHY: Defensive coding — the caller might not know whether the patch exists.
    //      "remove if present" is safer than "remove and crash if not present".
    expect(() => unregisterPatch("nonexistent")).not.toThrow();
  });
});

// ── 2. getPatchScorers — materialization ─────────────────────────────────────

describe("patchBay — getPatchScorers materializes Scorers", () => {
  // Patches are stored as data (definitions). This section tests their conversion
  // into actual Scorer objects with working `fn` functions.
  beforeEach(() => resetPatchBayForTests());

  it("returns an empty array when no patches are registered", () => {
    // WHAT: With no patches registered, getPatchScorers returns [].
    //       The mesh selector won't have any extra scorers to add.
    expect(getPatchScorers(BUILT_IN_SCORERS)).toHaveLength(0);
  });

  it("returned scorer has the correct name and defaultWeight", () => {
    // WHAT: A patch registered with defaultWeight=0.2 produces a Scorer
    //       with name="lat2" and defaultWeight=0.2.
    //
    // The Scorer object is what computeScoreDetailed calls to compute values.
    // The name must match the patch's `out` field (used as the breakdown key).
    registerPatch({ inputs: ["latency"], op: "power", out: "lat2", defaultWeight: 0.2, params: { exp: 2 } });
    const scorers = getPatchScorers(BUILT_IN_SCORERS);
    expect(scorers).toHaveLength(1);
    expect(scorers[0]!.name).toBe("lat2");
    expect(scorers[0]!.defaultWeight).toBe(0.2);
  });

  it("defaults defaultWeight to 0.1 when not specified", () => {
    // WHAT: A patch without an explicit defaultWeight gets 0.1 (10% influence by default).
    //
    // WHY: 0.1 is a conservative default. New patches should start with minimal influence
    //      until the learning loop can determine their actual predictive value.
    //      If we defaulted to 0.5, every new patch would immediately dominate routing.
    registerPatch({ inputs: ["latency", "recency"], op: "multiply", out: "x" });
    const scorers = getPatchScorers(BUILT_IN_SCORERS);
    expect(scorers[0]!.defaultWeight).toBe(0.1);
  });

  it("unknown input name resolves to 0 without throwing", () => {
    // WHAT: A patch references "unknown_signal" which is not a built-in scorer name.
    //       The scorer function should treat it as 0 (not throw an error).
    //
    // HOW: getPatchScorers receives the array of base scorers. When resolving inputs,
    //      it searches for "unknown_signal" in the base scorer list. Not found → value=0.
    //
    // multiply(0, recency=1.0) = 0 × 1.0 = 0
    //
    // WHY: If bad input names caused exceptions, a misconfigured patch would crash
    //      the routing engine for ALL requests. Silently returning 0 is safer —
    //      the patch contributes nothing, and the operator can investigate via
    //      the weight debug log.
    registerPatch({ inputs: ["unknown_signal", "recency"], op: "multiply", out: "x" });
    const scorers = getPatchScorers(BUILT_IN_SCORERS);
    const entry = makeEntry();
    const result = scorers[0]!.fn(entry, {}, freshCtx(entry));
    // multiply: 0 (unknown) × 1.0 (recency) = 0
    expect(result).toBe(0);
  });
});

// ── 3. Op correctness ─────────────────────────────────────────────────────────
// With HALF_META and freshCtx: latency=0.5, recency=1.0, resonance=0.5

describe("patchBay — op correctness", () => {
  beforeEach(() => resetPatchBayForTests());

  it("multiply: product of inputs", () => {
    // multiply(latency=0.5, recency=1.0) = 0.5 × 1.0 = 0.5
    //
    // USE CASE: "Only route to nodes that are BOTH fast AND recently seen."
    // If either is weak, the product drops significantly (0.5 × 0.2 = 0.1).
    // This creates a strict quality gate compared to using either signal alone.
    registerPatch({ inputs: ["latency", "recency"], op: "multiply", out: "p" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, HALF_META, freshCtx(entry));
    expect(v).toBeCloseTo(0.5 * 1.0, 5); // 0.5
  });

  it("multiply: three-way product", () => {
    // multiply(latency=0.5, recency=1.0, resonance=0.5) = 0.5 × 1.0 × 0.5 = 0.25
    //
    // USE CASE: "Route only to nodes that are fast, fresh, AND reputable."
    // Three-way product is very selective — all three must be high.
    // Any single weak signal pulls the result down sharply.
    registerPatch({ inputs: ["latency", "recency", "resonance"], op: "multiply", out: "p3" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, HALF_META, freshCtx(entry));
    expect(v).toBeCloseTo(0.5 * 1.0 * 0.5, 5); // 0.25
  });

  it("add: sum clamped to 1", () => {
    // add(recency=1.0, recency=1.0) = 1.0 + 1.0 = 2.0 → clamped to 1.0
    //
    // The add op sums ALL inputs and clamps the result to [0, 1].
    // Without the clamp, scores could exceed 1.0 and break the normalized score.
    registerPatch({ inputs: ["recency", "recency"], op: "add", out: "p" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, {}, freshCtx(entry));
    // recency = 1.0 + 1.0 = 2.0 → clamped to 1.0
    expect(v).toBe(1.0);
  });

  it("add: partial sum stays below 1", () => {
    // add(latency=0.5, resonance=0.5) = 0.5 + 0.5 = 1.0 (exactly at the cap)
    //
    // USE CASE: "Either good speed OR good reputation is enough."
    // With add, one strong signal compensates for a weak one.
    // Compare to multiply where both must be high — add is more forgiving.
    registerPatch({ inputs: ["latency", "resonance"], op: "add", out: "p" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, HALF_META, freshCtx(entry));
    expect(v).toBeCloseTo(0.5 + 0.5, 5); // 1.0 exact
  });

  it("min: returns weakest input", () => {
    // min(latency=0.5, recency=1.0) = min(0.5, 1.0) = 0.5
    //
    // USE CASE: "The node is only as good as its weakest dimension."
    // This is a bottleneck metric — if latency is poor, the whole score is poor
    // regardless of how fresh the node is. Think of it like a pipeline:
    // the slowest stage determines throughput.
    registerPatch({ inputs: ["latency", "recency"], op: "min", out: "p" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, HALF_META, freshCtx(entry));
    expect(v).toBeCloseTo(Math.min(0.5, 1.0), 5); // 0.5
  });

  it("max: returns strongest input", () => {
    // max(latency=0.5, recency=1.0) = max(0.5, 1.0) = 1.0
    //
    // USE CASE: "Route to the node that excels in AT LEAST ONE dimension."
    // This is the most permissive combinator — any strong signal scores high.
    // Useful for nodes that specialize: great speed OR great reputation.
    registerPatch({ inputs: ["latency", "recency"], op: "max", out: "p" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, HALF_META, freshCtx(entry));
    expect(v).toBeCloseTo(Math.max(0.5, 1.0), 5); // 1.0
  });

  it("gate: passes inputs[1] when inputs[0] >= threshold", () => {
    // gate(recency=1.0, resonance=0.5, threshold=0.5):
    //   recency (1.0) >= threshold (0.5) → OPEN → return resonance (0.5)
    //
    // USE CASE: "Only consider a node's resonance if it's still fresh."
    // A node might have excellent historical resonance but be currently offline.
    // The gate says: "if recency is high enough (node is alive), use its resonance.
    //               If recency is too low (node is stale), return 0 (ignore it)."
    registerPatch({ inputs: ["recency", "resonance"], op: "gate", params: { threshold: 0.5 }, out: "p" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, HALF_META, freshCtx(entry));
    expect(v).toBeCloseTo(0.5, 5); // resonance (0.5) passes through the open gate
  });

  it("gate: blocks when inputs[0] < threshold", () => {
    // gate(latency=0.5, resonance=0.5, threshold=0.8):
    //   latency (0.5) < threshold (0.8) → CLOSED → return 0
    //
    // The node is not fast enough (latency below 80% quality). The gate blocks
    // resonance from counting. The node might have great history but is too slow.
    registerPatch({ inputs: ["latency", "resonance"], op: "gate", params: { threshold: 0.8 }, out: "p" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, HALF_META, freshCtx(entry));
    expect(v).toBe(0); // latency (0.5) < threshold (0.8) → gate closed
  });

  it("gate: with no inputs[1] returns 1 when gate open", () => {
    // gate(recency=1.0, threshold=0.5) — no inputs[1] specified:
    //   recency (1.0) >= threshold (0.5) → OPEN → return 1 (binary "open" signal)
    //
    // USE CASE: A pure "is the node alive?" binary signal.
    // If recency is above threshold, the node counts. If not, it's 0.
    // Useful as a boolean existence check (is the node reachable?).
    registerPatch({ inputs: ["recency"], op: "gate", params: { threshold: 0.5 }, out: "p" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, {}, freshCtx(entry));
    expect(v).toBe(1); // recency = 1.0 → gate open, no passthrough → binary 1
  });

  it("power: squares a single input", () => {
    // power(latency=0.5, exp=2) = 0.5² = 0.25
    //
    // USE CASE: "Sharpen the contrast — penalize mediocre nodes more."
    // With default scoring, a node at 0.5 and a node at 0.9 score differently but close.
    // Squaring: 0.5² = 0.25, 0.9² = 0.81 → the gap INCREASES.
    // This rewards excellence more aggressively than linear scoring.
    registerPatch({ inputs: ["latency"], op: "power", params: { exp: 2 }, out: "lat2" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, HALF_META, freshCtx(entry));
    expect(v).toBeCloseTo(0.25, 5); // 0.5² = 0.25
  });

  it("power: cube of a single input", () => {
    // power(latency=0.5, exp=3) = 0.5³ = 0.125
    //
    // Even sharper contrast than squaring.
    // 0.9³ = 0.729, 0.5³ = 0.125 → gap grows further.
    // Use higher exponents when you want only the very best nodes to score highly.
    registerPatch({ inputs: ["latency"], op: "power", params: { exp: 3 }, out: "lat3" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, HALF_META, freshCtx(entry));
    expect(v).toBeCloseTo(0.125, 5); // 0.5³ = 0.125
  });
});

// ── 4. Integration with computeScoreDetailed ──────────────────────────────────

describe("patchBay — integration with computeScoreDetailed", () => {
  // These tests prove that patch scorers work end-to-end with the scoring engine —
  // not just in isolation but as part of the full routing score computation.
  beforeEach(() => resetPatchBayForTests());

  it("patch scorers flow through computeScoreDetailed and appear in breakdown", () => {
    // WHAT: Register a patch, get it as a Scorer, pass it to computeScoreDetailed.
    //       The breakdown object should have a key "lat_rec" with the computed value.
    //
    // This proves the full data flow:
    //   registerPatch → getPatchScorers → computeScoreDetailed → breakdown["lat_rec"]
    //
    // WHY: If patches don't appear in the breakdown, the learning loop won't update
    //      their adaptive weights. Patches would compute values but never learn.
    registerPatch({ inputs: ["latency", "recency"], op: "multiply", out: "lat_rec", defaultWeight: 0.1 });
    const patchScorers = getPatchScorers(BUILT_IN_SCORERS);
    const entry = makeEntry();
    const result = computeScoreDetailed(entry, HALF_META, freshCtx(entry), patchScorers);
    expect(result.breakdown).toHaveProperty("lat_rec");
    // latency=0.5, recency=1.0 → multiply → 0.5
    expect(result.breakdown["lat_rec"]!.value).toBeCloseTo(0.5, 5);
  });

  it("total score includes patch contribution and stays in [0,1]", () => {
    // WHAT: Add a patch scorer with defaultWeight=0.5 (large).
    //       The total score should increase (patch adds signal) but stay ≤ 1.0
    //       (the normalization step ensures this).
    //
    // WHY: Even with a very large weight, the scoring engine normalizes by the sum
    //      of all weights. So adding a patch increases the weight denominator and
    //      the total stays bounded. This is the normalization invariant.
    registerPatch({ inputs: ["latency", "resonance"], op: "multiply", out: "lr", defaultWeight: 0.5 });
    const patchScorers = getPatchScorers(BUILT_IN_SCORERS);
    const entry = makeEntry();
    const { total } = computeScoreDetailed(entry, HALF_META, freshCtx(entry), patchScorers);
    expect(total).toBeGreaterThanOrEqual(0);
    expect(total).toBeLessThanOrEqual(1);
  });

  it("patch with zero contribution does not corrupt total", () => {
    // WHAT: A patch that references an unknown input (value=0) should produce value=0.
    //       The total score should still be a valid finite number in [0, 1].
    //
    // This is a corruption test: if 0-value patches broke the normalization or
    // produced NaN, the routing engine would fail for ANY workload that uses them.
    //
    // HOW: unknown input → value=0 → contribution = weight × 0 = 0
    //      Total = (sum of non-zero contributions) / (sum of all weights)
    //      Adding a zero-contribution scorer with weight=0.5 changes the denominator
    //      (total weight increases) but not the numerator → total decreases but stays valid.
    registerPatch({ inputs: ["unknown"], op: "multiply", out: "noop", defaultWeight: 0.5 });
    const patchScorers = getPatchScorers(BUILT_IN_SCORERS);
    const entry = makeEntry();
    const { total, breakdown } = computeScoreDetailed(entry, {}, freshCtx(entry), patchScorers);
    expect(breakdown["noop"]!.value).toBe(0);       // unknown signal → 0
    expect(total).toBeGreaterThanOrEqual(0);         // not negative
    expect(total).toBeLessThanOrEqual(1);            // not above 1
  });
});
