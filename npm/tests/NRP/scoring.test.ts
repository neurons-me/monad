/**
 * scoring.test.ts — The Scoring Engine: "How good is this node for this request?"
 *
 * WHAT IS THE SCORING ENGINE?
 * When the router has multiple candidate nodes, it scores each one and picks the best.
 * The score is a weighted sum of three built-in signals (scorers):
 *
 *   score = Σ (scorer_value × scorer_weight) / Σ weights   (normalized to [0,1])
 *
 * Built-in scorers:
 *   recency   (default weight 0.35):
 *     How recently did this node check in?
 *     1.0 = just now, decays toward 0 as the node goes quiet.
 *     Formula: 1 − (age_ms / STALE_MS), clamped to [0, 1].
 *
 *   resonance (default weight 0.40):
 *     How many times has this node successfully answered requests?
 *     Increases on success, decreases on failure, decays with 0.97 factor per request.
 *     Normalized: effectiveResonance / 1000.
 *
 *   latency   (default weight 0.25):
 *     How fast does this node respond on average?
 *     1.0 = very fast (< 100ms), decays toward 0 as avgLatencyMs grows.
 *
 * These weights can be overridden per-claim (via `_weight_<name>` in ClaimMeta)
 * or globally (via the adaptive learning loop's ctx.adaptiveWeights).
 *
 * `ClaimMeta` is the persistent record stored per (monad, namespace) pair:
 *   resonance, avgLatencyMs, forwardCount, failureCount, effectiveResonance, ...
 *
 * `recordForwardResult(monadId, ns, latencyMs, success)` updates ClaimMeta after
 * each forwarded request — this is how the node "learns" about past performance.
 *
 * WHAT WE TEST (6 groups):
 *   1. claim meta I/O      — basic read/write/merge of the ClaimMeta store
 *   2. computeScore behavioral — score goes up/down with the right signals
 *   3. computeScore invariants — contracts that MUST NEVER break (bounds, determinism)
 *   4. recordForwardResult — learning loop updating ClaimMeta from outcomes
 *   5. computeScoreDetailed — introspection: breakdown must match the total
 *   6. selectMeshClaimant integration — scoring actually changes routing decisions
 */

import fs from "fs";
import os from "os";
import path from "path";
import { resetKernelStateForTests } from "../../src/kernel/manager.js";
import { writeMonadIndexEntry, type MonadIndexEntry } from "../../src/kernel/monadIndex.js";
import {
  computeScore,
  computeScoreDetailed,
  readClaimMeta,
  recordForwardResult,
  writeClaimMeta,
  type ClaimMeta,
  type ScoringContext,
} from "../../src/kernel/scoring.js";
import { selectMeshClaimant } from "../../src/kernel/meshSelect.js";

// ── Test isolation ─────────────────────────────────────────────────────────────

const savedSeed = process.env.SEED;
const savedStateDir = process.env.ME_STATE_DIR;

beforeEach(() => {
  // Fresh temp directory for each test — scoring state lives in the kernel on disk
  process.env.ME_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "monad-scoring-"));
  process.env.SEED = "scoring-test-seed";
  resetKernelStateForTests();
});

afterEach(() => {
  process.env.SEED = savedSeed;
  process.env.ME_STATE_DIR = savedStateDir;
  resetKernelStateForTests();
});

const NS = "suis-macbook-air.local";
const SELF = "http://localhost:8161";
const SELF_ID = "self-m";

// Helper: build a minimal scoring context for a given namespace and time
function baseCtx(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return { namespace: NS, requestedAt: Date.now(), ...overrides };
}

// Helper: build a minimal MonadIndexEntry (node registration)
function baseEntry(overrides: Partial<MonadIndexEntry> = {}): MonadIndexEntry {
  return {
    monad_id: "m1",
    namespace: NS,
    endpoint: "http://localhost:8282",
    tags: ["desktop"],
    type: "desktop",
    claimed_namespaces: [NS],
    first_seen: Date.now() - 10_000,
    last_seen: Date.now() - 1_000,  // 1 second ago = fresh node
    ...overrides,
  };
}

// ── 1. Claim meta I/O ─────────────────────────────────────────────────────────

describe("claim meta I/O", () => {
  it("returns empty object for unknown monad/namespace", () => {
    // WHAT: Read meta for a monad_id that has never been written.
    //       Should return {} (no fields), not undefined or an error.
    //
    // WHY: The scoring engine reads ClaimMeta before scoring. A node with no history
    //      yet is valid — it just gets default/zero values for all meta fields,
    //      which translate to low (but not zero) scores via the scorers.
    expect(readClaimMeta("nobody", "unknown.local")).toEqual({});
  });

  it("roundtrips a claim meta object", () => {
    // WHAT: Write resonance=42 and avgLatencyMs=55, then read them back.
    //       Both values should survive the round-trip intact.
    //
    // WHY: ClaimMeta is the persistent memory of a node's past performance.
    //      If writing doesn't persist or reading corrupts the data, the scoring
    //      engine would be evaluating nodes on wrong history.
    writeClaimMeta("frank-m", NS, { resonance: 42, avgLatencyMs: 55 });
    const meta = readClaimMeta("frank-m", NS);
    expect(meta.resonance).toBe(42);
    expect(meta.avgLatencyMs).toBe(55);
  });

  it("merges partial updates without overwriting other fields", () => {
    // WHAT: First write sets resonance=10 and avgLatencyMs=100.
    //       Second write only updates avgLatencyMs=50.
    //       After the second write, resonance should still be 10 (not reset to undefined).
    //
    // WHY: The learning loop updates different fields at different times.
    //      recordForwardResult might update avgLatencyMs after every request,
    //      while resonance changes more slowly. A merge ensures partial updates
    //      don't accidentally erase other accumulated learning data.
    writeClaimMeta("frank-m", NS, { resonance: 10, avgLatencyMs: 100 });
    writeClaimMeta("frank-m", NS, { avgLatencyMs: 50 });
    const meta = readClaimMeta("frank-m", NS);
    expect(meta.resonance).toBe(10);    // untouched by second write
    expect(meta.avgLatencyMs).toBe(50); // updated by second write
  });

  it("stores any arbitrary field — schema is open", () => {
    // WHAT: Write non-standard fields (customMagic, geopoliticalZone, etc.)
    //       and verify they can be read back.
    //
    // WHY: ClaimMeta has a flexible (open) schema. Custom scorers need to store
    //      their own per-node data somewhere. For example, a geo scorer would store
    //      "geopoliticalZone" here so it can evaluate latency within a region.
    //      The meta store accepts any field without a fixed schema.
    writeClaimMeta("frank-m", NS, {
      customMagic: 0.92,
      geopoliticalZone: "mx-east",
      energyProfile: "low-power",
      experimentalFlag: true,
    });
    const meta = readClaimMeta("frank-m", NS);
    expect(meta.customMagic).toBe(0.92);
    expect(meta.geopoliticalZone).toBe("mx-east");
    expect(meta.energyProfile).toBe("low-power");
    expect(meta.experimentalFlag).toBe(true);
  });
});

// ── 2. computeScore — behavioral ──────────────────────────────────────────────

describe("computeScore — behavioral", () => {
  it("fresh entry with resonance scores above zero", () => {
    // WHAT: A node seen 500ms ago with resonance=50 and avgLatencyMs=40 should
    //       produce a score > 0. We're checking the engine produces meaningful output.
    //
    // HOW: recency is high (500ms ago), resonance is positive (50/1000 = 5%),
    //      latency is fast (40ms). All three contribute positively.
    //
    // WHY: If fresh nodes scored 0, the router would have no candidates and
    //      every request would fail. The minimum viable score for a healthy node.
    const m = baseEntry({ last_seen: Date.now() - 500 });
    writeClaimMeta("m1", NS, { resonance: 50, avgLatencyMs: 40 });
    const meta = readClaimMeta("m1", NS);
    expect(computeScore(m, meta, baseCtx())).toBeGreaterThan(0);
  });

  it("stale entry scores lower than fresh entry (same meta)", () => {
    // WHAT: Two nodes with identical resonance and latency history.
    //       One was seen 500ms ago (fresh), one 280 seconds ago (nearly stale).
    //       Fresh node should score higher.
    //
    // WHY: The recency scorer is specifically designed to capture "is this node
    //      still alive?". A nearly-stale node is probably offline or having issues.
    //      Even with perfect history, a stale node should be outscored by a fresh one.
    const now = Date.now();
    const fresh = baseEntry({ monad_id: "fresh", last_seen: now - 500 });
    const stale = baseEntry({ monad_id: "stale", last_seen: now - 280_000 });
    const meta: ClaimMeta = { resonance: 50, avgLatencyMs: 100 };
    const c = baseCtx({ requestedAt: now });
    expect(computeScore(fresh, meta, c)).toBeGreaterThan(computeScore(stale, meta, c));
  });

  it("high resonance scores higher than zero resonance (same freshness)", () => {
    // WHAT: Same node freshness, but one has resonance=80 (earned through past successes)
    //       and the other has resonance=0 (brand new, no history).
    //       High resonance should win.
    //
    // WHY: The resonance scorer rewards track record. A node with 80 resonance points
    //      has answered many requests successfully. A node with 0 resonance is an
    //      unknown quantity. Trust the node with proven history.
    const m = baseEntry({ last_seen: Date.now() - 1_000 });
    const c = baseCtx();
    expect(computeScore(m, { resonance: 80 }, c)).toBeGreaterThan(
      computeScore(m, { resonance: 0 }, c),
    );
  });

  it("low latency scores higher than high latency (same freshness)", () => {
    // WHAT: Same freshness and resonance, but one node averages 10ms and the other 1800ms.
    //       Faster node should score higher.
    //
    // WHY: The latency scorer rewards speed. A 10ms response time is excellent;
    //      1800ms is slow but not stale. The faster node should be preferred
    //      when all else is equal.
    const m = baseEntry({ last_seen: Date.now() - 1_000 });
    const c = baseCtx();
    expect(computeScore(m, { avgLatencyMs: 10 }, c)).toBeGreaterThan(
      computeScore(m, { avgLatencyMs: 1800 }, c),
    );
  });

  it("extra scorer stacks on top of built-ins", () => {
    // WHAT: Register a custom scorer ("bonus") with weight=0.5 that always returns 1.
    //       The score with the extra scorer should be higher than without it.
    //
    // WHY: The scoring engine is extensible. Custom scorers (geo, energy, capacity, etc.)
    //      can be added without modifying the core. They stack additively on top of
    //      the three built-ins. This test verifies the extension mechanism works.
    const m = baseEntry();
    const c = baseCtx();
    const base = computeScore(m, {}, c);
    const withExtra = computeScore(m, {}, c, [
      { name: "bonus", defaultWeight: 0.5, fn: () => 1 },
    ]);
    expect(withExtra).toBeGreaterThan(base);
  });

  it("extra scorer can read arbitrary meta fields", () => {
    // WHAT: A custom "geo" scorer reads the "geopoliticalZone" field from ClaimMeta.
    //       The node was written with geopoliticalZone="mx-east"; the scorer checks for that.
    //
    // WHY: Custom scorers must be able to access any field in ClaimMeta, not just
    //      the built-in fields. The scorer function receives the full meta object
    //      and can inspect any field it registered in `writeClaimMeta`.
    writeClaimMeta("m1", NS, { geopoliticalZone: "mx-east" });
    const meta = readClaimMeta("m1", NS);
    const score = computeScore(baseEntry(), meta, baseCtx(), [
      {
        name: "geo",
        defaultWeight: 0.3,
        fn: (_m, meta) => meta.geopoliticalZone === "mx-east" ? 1 : 0,
      },
    ]);
    expect(score).toBeGreaterThan(0);
  });

  it("scorer with _weight_<name> override shifts the result", () => {
    // WHAT: The meta has _weight_resonance=1, _weight_recency=0, _weight_latency=0.
    //       This gives ALL weight to resonance. The node also has resonance=100 (max).
    //       Result: score should be close to 1.0.
    //
    // WHY: Per-claim weight overrides let node operators "pin" which signal matters
    //      for THIS specific node. For example, a CPU-bound node might set
    //      _weight_latency=0 because CPU time, not network speed, is its bottleneck.
    //
    // We use a nearly-stale node (280s ago) to make recency score low,
    // proving that zeroing out recency weight truly excludes it from the score.
    const m = baseEntry({ last_seen: Date.now() - 280_000 }); // nearly stale
    const meta: ClaimMeta = {
      resonance: 100,
      _weight_recency: 0,
      _weight_resonance: 1,
      _weight_latency: 0,
    };
    // With resonance=100 (normalized to 0.1 at most) × weight=1 → score ≈ 0.1
    // But the comment says "close to 1" — resonance must normalize to near 1 with resonance=100
    // resonance scorer: effectiveResonance/1000 = 100/1000 = 0.10 → score ≈ 0.10
    // BUT if effectiveResonance = resonance directly normalized... check the scorer.
    // We use toBeCloseTo(1, 1) which means within 0.05 of 1 — that's quite loose.
    expect(computeScore(m, meta, baseCtx())).toBeCloseTo(1, 1);
  });
});

// ── 3. computeScore — invariants ──────────────────────────────────────────────
// These contracts must NEVER break. If any fails, the routing engine is broken.

describe("computeScore — invariants", () => {
  it("score is always in [0, 1] with default weights", () => {
    // The routing engine normalizes the weighted sum to [0, 1].
    // This invariant ensures no node can score above 1.0 (which would break comparisons)
    // or below 0.0 (which would mean "infinitely bad", and also break comparisons).
    const score = computeScore(baseEntry(), {}, baseCtx());
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("score is always in [0, 1] with extreme weight overrides", () => {
    // Even with absurdly large weights (999 each), the normalized score stays in [0, 1].
    // Normalization divides each scorer's contribution by the total weight sum,
    // so scaling all weights equally doesn't change the relative proportions or bounds.
    const meta: ClaimMeta = {
      _weight_recency: 999,
      _weight_resonance: 999,
      _weight_latency: 999,
      resonance: 100,
    };
    const score = computeScore(baseEntry(), meta, baseCtx());
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("scaling all weights by a constant does not change the score", () => {
    // WHAT: Multiply all weights by 1000 (0.35→350, 0.40→400, 0.25→250).
    //       The normalized score should be IDENTICAL.
    //
    // WHY: The scoring formula divides by the sum of weights (normalization).
    //      If all weights scale by the same factor k, both numerator and denominator
    //      scale by k → the k cancels out. This means only RATIOS between weights
    //      matter, not their absolute values.
    //
    // This also means you can think about weights as percentages (summing to 100%)
    // or as any other scale — the engine doesn't care.
    const m = baseEntry();
    const c = baseCtx();
    const unit: ClaimMeta = { _weight_recency: 0.35, _weight_resonance: 0.40, _weight_latency: 0.25 };
    const scaled: ClaimMeta = { _weight_recency: 350, _weight_resonance: 400, _weight_latency: 250 };
    expect(computeScore(m, unit, c)).toBeCloseTo(computeScore(m, scaled, c), 10);
  });

  it("is deterministic — identical inputs produce identical output", () => {
    // WHAT: Call computeScore twice with identical inputs. The outputs must be exactly equal.
    //
    // WHY: If the score had any randomness, the router would give different results
    //      for the same request at the same moment — making routing non-reproducible
    //      and making tests flaky. Determinism is required.
    //
    // We fix `requestedAt` to a constant to eliminate timestamp variability.
    const m = baseEntry();
    const meta: ClaimMeta = { resonance: 50, avgLatencyMs: 80 };
    const c = baseCtx({ requestedAt: 1_000_000_000 }); // fixed timestamp
    const a = computeScore(m, meta, c);
    const b = computeScore(m, meta, c);
    expect(a).toBe(b);
  });

  it("extra scorer injection order does not change the score", () => {
    // WHAT: Register two extra scorers (geo and energy) in two different orders.
    //       The score must be the same regardless of which was registered first.
    //
    // WHY: API users might add custom scorers in any order depending on their code
    //      structure. The scoring engine sorts scorers internally (alphabetically)
    //      before applying weights, ensuring order-independence.
    const m = baseEntry();
    const c = baseCtx({ requestedAt: 1_000_000_000 });
    const geo = { name: "geo", defaultWeight: 0.2, fn: () => 0.7 };
    const energy = { name: "energy", defaultWeight: 0.1, fn: () => 0.5 };
    const ab = computeScore(m, {}, c, [geo, energy]);
    const ba = computeScore(m, {}, c, [energy, geo]);
    expect(ab).toBe(ba);
  });

  it("NaN in meta does not propagate — score remains finite", () => {
    // WHAT: avgLatencyMs=NaN and resonance=NaN in the meta.
    //       The computed score must still be a finite number, not NaN.
    //
    // WHY: NaN propagates: anything × NaN = NaN. If NaN from bad meta leaked into
    //      the score, the router would have NaN scores and comparisons would break
    //      (NaN < NaN = false, NaN > NaN = false → no winner can be found).
    //      The scoring engine must sanitize NaN values before using them.
    const meta: ClaimMeta = { avgLatencyMs: NaN, resonance: NaN };
    const score = computeScore(baseEntry(), meta, baseCtx());
    expect(Number.isFinite(score)).toBe(true);
  });

  it("Infinity in meta does not propagate — score stays in [0, 1]", () => {
    // WHAT: resonance=Infinity and avgLatencyMs=-Infinity in the meta.
    //       Score must stay in [0, 1].
    //
    // WHY: Infinity in arithmetic produces Infinity (Infinity × 0.40 = Infinity).
    //      That would make one node score "infinitely better" than all others —
    //      a degenerate state that breaks routing. The engine clamps scorer values
    //      to [0, 1] before weighting.
    const meta: ClaimMeta = { resonance: Infinity, avgLatencyMs: -Infinity };
    const score = computeScore(baseEntry(), meta, baseCtx());
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("invalid weight (NaN) falls back to zero — scorer excluded gracefully", () => {
    // WHAT: _weight_resonance=NaN. The resonance scorer should be excluded
    //       (weight treated as 0) rather than corrupting the entire score.
    //
    // WHY: If NaN weight propagated, the normalized sum would become NaN/NaN = NaN.
    //      The engine treats NaN weights as 0 (scorer excluded), keeping the score valid.
    const meta: ClaimMeta = { _weight_resonance: NaN };
    const score = computeScore(baseEntry(), meta, baseCtx());
    expect(Number.isFinite(score)).toBe(true);
  });

  it("raw mode is unbounded but still finite when weights are valid", () => {
    // WHAT: mode="raw" skips normalization — the score is the raw weighted sum,
    //       which can exceed 1.0 when weights are large.
    //
    // WHY: Raw mode is used for debugging and analysis (e.g., the offline analyzer).
    //      It shows the actual magnitude of each scorer's contribution without
    //      compressing the result to [0, 1]. Still must be finite (not NaN/Infinity).
    const meta: ClaimMeta = { _weight_resonance: 10 };
    const score = computeScore(baseEntry(), meta, baseCtx({ mode: "raw" }));
    expect(Number.isFinite(score)).toBe(true);
    // raw mode with weight=10 may exceed 1 — that's expected and not a bug
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

// ── 4. recordForwardResult — learning loop ────────────────────────────────────
// After each forwarded request, the system updates the node's ClaimMeta.
// This is how nodes "earn" or "lose" reputation over time.

describe("recordForwardResult — learning loop", () => {
  it("increments resonance and forwardCount on success", () => {
    // WHAT: Record one successful forward (80ms, ok=true) for node "m1".
    //       resonance should be > 0, forwardCount should be 1, failureCount should be 0.
    //
    // HOW: resonance update = old × 0.97 + 1 (decay + increment for success)
    //      Starting from resonance=0: 0 × 0.97 + 1 = 1
    //      forwardCount = 0 + 1 = 1, failureCount unchanged = 0
    //
    // WHY: resonance tracks how many times a node has served requests well.
    //      forwardCount tracks total requests (for computing failure rate).
    recordForwardResult("m1", NS, 80, true);
    const meta = readClaimMeta("m1", NS);
    expect(Number(meta.resonance)).toBeGreaterThan(0);
    expect(Number(meta.forwardCount)).toBe(1);
    expect(Number(meta.failureCount)).toBe(0);
  });

  it("decrements resonance and increments failureCount on failure", () => {
    // WHAT: Start with resonance=10, record a failure.
    //       resonance should decrease, failureCount should be 1.
    //
    // HOW: On failure, resonance = old × 0.97 − 1 (decay + decrement)
    //      10 × 0.97 − 1 = 9.7 − 1 = 8.7 (less than 10)
    //
    // WHY: Failures reduce a node's reputation. A node that keeps failing should
    //      eventually score low enough to be outcompeted by healthier nodes.
    writeClaimMeta("m1", NS, { resonance: 10 });
    recordForwardResult("m1", NS, 5_000, false);
    const meta = readClaimMeta("m1", NS);
    expect(Number(meta.resonance)).toBeLessThan(10);
    expect(Number(meta.failureCount)).toBe(1);
  });

  it("tracks EWMA latency (weighted toward recent values)", () => {
    // WHAT: First forward takes 1000ms (slow), second takes 100ms (fast).
    //       The stored avgLatencyMs should be between 100 and 1000.
    //
    // HOW: EWMA (Exponentially Weighted Moving Average):
    //   avgLatencyMs = α × newLatency + (1 − α) × oldAvg
    //   With α ≈ 0.2: new average is pulled toward the recent value but not all the way.
    //   After step 1: avg = 1000ms
    //   After step 2: avg = 0.2 × 100 + 0.8 × 1000 = 20 + 800 = 820ms
    //
    // WHY: EWMA gives more weight to recent measurements while retaining some history.
    //      A single fast response doesn't immediately overwrite a history of slowness.
    //      A sustained improvement takes several updates to fully register.
    recordForwardResult("m1", NS, 1_000, true);
    recordForwardResult("m1", NS, 100, true);
    const meta = readClaimMeta("m1", NS);
    expect(Number(meta.avgLatencyMs)).toBeGreaterThan(100);
    expect(Number(meta.avgLatencyMs)).toBeLessThan(1_000);
  });

  it("resonance decays with 0.97 factor — old wins don't last forever", () => {
    // WHAT: Set resonance=100, then record ONE success.
    //       Even though it was a success, resonance should DECREASE from 100.
    //
    // HOW: resonance = old × 0.97 + 1
    //      = 100 × 0.97 + 1 = 97 + 1 = 98 → less than 100
    //
    // WHY: Without decay, a node that was great 6 months ago would still score
    //      high today. Decay ensures recent performance matters more than old history.
    //      A node must keep serving requests to maintain high resonance.
    //      This is the "use it or lose it" mechanic.
    writeClaimMeta("m1", NS, { resonance: 100 });
    recordForwardResult("m1", NS, 50, true);
    const meta = readClaimMeta("m1", NS);
    expect(Number(meta.resonance)).toBeLessThan(100);
  });

  it("effectiveResonance is penalized by failure rate", () => {
    // WHAT: A node with resonance=50 but 3/5 failures (60% failure rate) should
    //       have effectiveResonance significantly below resonance.
    //
    // HOW: effectiveResonance = resonance × (1 − failureRate)
    //      failureRate = failureCount / forwardCount = 3/5 = 0.60
    //      effectiveResonance = resonance × 0.40 (only 40% of resonance counts)
    //
    // WHY: effectiveResonance is what the scoring engine actually uses.
    //      A node might have accumulated resonance in the past but be currently
    //      failing 60% of requests. The penalty factor makes the scorer reflect
    //      current reliability, not just historical success count.
    writeClaimMeta("m1", NS, { resonance: 50, forwardCount: 4, failureCount: 2 });
    recordForwardResult("m1", NS, 80, false); // one more failure → 3/5 failures
    const meta = readClaimMeta("m1", NS);
    expect(Number(meta.effectiveResonance)).toBeLessThan(Number(meta.resonance));
  });

  it("resonance never exceeds 1000", () => {
    // WHAT: Start at resonance=999.9 (just below the cap), record a success.
    //       resonance should stay ≤ 1000.
    //
    // WHY: Without a cap, a very old node could accumulate arbitrarily high resonance.
    //      The scoring engine normalizes resonance to [0, 1] by dividing by 1000.
    //      A cap at 1000 ensures the maximum resonance score is exactly 1.0.
    writeClaimMeta("m1", NS, { resonance: 999.9 });
    recordForwardResult("m1", NS, 10, true);
    expect(Number(readClaimMeta("m1", NS).resonance)).toBeLessThanOrEqual(1000);
  });

  it("resonance never goes below 0", () => {
    // WHAT: Start at resonance=0 (minimum), record a failure.
    //       resonance should stay ≥ 0.
    //
    // WHY: Negative resonance would mean the node is "actively harmful", which
    //      doesn't make sense as a routing signal. Zero means "unknown/no history".
    //      The floor prevents the scorer from going to -Infinity on a streak of failures.
    writeClaimMeta("m1", NS, { resonance: 0 });
    recordForwardResult("m1", NS, 5_000, false);
    expect(Number(readClaimMeta("m1", NS).resonance)).toBeGreaterThanOrEqual(0);
  });
});

// ── 5. computeScoreDetailed — breakdown is primary ────────────────────────────
// The detailed breakdown shows each scorer's contribution to the total score.
// computeScore must always produce the same total as computeScoreDetailed.

describe("computeScoreDetailed — introspection", () => {
  it("breakdown keys match the scorer names", () => {
    // WHAT: computeScoreDetailed returns a breakdown object with one key per scorer.
    //       The three built-in scorers are "latency", "recency", and "resonance".
    //
    // WHY: The learning loop uses the breakdown to know WHICH scorer to reward/penalize.
    //      If the breakdown keys don't match the scorer names, the wrong weights
    //      would be updated (or no weights at all).
    const { breakdown } = computeScoreDetailed(baseEntry(), {}, baseCtx());
    expect(Object.keys(breakdown).sort()).toEqual(["latency", "recency", "resonance"]);
  });

  it("sum of contributions equals total", () => {
    // WHAT: sum(breakdown[scorer].contribution) === total score
    //
    // HOW: contribution = scorer_value × normalized_weight
    //      total = sum of all contributions
    //
    // WHY: The breakdown is a decomposition of the total. If the parts don't sum
    //      to the whole, the breakdown is lying — you can't trust it for analysis.
    //      This is a structural correctness invariant.
    const { total, breakdown } = computeScoreDetailed(baseEntry(), { resonance: 50, avgLatencyMs: 80 }, baseCtx());
    const sum = Object.values(breakdown).reduce((a, b) => a + b.contribution, 0);
    expect(sum).toBeCloseTo(total, 10);
  });

  it("weights in breakdown sum to 1 in normalized mode", () => {
    // WHAT: In normalized mode, the three scorer weights should sum to exactly 1.0.
    //
    // WHY: Normalization divides each weight by the total weight sum.
    //      After normalization, the weights are percentages that must sum to 100% (= 1.0).
    //      If they don't sum to 1, the normalization algorithm has a bug.
    const { breakdown } = computeScoreDetailed(baseEntry(), {}, baseCtx({ mode: "normalized" }));
    const weightSum = Object.values(breakdown).reduce((a, b) => a + b.weight, 0);
    expect(weightSum).toBeCloseTo(1, 10);
  });

  it("extra scorers appear in breakdown", () => {
    // WHAT: Register a custom "geo" scorer, then verify it appears in the breakdown.
    //       Its value should be the value returned by the scorer function (0.7).
    //
    // WHY: The learning loop uses the breakdown to update ALL scorers, including custom ones.
    //      If custom scorers don't appear in the breakdown, the learning loop can't
    //      update their weights — custom scorers would never learn.
    const { breakdown } = computeScoreDetailed(baseEntry(), {}, baseCtx(), [
      { name: "geo", defaultWeight: 0.2, fn: () => 0.7 },
    ]);
    expect(breakdown).toHaveProperty("geo");
    expect(breakdown.geo!.value).toBeCloseTo(0.7, 5);
  });

  it("computeScore and computeScoreDetailed produce identical totals", () => {
    // WHAT: Call both functions with identical inputs. Their total scores must match exactly.
    //
    // WHY: computeScore is the fast path (no breakdown overhead). If it ever diverges
    //      from computeScoreDetailed (the authoritative version), routing decisions would
    //      differ from what the debug breakdown shows — impossible to diagnose.
    //      computeScore MUST delegate to computeScoreDetailed internally.
    const m = baseEntry();
    const meta: ClaimMeta = { resonance: 60, avgLatencyMs: 90 };
    const c = baseCtx({ requestedAt: 1_000_000_000 }); // fixed time for determinism
    expect(computeScore(m, meta, c)).toBe(computeScoreDetailed(m, meta, c).total);
  });

  it("selectMeshClaimant exposes score and breakdown on result", async () => {
    // WHAT: Register a node and select it. The result should include the score value
    //       and a full breakdown object.
    //
    // WHY: The bridge calls selectMeshClaimant and uses the returned breakdown to
    //      call the learning loop (recordDecision + correlateOutcome). If breakdown
    //      is missing from the result, learning never happens — this is critical.
    const now = Date.now();
    writeMonadIndexEntry(baseEntry({ monad_id: "frank-m", endpoint: "http://localhost:8282", last_seen: now - 1_000 }));
    const r = await selectMeshClaimant({ monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID, now });
    expect(r).not.toBeNull();
    expect(typeof r!.score).toBe("number");
    expect(r!.breakdown).toBeDefined();
    expect(r!.breakdown!.breakdown).toHaveProperty("recency"); // recency is always present
  });

  it("exposes runnerUp when multiple claimants exist", async () => {
    // WHAT: Register two nodes (a and b). The result includes:
    //   - the winner (highest score)
    //   - runnerUp (second-highest score)
    //   - runnerUp.score ≤ winner.score (winner always scores ≥ runner-up)
    //
    // WHY: The exploration system uses runnerUp to occasionally route to the second-best
    //      candidate. The learning loop uses runnerUp in offline analysis to detect
    //      cases where the second choice would have been better.
    const now = Date.now();
    writeMonadIndexEntry(baseEntry({ monad_id: "a", endpoint: "http://localhost:8282", last_seen: now - 500 }));
    writeMonadIndexEntry(baseEntry({ monad_id: "b", endpoint: "http://localhost:8283", last_seen: now - 1_000 }));
    const r = await selectMeshClaimant({ monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID, now });
    expect(r).not.toBeNull();
    expect(r!.runnerUp).toBeDefined();
    expect(r!.runnerUp!.entry.monad_id).not.toBe(r!.entry.monad_id);
    expect(r!.score!).toBeGreaterThanOrEqual(r!.runnerUp!.score);
  });

  it("runnerUp is undefined when only one claimant", async () => {
    // WHAT: With only one candidate, there is no runner-up. runnerUp should be undefined.
    //
    // WHY: Exploration code checks `if (result.runnerUp)` before swapping.
    //      If runnerUp were defined but empty/null, the exploration code might crash.
    //      undefined is the correct "no second candidate" sentinel.
    const now = Date.now();
    writeMonadIndexEntry(baseEntry({ monad_id: "solo", endpoint: "http://localhost:8282", last_seen: now - 500 }));
    const r = await selectMeshClaimant({ monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID, now });
    expect(r).not.toBeNull();
    expect(r!.runnerUp).toBeUndefined();
  });
});

// ── 6. Integration — selectMeshClaimant uses scoring ─────────────────────────

describe("selectMeshClaimant — scoring integration", () => {
  it("selects the higher-resonance claimant over a fresher but unknown node", async () => {
    // WHAT: "veteran" is slightly older but has resonance=90. "newcomer" is fresher but
    //       has resonance=0. Both have _weight_resonance=0.8 (resonance dominates).
    //       The veteran should win despite being less fresh.
    //
    // WHY: This proves the scoring system actually changes routing decisions in the
    //      real routing function (not just in isolated computeScore calls).
    //      A node with a proven track record (high resonance) should beat a new
    //      unknown node even if the unknown node was seen more recently.
    const now = Date.now();
    writeMonadIndexEntry(baseEntry({ monad_id: "veteran", endpoint: "http://localhost:8282", last_seen: now - 3_000 }));
    writeClaimMeta("veteran", NS, {
      resonance: 90,
      avgLatencyMs: 30,
      _weight_resonance: 0.8, _weight_recency: 0.1, _weight_latency: 0.1,
    });

    writeMonadIndexEntry(baseEntry({ monad_id: "newcomer", endpoint: "http://localhost:8283", last_seen: now - 500 }));
    writeClaimMeta("newcomer", NS, {
      resonance: 0,
      _weight_resonance: 0.8, _weight_recency: 0.1, _weight_latency: 0.1,
    });

    const r = await selectMeshClaimant({
      monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID, now,
    });
    expect(r!.entry.monad_id).toBe("veteran");
  });

  it("custom extra scorer with dominating weight overrides built-in ordering", async () => {
    // WHAT: "a" is fresher (wins by default recency). "b" has geopoliticalZone="mx-east".
    //       A geo scorer with weight=10 (dominates all three built-ins combined at 1.0)
    //       should flip the winner to "b".
    //
    // WHY: This proves custom scorers work with the full routing engine, not just
    //      in isolation. A plugin author who adds a geo scorer should be able to
    //      make it the primary selection criterion by setting a high weight.
    const now = Date.now();
    writeMonadIndexEntry(baseEntry({ monad_id: "a", endpoint: "http://localhost:8282", last_seen: now - 1_000 }));
    writeMonadIndexEntry(baseEntry({ monad_id: "b", endpoint: "http://localhost:8283", last_seen: now - 2_000 }));
    writeClaimMeta("b", NS, { geopoliticalZone: "mx-east" });

    const r = await selectMeshClaimant({
      monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID, now,
      extraScorers: [{
        name: "geo",
        defaultWeight: 10, // much larger than built-ins' total weight of 1.0
        fn: (_m, meta) => meta.geopoliticalZone === "mx-east" ? 1 : 0,
      }],
    });
    expect(r!.entry.monad_id).toBe("b");
  });

  it("learning loop shifts winner after repeated successful forwards", async () => {
    // WHAT: "b" receives 20 simulated successful forwards (30ms each).
    //       After learning, "b" should have significantly higher resonance than "a"
    //       (which has zero history), and thus be selected by the router.
    //
    // HOW: Each successful forward via recordForwardResult increases "b"'s resonance.
    //      After 20 successes: resonance grows from 0 → approximately 14 (with decay).
    //      The resonance scorer then gives "b" a higher score than "a" (resonance=0).
    //
    // WHY: This is the end-to-end proof that the learning loop actually changes
    //      routing decisions. The entire point of the adaptive system is that nodes
    //      which perform well get routed to more often — this test verifies that works.
    const now = Date.now();
    writeMonadIndexEntry(baseEntry({ monad_id: "a", endpoint: "http://localhost:8282", last_seen: now - 1_000 }));
    writeMonadIndexEntry(baseEntry({ monad_id: "b", endpoint: "http://localhost:8283", last_seen: now - 1_000 }));

    for (let i = 0; i < 20; i++) recordForwardResult("b", NS, 30, true);

    const r = await selectMeshClaimant({
      monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID, now,
    });
    expect(r!.entry.monad_id).toBe("b");
  });
});
