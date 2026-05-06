/**
 * =============================================================================
 * tests/NRP/learningLoop.test.ts
 * =============================================================================
 *
 * WHAT IS THIS FILE?
 * ------------------
 * These are the smoke tests for the NRP adaptive learning loop. They verify
 * that the full pipeline — from recording a routing decision through to
 * updating scorer weights — works correctly end-to-end.
 *
 * WHAT IS THE LEARNING LOOP?
 * --------------------------
 * When monad.ai routes a request to another node, it picks the best node
 * using three scorer weights (latency, recency, resonance). After the request
 * finishes, the system sees whether it succeeded and how fast it was. It then
 * adjusts the weights slightly so that the next request is routed better.
 *
 * Over hundreds of requests, this turns the weights from their defaults into
 * values that reflect the actual behavior of your specific mesh.
 *
 * THE FULL PIPELINE (5 steps)
 * ----------------------------
 * Step 1 — selectMeshClaimant() picks a node and records which scorer values
 *           contributed to that decision.
 * Step 2 — recordDecision() saves a snapshot: which node was chosen, what
 *           its scores were, and what the runner-up was.
 * Step 3 — The HTTP request is forwarded to the chosen node.
 * Step 4 — correlateOutcome() receives the result: success/failure + latency.
 * Step 5 — updateAdaptiveWeights() adjusts the three weights based on the
 *           result.
 *
 * These tests cover Steps 2, 4, and 5. Steps 1 and 3 require a live server.
 *
 * WHY THESE TESTS ARE IRREFUTABLE
 * --------------------------------
 * Every assertion is derived from the exact mathematical formula in the code.
 * We show the formula and the step-by-step calculation in comments so you can
 * verify the expected value with a calculator. If any test fails, the
 * implementation is wrong — not the test.
 *
 * THE TWO KEY FORMULAS
 * --------------------
 * (1) Weight update — called after every correlated outcome:
 *
 *     Δweight = α × reward × contribution
 *     new_weight = max(WEIGHT_MIN, old_weight + Δweight)
 *
 *     Where:
 *       α (LEARNING_RATE) = 0.01
 *       WEIGHT_MIN        = 0.01   (no scorer can disappear entirely)
 *       contribution      = how much this scorer influenced the decision
 *
 * (2) Reward — computed from the request outcome:
 *
 *     reward = qualityWeight × rewardQuality + (1 − qualityWeight) × rewardLatency
 *
 *     rewardQuality = success ? +1.0 : −1.0
 *     rewardLatency = success ? max(0, 1 − latencyMs / 5000) : 0
 *     qualityWeight = 0.7 (default; controls how much correctness outweighs speed)
 *
 *     Concrete examples:
 *       fast success  (0 ms)    → 0.7 × 1.0 + 0.3 × 1.0  = 1.000
 *       medium success (2500ms) → 0.7 × 1.0 + 0.3 × 0.5  = 0.850
 *       slow success  (5000ms)  → 0.7 × 1.0 + 0.3 × 0.0  = 0.700
 *       failure (any latency)   → 0.7 × −1.0 + 0.3 × 0   = −0.700
 * =============================================================================
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WEIGHTS,
  LEARNING_RATE,
  WEIGHT_MIN,
  getWeightReport,
  readAdaptiveWeights,
  resetAdaptiveWeightsForTests,
  updateAdaptiveWeights,
} from "../../src/kernel/adaptiveWeights.js";
import {
  correlateOutcome,
  recordDecision,
  resetDecisionLogForTests,
} from "../../src/kernel/decisionLog.js";
import type { ScorerBreakdown } from "../../src/kernel/scoring.js";

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

/**
 * A realistic scorer breakdown matching what selectMeshClaimant produces.
 * The three contributions sum to approximately the total score.
 *
 * resonance:  value=0.80, contribution = 0.80 × 0.40 = 0.320
 * recency:    value=0.90, contribution = 0.90 × 0.35 = 0.315
 * latency:    value=0.70, contribution = 0.70 × 0.25 = 0.175
 * total score ≈ 0.810
 */
const REALISTIC_BREAKDOWN: Record<string, ScorerBreakdown> = {
  resonance: { value: 0.80, weight: 0.40, contribution: 0.320 },
  recency:   { value: 0.90, weight: 0.35, contribution: 0.315 },
  latency:   { value: 0.70, weight: 0.25, contribution: 0.175 },
};

/**
 * A breakdown where only resonance contributes — simplifies exact calculations
 * because we only need to track one scorer's weight change.
 */
const RESONANCE_ONLY_BREAKDOWN: Record<string, ScorerBreakdown> = {
  resonance: { value: 1.0, weight: 1.0, contribution: 1.0 },
  recency:   { value: 0.0, weight: 0.0, contribution: 0.0 },
  latency:   { value: 0.0, weight: 0.0, contribution: 0.0 },
};

/**
 * A breakdown where only latency contributes — used for "punish latency" tests.
 */
const LATENCY_ONLY_BREAKDOWN: Record<string, ScorerBreakdown> = {
  latency:   { value: 1.0, weight: 1.0, contribution: 1.0 },
  recency:   { value: 0.0, weight: 0.0, contribution: 0.0 },
  resonance: { value: 0.0, weight: 0.0, contribution: 0.0 },
};

/** Unique counter so each test gets its own decisionId — prevents cross-test leakage. */
let counter = 0;
function nextId(): string {
  return `test:${++counter}`;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetAdaptiveWeightsForTests();
  resetDecisionLogForTests();
});

// ===========================================================================
// Section 1 — The gradient step formula
//
// These tests verify the core weight update math. Each test shows the exact
// formula and expected value so the assertion can be verified by hand.
// ===========================================================================

describe("Section 1 — Gradient step formula", () => {
  it("a successful outcome with full contribution increases a scorer weight by exactly α × reward × contribution", () => {
    /**
     * PROOF:
     *   Δweight = LEARNING_RATE × reward × contribution
     *           = 0.01 × 1.0 × 1.0 = 0.01
     *   new resonance = DEFAULT (0.40) + 0.01 = 0.41 exactly
     */
    updateAdaptiveWeights(1.0, RESONANCE_ONLY_BREAKDOWN);
    const { current } = getWeightReport();
    expect(current.resonance).toBeCloseTo(0.41, 5);
  });

  it("a failed outcome with full contribution decreases a scorer weight by exactly α × |reward| × contribution", () => {
    /**
     * PROOF:
     *   Δweight = 0.01 × (−0.70) × 1.0 = −0.007
     *   new resonance = 0.40 − 0.007 = 0.393 exactly
     */
    updateAdaptiveWeights(-0.70, RESONANCE_ONLY_BREAKDOWN);
    const { current } = getWeightReport();
    expect(current.resonance).toBeCloseTo(0.393, 5);
  });

  it("a contribution of zero produces no weight change regardless of reward", () => {
    /**
     * PROOF:
     *   Δweight = 0.01 × 1.0 × 0.0 = 0.00 for every scorer
     *   All weights stay at their defaults.
     *
     * This is the "no learning" scenario: the scoring engine assigned zero
     * contribution to every scorer (e.g. all claimants had the same score).
     */
    const zeroContrib: Record<string, ScorerBreakdown> = {
      resonance: { value: 0.0, weight: 0.40, contribution: 0.0 },
      recency:   { value: 0.0, weight: 0.35, contribution: 0.0 },
      latency:   { value: 0.0, weight: 0.25, contribution: 0.0 },
    };
    updateAdaptiveWeights(1.0, zeroContrib);
    const { current } = getWeightReport();
    expect(current.resonance).toBeCloseTo(DEFAULT_WEIGHTS.resonance!, 5);
    expect(current.recency).toBeCloseTo(DEFAULT_WEIGHTS.recency!, 5);
    expect(current.latency).toBeCloseTo(DEFAULT_WEIGHTS.latency!, 5);
  });

  it("a reward of zero is a complete no-op — updateCount does not increment", () => {
    /**
     * reward = 0 means the outcome perfectly cancelled out (impossible in
     * normal operation but possible via env-var tuning). The update is skipped
     * entirely so the weight store is not touched.
     */
    updateAdaptiveWeights(0, RESONANCE_ONLY_BREAKDOWN);
    const { updateCount, current } = getWeightReport();
    expect(updateCount).toBe(0);
    expect(current.resonance).toBeCloseTo(DEFAULT_WEIGHTS.resonance!, 5);
  });

  it("a NaN reward is a no-op — guards against corrupted signal from external code", () => {
    /**
     * If something upstream produces NaN (e.g. 0/0 in a custom scorer),
     * the weight update must be skipped entirely. NaN propagates and would
     * corrupt all weights permanently if allowed through.
     */
    updateAdaptiveWeights(NaN, RESONANCE_ONLY_BREAKDOWN);
    const { updateCount } = getWeightReport();
    expect(updateCount).toBe(0);
  });

  it("a NaN contribution is skipped individually — other scorers are still updated", () => {
    /**
     * If one scorer's contribution is NaN but others are valid, only that
     * scorer is skipped. The guard is per-scorer, not per-update.
     */
    const mixed: Record<string, ScorerBreakdown> = {
      resonance: { value: 1.0, weight: 0.40, contribution: NaN },
      latency:   { value: 1.0, weight: 0.25, contribution: 1.0 },
      recency:   { value: 0.0, weight: 0.35, contribution: 0.0 },
    };
    updateAdaptiveWeights(1.0, mixed);
    const { current } = getWeightReport();
    // resonance: NaN contribution → skipped → stays at default
    expect(current.resonance).toBeCloseTo(DEFAULT_WEIGHTS.resonance!, 5);
    // latency: valid contribution=1.0 → Δ = 0.01 × 1.0 × 1.0 = 0.01
    expect(current.latency).toBeCloseTo(DEFAULT_WEIGHTS.latency! + 0.01, 5);
  });

  it("the learning rate parameter controls the step size", () => {
    /**
     * PROOF (with learningRate=0.05, 5× normal speed):
     *   Δweight = 0.05 × 1.0 × 1.0 = 0.05
     *   new resonance = 0.40 + 0.05 = 0.45 exactly
     *
     * This is used in tests to drive weights to extreme values quickly
     * without thousands of iterations.
     */
    updateAdaptiveWeights(1.0, RESONANCE_ONLY_BREAKDOWN, 0.05);
    const { current } = getWeightReport();
    expect(current.resonance).toBeCloseTo(0.45, 5);
  });
});

// ===========================================================================
// Section 2 — Weight boundaries
//
// The weight floor (WEIGHT_MIN = 0.01) ensures no scorer is completely
// ignored. Even after many failures, a scorer keeps 1% influence so it
// can recover if it becomes useful again.
// ===========================================================================

describe("Section 2 — Weight floor and recovery", () => {
  it("weight never falls below WEIGHT_MIN no matter how many failures accumulate", () => {
    /**
     * With learningRate=0.1 and reward=-0.70 and contribution=1.0:
     *   Each step: Δ = 0.1 × (−0.70) × 1.0 = −0.07
     *   latency: 0.25 → 0.18 → 0.11 → 0.04 → floor at 0.01
     *
     * After 200 steps, the floor must still hold.
     */
    for (let i = 0; i < 200; i++) {
      updateAdaptiveWeights(-0.70, LATENCY_ONLY_BREAKDOWN, 0.1);
    }
    const { current } = getWeightReport();
    expect(current.latency).toBeGreaterThanOrEqual(WEIGHT_MIN);
    expect(current.latency).toBeCloseTo(WEIGHT_MIN, 5);
  });

  it("a floored scorer recovers with positive rewards", () => {
    /**
     * Drive latency to WEIGHT_MIN, then apply positive rewards.
     * The weight must climb back above the floor.
     *
     * Recovery step: Δ = 0.01 × 1.0 × 1.0 = +0.01
     * After one positive update: WEIGHT_MIN + 0.01 = 0.02
     */
    // Floor it first
    for (let i = 0; i < 200; i++) {
      updateAdaptiveWeights(-0.70, LATENCY_ONLY_BREAKDOWN, 0.1);
    }
    expect(readAdaptiveWeights().latency).toBeCloseTo(WEIGHT_MIN, 5);

    // Apply one positive update
    updateAdaptiveWeights(1.0, LATENCY_ONLY_BREAKDOWN);
    const { current } = getWeightReport();
    expect(current.latency).toBeGreaterThan(WEIGHT_MIN);
    expect(current.latency).toBeCloseTo(WEIGHT_MIN + LEARNING_RATE * 1.0 * 1.0, 5);
  });

  it("all three scorers can be floored and they are all individually clamped", () => {
    /**
     * When all scorers receive equal negative pressure, each hits its own
     * floor independently. No scorer's floor affects another.
     */
    const allContrib: Record<string, ScorerBreakdown> = {
      resonance: { value: 1.0, weight: 0.40, contribution: 1.0 },
      recency:   { value: 1.0, weight: 0.35, contribution: 1.0 },
      latency:   { value: 1.0, weight: 0.25, contribution: 1.0 },
    };
    for (let i = 0; i < 200; i++) {
      updateAdaptiveWeights(-0.70, allContrib, 0.1);
    }
    const { current } = getWeightReport();
    expect(current.resonance).toBeGreaterThanOrEqual(WEIGHT_MIN);
    expect(current.recency).toBeGreaterThanOrEqual(WEIGHT_MIN);
    expect(current.latency).toBeGreaterThanOrEqual(WEIGHT_MIN);
  });
});

// ===========================================================================
// Section 3 — updateCount tracks every correlated outcome
//
// updateCount is the total number of gradient steps applied. It rises by
// exactly 1 per call when reward ≠ 0. This is used by the health system
// to detect "no learning" (count up but weights flat).
// ===========================================================================

describe("Section 3 — updateCount accounting", () => {
  it("starts at zero with no updates", () => {
    expect(getWeightReport().updateCount).toBe(0);
  });

  it("increments by exactly 1 for each non-zero reward update", () => {
    updateAdaptiveWeights(1.0, RESONANCE_ONLY_BREAKDOWN);
    expect(getWeightReport().updateCount).toBe(1);
    updateAdaptiveWeights(-0.70, RESONANCE_ONLY_BREAKDOWN);
    expect(getWeightReport().updateCount).toBe(2);
    updateAdaptiveWeights(0.85, RESONANCE_ONLY_BREAKDOWN);
    expect(getWeightReport().updateCount).toBe(3);
  });

  it("does NOT increment when reward is zero (the update is skipped entirely)", () => {
    updateAdaptiveWeights(0, RESONANCE_ONLY_BREAKDOWN);
    expect(getWeightReport().updateCount).toBe(0);
  });

  it("does NOT increment when reward is NaN (the update is skipped entirely)", () => {
    updateAdaptiveWeights(NaN, RESONANCE_ONLY_BREAKDOWN);
    expect(getWeightReport().updateCount).toBe(0);
  });

  it("counts 10 updates correctly after 10 calls", () => {
    for (let i = 0; i < 10; i++) {
      updateAdaptiveWeights(1.0, RESONANCE_ONLY_BREAKDOWN);
    }
    expect(getWeightReport().updateCount).toBe(10);
  });
});

// ===========================================================================
// Section 4 — Reward formula (verified through weight changes)
//
// The reward formula converts a request outcome into a number in [−0.7, 1.0].
// We verify each case by computing the reward that correlateOutcome must have
// used, inferred from the exact weight change it caused.
//
// This is the irrefutable approach: if the weight changed by the right amount,
// then the reward must have been computed correctly.
//
// Default qualityWeight = 0.7 (set by MONAD_LEARNING_QUALITY_WEIGHT).
// ===========================================================================

describe("Section 4 — Reward formula (end-to-end via correlateOutcome)", () => {
  /**
   * SETUP: we use RESONANCE_ONLY_BREAKDOWN with contribution=1.0 so that
   * the weight change equals exactly α × reward × 1.0 = 0.01 × reward.
   * This means:
   *   observed Δweight = expected reward × 0.01
   *   observed new weight = 0.40 + (reward × 0.01)
   *
   * If the observed weight matches, the reward formula is correct.
   */

  it("fast success (0 ms) produces reward = 1.0 → resonance increases by exactly 0.01", () => {
    /**
     * reward = 0.7 × 1.0 + 0.3 × (1 − 0/5000) = 0.7 + 0.3 = 1.000
     * Δresonance = 0.01 × 1.000 × 1.0 = 0.01000
     * new resonance = 0.40 + 0.01 = 0.41000
     */
    const id = nextId();
    recordDecision({
      decisionId: id, timestamp: Date.now(), namespace: "ns",
      monadId: "frank", score: 0.90, margin: 0.10, breakdown: RESONANCE_ONLY_BREAKDOWN,
    });
    correlateOutcome(id, 0, true);
    expect(getWeightReport().current.resonance).toBeCloseTo(0.41000, 4);
  });

  it("medium success (2500 ms) produces reward = 0.85 → resonance increases by exactly 0.0085", () => {
    /**
     * reward = 0.7 × 1.0 + 0.3 × (1 − 2500/5000) = 0.7 + 0.15 = 0.850
     * Δresonance = 0.01 × 0.850 × 1.0 = 0.00850
     * new resonance = 0.40 + 0.0085 = 0.40850
     */
    const id = nextId();
    recordDecision({
      decisionId: id, timestamp: Date.now(), namespace: "ns",
      monadId: "frank", score: 0.90, margin: 0.10, breakdown: RESONANCE_ONLY_BREAKDOWN,
    });
    correlateOutcome(id, 2500, true);
    expect(getWeightReport().current.resonance).toBeCloseTo(0.40850, 4);
  });

  it("slow success (5000 ms) produces reward = 0.70 → resonance increases by exactly 0.007", () => {
    /**
     * reward = 0.7 × 1.0 + 0.3 × (1 − 5000/5000) = 0.7 + 0.3 × 0 = 0.700
     * Δresonance = 0.01 × 0.700 × 1.0 = 0.00700
     * new resonance = 0.40 + 0.007 = 0.40700
     */
    const id = nextId();
    recordDecision({
      decisionId: id, timestamp: Date.now(), namespace: "ns",
      monadId: "frank", score: 0.90, margin: 0.10, breakdown: RESONANCE_ONLY_BREAKDOWN,
    });
    correlateOutcome(id, 5000, true);
    expect(getWeightReport().current.resonance).toBeCloseTo(0.40700, 4);
  });

  it("very slow success (10000 ms) still produces reward = 0.70 — latency term floors at zero", () => {
    /**
     * reward = 0.7 × 1.0 + 0.3 × max(0, 1 − 10000/5000) = 0.7 + 0 = 0.700
     * The latency reward cannot go below zero, so anything beyond 5000ms
     * gives the same reward as exactly 5000ms.
     * new resonance = 0.40 + 0.007 = 0.40700
     */
    const id = nextId();
    recordDecision({
      decisionId: id, timestamp: Date.now(), namespace: "ns",
      monadId: "frank", score: 0.90, margin: 0.10, breakdown: RESONANCE_ONLY_BREAKDOWN,
    });
    correlateOutcome(id, 10_000, true);
    expect(getWeightReport().current.resonance).toBeCloseTo(0.40700, 4);
  });

  it("failure produces reward = −0.70 regardless of latency → resonance decreases by exactly 0.007", () => {
    /**
     * reward = 0.7 × (−1.0) + 0.3 × 0 = −0.700
     * (latency term is always 0 for failures — we don't reward speed on a
     * failed request because the response was incorrect)
     * Δresonance = 0.01 × (−0.700) × 1.0 = −0.00700
     * new resonance = 0.40 − 0.007 = 0.39300
     */
    const id = nextId();
    recordDecision({
      decisionId: id, timestamp: Date.now(), namespace: "ns",
      monadId: "frank", score: 0.90, margin: 0.10, breakdown: RESONANCE_ONLY_BREAKDOWN,
    });
    correlateOutcome(id, 0, false); // fast failure — latency doesn't matter
    expect(getWeightReport().current.resonance).toBeCloseTo(0.39300, 4);
  });

  it("failure at high latency still produces reward = −0.70 — no additional penalty for slow failures", () => {
    /**
     * reward = 0.7 × (−1.0) + 0.3 × 0 = −0.700
     * Slow failures are penalized the same as fast ones. The correctness
     * error is the signal; latency data on failures is meaningless.
     * new resonance = 0.40 − 0.007 = 0.39300
     */
    const id = nextId();
    recordDecision({
      decisionId: id, timestamp: Date.now(), namespace: "ns",
      monadId: "frank", score: 0.90, margin: 0.10, breakdown: RESONANCE_ONLY_BREAKDOWN,
    });
    correlateOutcome(id, 9_999, false); // very slow failure
    expect(getWeightReport().current.resonance).toBeCloseTo(0.39300, 4);
  });
});

// ===========================================================================
// Section 5 — Full pipeline (recordDecision → correlateOutcome → weight shift)
//
// These tests exercise the complete data flow, not just individual functions.
// They verify that decisions recorded by the bridge and correlated by the
// outcome handler reach the weight store with correct values.
// ===========================================================================

describe("Section 5 — Full pipeline integration", () => {
  it("a successful forward shifts all three scorer weights in the positive direction", () => {
    /**
     * GIVEN: default weights (latency=0.25, recency=0.35, resonance=0.40)
     * WHEN:  a decision with REALISTIC_BREAKDOWN is correlated as fast success (0ms)
     * THEN:  all three weights must increase
     *
     * reward = 1.0 (fast success)
     * Δresonance = 0.01 × 1.0 × 0.320 = 0.00320  → 0.40320
     * Δrecency   = 0.01 × 1.0 × 0.315 = 0.00315  → 0.35315
     * Δlatency   = 0.01 × 1.0 × 0.175 = 0.00175  → 0.25175
     */
    const id = nextId();
    recordDecision({
      decisionId: id, timestamp: Date.now(), namespace: "ns",
      monadId: "frank", score: 0.81, margin: 0.15, breakdown: REALISTIC_BREAKDOWN,
    });
    correlateOutcome(id, 0, true);
    const { current } = getWeightReport();
    expect(current.resonance).toBeCloseTo(0.40320, 4);
    expect(current.recency).toBeCloseTo(0.35315, 4);
    expect(current.latency).toBeCloseTo(0.25175, 4);
  });

  it("a failed forward shifts all three scorer weights in the negative direction", () => {
    /**
     * reward = −0.70 (failure)
     * Δresonance = 0.01 × (−0.70) × 0.320 = −0.00224  → 0.39776
     * Δrecency   = 0.01 × (−0.70) × 0.315 = −0.002205 → 0.347795
     * Δlatency   = 0.01 × (−0.70) × 0.175 = −0.001225 → 0.248775
     */
    const id = nextId();
    recordDecision({
      decisionId: id, timestamp: Date.now(), namespace: "ns",
      monadId: "frank", score: 0.81, margin: 0.15, breakdown: REALISTIC_BREAKDOWN,
    });
    correlateOutcome(id, 500, false);
    const { current } = getWeightReport();
    expect(current.resonance).toBeCloseTo(0.39776, 4);
    expect(current.recency).toBeCloseTo(0.34780, 3);
    expect(current.latency).toBeCloseTo(0.24878, 3);
  });

  it("correlating an unknown decisionId is a safe no-op — weights are unchanged", () => {
    /**
     * If the bridge calls correlateOutcome with an ID it never recorded
     * (e.g. after a restart), nothing should happen. This ensures the
     * system degrades gracefully instead of crashing or corrupting weights.
     */
    correlateOutcome("completely-unknown-id", 100, true);
    const { updateCount, current } = getWeightReport();
    expect(updateCount).toBe(0);
    expect(current.resonance).toBeCloseTo(DEFAULT_WEIGHTS.resonance!, 5);
  });

  it("correlating the same decisionId twice is a no-op on the second call", () => {
    /**
     * The pending map removes the entry after the first correlation. A second
     * call with the same ID finds nothing and returns without updating weights.
     * This prevents double-counting if the bridge has a retry path.
     */
    const id = nextId();
    recordDecision({
      decisionId: id, timestamp: Date.now(), namespace: "ns",
      monadId: "frank", score: 0.90, margin: 0.10, breakdown: RESONANCE_ONLY_BREAKDOWN,
    });
    correlateOutcome(id, 0, true);
    const afterFirst = getWeightReport().current.resonance;

    correlateOutcome(id, 0, true); // second call with same ID
    const afterSecond = getWeightReport().current.resonance;

    // Weight must not change on the second call
    expect(afterSecond).toBeCloseTo(afterFirst, 10);
  });

  it("an empty breakdown does not update weights — the guard prevents no-op iterations", () => {
    /**
     * If the breakdown is empty (no scorers contributed), there is nothing
     * to learn from. The update is skipped to avoid a meaningless updateCount
     * increment.
     */
    const id = nextId();
    recordDecision({
      decisionId: id, timestamp: Date.now(), namespace: "ns",
      monadId: "frank", score: 0.90, margin: 0.10, breakdown: {},
    });
    correlateOutcome(id, 0, true);
    expect(getWeightReport().updateCount).toBe(0);
  });

  it("multiple sequential decisions update weights cumulatively and independently", () => {
    /**
     * Two sequential requests, each correlated independently:
     * Request 1: success → all weights increase
     * Request 2: failure → all weights decrease (but net must reflect the sum)
     *
     * After request 1 (reward = 1.0):
     *   resonance = 0.40 + 0.01 × 1.0 × 0.32 = 0.40320
     *
     * After request 2 (reward = −0.70, applied to updated weights):
     *   resonance = 0.40320 + 0.01 × (−0.70) × 0.32 = 0.40320 − 0.00224 = 0.40096
     */
    const id1 = nextId();
    recordDecision({
      decisionId: id1, timestamp: Date.now(), namespace: "ns",
      monadId: "frank", score: 0.81, margin: 0.15, breakdown: REALISTIC_BREAKDOWN,
    });
    correlateOutcome(id1, 0, true);

    const id2 = nextId();
    recordDecision({
      decisionId: id2, timestamp: Date.now(), namespace: "ns",
      monadId: "frank", score: 0.81, margin: 0.15, breakdown: REALISTIC_BREAKDOWN,
    });
    correlateOutcome(id2, 500, false);

    const { current, updateCount } = getWeightReport();
    expect(updateCount).toBe(2);
    expect(current.resonance).toBeCloseTo(0.40096, 4);
  });
});

// ===========================================================================
// Section 6 — Cumulative learning over many requests
//
// After many requests in the same direction, weights converge toward that
// direction. This is the "learning" in the learning loop. We verify both
// the direction and the magnitude of convergence.
// ===========================================================================

describe("Section 6 — Convergence over many requests", () => {
  it("10 consecutive fast successes with full resonance contribution accumulate exactly", () => {
    /**
     * Each update: Δresonance = 0.01 × 1.0 × 1.0 = 0.01
     * After 10: resonance = 0.40 + (10 × 0.01) = 0.50 exactly
     *
     * This proves the updates are truly additive and there is no decay
     * or averaging that would reduce the cumulative effect.
     */
    for (let i = 0; i < 10; i++) {
      updateAdaptiveWeights(1.0, RESONANCE_ONLY_BREAKDOWN);
    }
    const { current } = getWeightReport();
    expect(current.resonance).toBeCloseTo(0.50, 5);
  });

  it("consistent failures push a scorer toward its floor from the default weight", () => {
    /**
     * Starting from default (latency = 0.25):
     * Each failure: Δlatency = 0.01 × (−0.70) × 1.0 = −0.007
     * After 35 failures: 0.25 − (35 × 0.007) = 0.25 − 0.245 = 0.005
     *   → clamped to WEIGHT_MIN = 0.01
     *
     * We check that after 35 updates, latency is at or very near the floor.
     */
    for (let i = 0; i < 35; i++) {
      updateAdaptiveWeights(-0.70, LATENCY_ONLY_BREAKDOWN);
    }
    const { current } = getWeightReport();
    expect(current.latency).toBeCloseTo(WEIGHT_MIN, 5);
  });

  it("positive outcomes for resonance shift the routing preference toward resonance-heavy nodes", () => {
    /**
     * After many successes where resonance was the top contributor, the
     * resonance weight grows above its default. This means the system now
     * prefers nodes with high resonance over nodes with high recency or latency.
     *
     * We verify the relative ordering: resonance > recency > latency
     * (the default ordering, but more pronounced after learning).
     */
    for (let i = 0; i < 20; i++) {
      updateAdaptiveWeights(1.0, RESONANCE_ONLY_BREAKDOWN);
    }
    const { current } = getWeightReport();
    // resonance grew from 0.40 → 0.60; others stayed at defaults
    expect(current.resonance).toBeGreaterThan(current.recency!);
    expect(current.resonance).toBeGreaterThan(current.latency!);
    expect(current.resonance).toBeCloseTo(0.60, 5);
  });

  it("the delta report accurately reflects cumulative learning", () => {
    /**
     * After 5 successes favoring resonance and 5 failures on latency:
     *   delta.resonance = +5 × 0.01 = +0.05 (positive = reinforced)
     *   delta.latency   = 5 × (−0.007) = −0.035 (negative = penalized)
     *   delta.recency   = 0 (not involved in either breakdown)
     */
    for (let i = 0; i < 5; i++) {
      updateAdaptiveWeights(1.0, RESONANCE_ONLY_BREAKDOWN);
    }
    for (let i = 0; i < 5; i++) {
      updateAdaptiveWeights(-0.70, LATENCY_ONLY_BREAKDOWN);
    }
    const { delta } = getWeightReport();
    expect(delta.resonance).toBeCloseTo(+0.05, 5);
    expect(delta.latency).toBeCloseTo(-0.035, 5);
    expect(delta.recency).toBeCloseTo(0.0, 5);
  });
});

// ===========================================================================
// Section 7 — Health signals during realistic traffic
//
// The WeightHealth signals (noLearning, oscillation) help you detect when
// the learning loop is stalled or confused. These tests verify that the
// signals fire at the right time and stay quiet when the loop is healthy.
// ===========================================================================

describe("Section 7 — Health signals during learning", () => {
  it("noLearning is false after 10 updates with real contribution (weights moved)", () => {
    /**
     * The system ran 10 updates that actually changed the weights.
     * noLearning must be false because max(|delta|) = 0.10 >> 0.002 threshold.
     */
    for (let i = 0; i < 10; i++) {
      updateAdaptiveWeights(1.0, RESONANCE_ONLY_BREAKDOWN);
    }
    expect(getWeightReport().health.noLearning).toBe(false);
  });

  it("noLearning fires after 10 updates where all contributions were zero", () => {
    /**
     * Zero-contribution breakdowns call updateAdaptiveWeights but no weight
     * changes because Δ = α × reward × 0 = 0. The updateCount still rises,
     * so after 10 updates noLearning = true (updates ran, nothing moved).
     *
     * This is the "bridge is wired but scoring returns no contribution" scenario.
     */
    const zeroBreakdown: Record<string, ScorerBreakdown> = {
      resonance: { value: 0.0, weight: 0.40, contribution: 0.0 },
      recency:   { value: 0.0, weight: 0.35, contribution: 0.0 },
      latency:   { value: 0.0, weight: 0.25, contribution: 0.0 },
    };
    for (let i = 0; i < 10; i++) {
      updateAdaptiveWeights(1.0, zeroBreakdown);
    }
    const { health, updateCount } = getWeightReport();
    expect(updateCount).toBe(10);
    expect(health.noLearning).toBe(true);
  });

  it("oscillation is false during consistent success traffic", () => {
    /**
     * 10 consecutive successes → reward = +1.0 each time.
     * Reward history is [1,1,1,1,1,1,1,1,1,1] — zero sign changes.
     * Oscillation threshold: >40% sign changes → 0/9 = 0% here → false.
     */
    for (let i = 0; i < 10; i++) {
      updateAdaptiveWeights(1.0, RESONANCE_ONLY_BREAKDOWN);
    }
    expect(getWeightReport().health.oscillation).toBe(false);
  });

  it("oscillation fires when reward alternates success/failure on every step", () => {
    /**
     * Alternating +1.0 / −0.70 / +1.0 / −0.70 ...
     * This simulates two equally matched nodes where one succeeds then
     * the other fails in round-robin fashion.
     *
     * Sign changes: every step → 9/9 = 100% > 40% threshold → fires.
     */
    for (let i = 0; i < 10; i++) {
      updateAdaptiveWeights(i % 2 === 0 ? 1.0 : -0.70, RESONANCE_ONLY_BREAKDOWN);
    }
    expect(getWeightReport().health.oscillation).toBe(true);
  });

  it("stable is true before any learning (all deltas are within 5% of defaults)", () => {
    /**
     * At startup, no weights have moved. Every delta is 0, which is well
     * within 5% of any default. stable = true signals that the system
     * hasn't accumulated evidence yet — not necessarily a problem.
     */
    expect(getWeightReport().stable).toBe(true);
  });

  it("stable becomes false after meaningful learning (delta > 5% of default)", () => {
    /**
     * resonance default = 0.40
     * 5% threshold = 0.40 × 0.05 = 0.020
     * Each success step: Δ = 0.01
     * After 3 steps: delta.resonance = 0.03 > 0.020 → stable = false
     */
    for (let i = 0; i < 3; i++) {
      updateAdaptiveWeights(1.0, RESONANCE_ONLY_BREAKDOWN);
    }
    expect(getWeightReport().stable).toBe(false);
  });
});
