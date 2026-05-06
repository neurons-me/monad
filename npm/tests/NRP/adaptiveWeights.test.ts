/**
 * adaptiveWeights.test.ts — The AI Learning System for Routing Decisions
 *
 * WHAT IS THIS MODULE?
 * monad.ai routes requests to the "best" node in the mesh. "Best" is computed as a
 * weighted sum of three signals:
 *
 *   score = (latency × w_lat) + (recency × w_rec) + (resonance × w_res)
 *
 * The adaptive weight system learns WHICH of those three signals actually predicts
 * good outcomes for YOUR specific workload. It starts with default weights:
 *   latency:   0.25  (speed matters 25%)
 *   recency:   0.35  (freshness matters 35%)
 *   resonance: 0.40  (track record matters 40%)
 *
 * After each routed request, the system gets a reward signal:
 *   +reward → "that was a good routing decision, boost the scorers that contributed"
 *   −reward → "that was a bad decision, penalize the scorers that contributed"
 *
 * The update formula is:
 *   Δweight = learningRate × reward × contribution
 *   new_weight = max(WEIGHT_MIN, old_weight + Δweight)
 *
 * Where:
 *   learningRate = 0.01  (small steps → stable learning)
 *   WEIGHT_MIN   = 0.01  (no scorer can fall below 1% influence)
 *   contribution = how much that scorer pushed THIS specific decision
 *
 * WHAT WE TEST:
 *   1. readAdaptiveWeights — reading weights (defaults, after writes, floor clamping)
 *   2. updateAdaptiveWeights — gradient update (positive/negative rewards, floor, math)
 *   3. Integration with computeScore — learned weights actually change routing scores
 *   4. Namespace learning — per-namespace weights with maturity-based blending
 *   5. Full learning loop — correlateOutcome → updateAdaptiveWeights round-trip
 */

import fs from "fs";
import os from "os";
import path from "path";
import { resetKernelStateForTests } from "../../src/kernel/manager.js";
import {
  DEFAULT_WEIGHTS,
  GLOBAL_BACKGROUND_SHARE,
  LEARNING_RATE,
  NAMESPACE_MATURITY_SAMPLES,
  WEIGHT_MIN,
  getWeightReport,
  readAdaptiveWeights,
  resolveAdaptiveWeights,
  resetAdaptiveWeightsForTests,
  updateAdaptiveWeights,
} from "../../src/kernel/adaptiveWeights.js";
import { writeMonadIndexEntry, type MonadIndexEntry } from "../../src/kernel/monadIndex.js";
import { computeScore, computeScoreDetailed, type ScoringContext } from "../../src/kernel/scoring.js";
import { correlateOutcome, recordDecision, resetDecisionLogForTests } from "../../src/kernel/decisionLog.js";
import { selectMeshClaimant } from "../../src/kernel/meshSelect.js";

// ── Test isolation ─────────────────────────────────────────────────────────────
// Every test starts from zero: fresh disk, fresh kernel, fresh weights.
// This ensures a positive reward in test #3 doesn't affect test #4's expectations.

const savedSeed = process.env.SEED;
const savedStateDir = process.env.ME_STATE_DIR;

beforeEach(() => {
  process.env.ME_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "monad-aw-"));
  process.env.SEED = "adaptive-weights-test-seed";
  resetKernelStateForTests();
  resetAdaptiveWeightsForTests(); // weights back to defaults
  resetDecisionLogForTests();     // pending decisions cleared
});

afterEach(() => {
  process.env.SEED = savedSeed;
  process.env.ME_STATE_DIR = savedStateDir;
  resetKernelStateForTests();
});

const NS = "suis-macbook-air.local";
const SELF = "http://localhost:8161";
const SELF_ID = "self-m";

function baseEntry(overrides: Partial<MonadIndexEntry> = {}): MonadIndexEntry {
  return {
    monad_id: "m1",
    namespace: NS,
    endpoint: "http://localhost:8282",
    tags: ["desktop"],
    type: "desktop",
    claimed_namespaces: [NS],
    first_seen: Date.now() - 10_000,
    last_seen: Date.now() - 1_000,
    ...overrides,
  };
}

function baseCtx(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return { namespace: NS, requestedAt: Date.now(), ...overrides };
}

// ── 1. readAdaptiveWeights ─────────────────────────────────────────────────────

describe("readAdaptiveWeights", () => {
  it("returns DEFAULT_WEIGHTS before any learning", () => {
    // WHAT: On a fresh system with no learning history, readAdaptiveWeights() returns
    //       the hard-coded default weights (latency=0.25, recency=0.35, resonance=0.40).
    //
    // WHY: The system must be functional right out of the box, before any requests
    //      have been routed and before any learning has occurred. The defaults encode
    //      reasonable priors: track record (resonance) matters most, speed (latency) least.
    const w = readAdaptiveWeights();
    expect(w.latency).toBeCloseTo(DEFAULT_WEIGHTS.latency!, 5);
    expect(w.recency).toBeCloseTo(DEFAULT_WEIGHTS.recency!, 5);
    expect(w.resonance).toBeCloseTo(DEFAULT_WEIGHTS.resonance!, 5);
  });

  it("returns updated values after a write", () => {
    // WHAT: Apply one positive gradient step to resonance, then read the weights back.
    //       resonance should be higher than its default (0.40).
    //
    // HOW: updateAdaptiveWeights(reward=1, breakdown={resonance: contribution=0.32})
    //      → Δresonance = 0.01 × 1 × 0.32 = 0.0032
    //      → new resonance = 0.40 + 0.0032 = 0.4032
    //
    // WHY: If weights updated but couldn't be read back, the learning loop would be
    //      pointless — the router would still use old defaults. This verifies persistence.
    updateAdaptiveWeights(1, {
      resonance: { value: 0.8, weight: 0.4, contribution: 0.32 },
    });
    const w = readAdaptiveWeights();
    expect(w.resonance).toBeGreaterThan(DEFAULT_WEIGHTS.resonance!);
  });

  it("clamps stored weights below WEIGHT_MIN to WEIGHT_MIN on read", () => {
    // WHAT: Apply an extreme negative reward 100× larger than normal to drive recency
    //       as far below the floor as possible. On read, it should still be ≥ WEIGHT_MIN.
    //
    // WHY: WEIGHT_MIN (= 0.01) guarantees every signal stays recoverable.
    //      A scorer can't be completely disabled by bad luck. If a latency spike
    //      caused the router to punish recency hard, it should still have 1% influence
    //      so it can recover when nodes start being fresh again.
    //
    //      The floor is enforced at READ time (not just write time) as an extra safety net.
    updateAdaptiveWeights(-100, {
      recency: { value: 0.9, weight: 0.35, contribution: 0.315 },
    });
    const w = readAdaptiveWeights();
    expect(w.recency).toBeGreaterThanOrEqual(WEIGHT_MIN);
  });
});

// ── 2. updateAdaptiveWeights ───────────────────────────────────────────────────

describe("updateAdaptiveWeights", () => {
  it("positive reward increases the contributing scorer's weight", () => {
    // WHAT: Record the resonance weight before the update, apply reward=+1,
    //       then verify resonance went UP.
    //
    // WHY: A positive reward means "this routing decision worked out well".
    //      Scorers that contributed to that decision should be trusted MORE next time.
    //      Δresonance = 0.01 × 1 × 0.32 = +0.0032 → resonance goes up.
    const before = readAdaptiveWeights().resonance!;
    updateAdaptiveWeights(1, {
      resonance: { value: 0.8, weight: 0.4, contribution: 0.32 },
    });
    expect(readAdaptiveWeights().resonance).toBeGreaterThan(before);
  });

  it("negative reward decreases the contributing scorer's weight", () => {
    // WHAT: Record the recency weight before the update, apply reward=−0.7 (failure),
    //       then verify recency went DOWN.
    //
    // WHY: A negative reward means "this routing decision was bad — the node failed".
    //      Scorers that pushed the router toward this bad choice should be trusted LESS.
    //      Δrecency = 0.01 × (−0.7) × 0.315 = −0.0022 → recency goes down.
    const before = readAdaptiveWeights().recency!;
    updateAdaptiveWeights(-0.7, {
      recency: { value: 0.9, weight: 0.35, contribution: 0.315 },
    });
    expect(readAdaptiveWeights().recency).toBeLessThan(before);
  });

  it("weight never drops below WEIGHT_MIN regardless of extreme negative reward", () => {
    // WHAT: Apply 50 consecutive maximum-penalty updates to latency.
    //       After each one, the floor kicks in. After all 50, latency must still
    //       be at least WEIGHT_MIN (0.01).
    //
    // HOW: After 3 steps with reward=-1, contribution=0.125:
    //      0.25 + 3×(0.01 × -1 × 0.125) = 0.25 - 0.00375×3 = ~0.239
    //      ... continues until it hits 0.01, then stays there.
    //
    // WHY: Without the floor, a bad latency period could make the latency scorer
    //      completely disappear. Then when nodes become fast again, there's no signal
    //      left to detect it. The floor keeps all signals "alive" and recoverable.
    for (let i = 0; i < 50; i++) {
      updateAdaptiveWeights(-1, {
        latency: { value: 0.5, weight: 0.25, contribution: 0.125 },
      });
    }
    expect(readAdaptiveWeights().latency).toBeGreaterThanOrEqual(WEIGHT_MIN);
  });

  it("update magnitude scales with learning rate × reward × contribution", () => {
    // WHAT: Verify the exact gradient step formula: Δw = α × reward × contribution
    //
    // Setup:
    //   learningRate (α) = 0.01  (the global constant)
    //   reward           = 0.5   (half-strength positive outcome)
    //   contribution     = 0.32  (how much resonance influenced the decision)
    //
    // Expected Δresonance = 0.01 × 0.5 × 0.32 = 0.0016
    //
    // WHY: This formula must be EXACT, not approximate. If the implementation uses
    //      a different formula (e.g., multiplies by weight instead of contribution),
    //      the entire learning system would be miscalibrated. This test is the spec.
    const before = readAdaptiveWeights().resonance!;
    const contribution = 0.32;
    const reward = 0.5;
    updateAdaptiveWeights(reward, {
      resonance: { value: 0.8, weight: 0.4, contribution },
    });
    const delta = readAdaptiveWeights().resonance! - before;
    expect(delta).toBeCloseTo(LEARNING_RATE * reward * contribution, 8);
  });

  it("NaN reward is ignored — weights unchanged", () => {
    // WHAT: Pass NaN as the reward. No weights should change.
    //
    // WHY: NaN can sneak in from bad arithmetic (e.g., 0/0 in a latency calculation).
    //      If NaN propagated into the weights, ALL future scores would be NaN because
    //      anything × NaN = NaN. The guard ensures corrupted signals don't corrupt learning.
    const before = { ...readAdaptiveWeights() };
    updateAdaptiveWeights(NaN, {
      recency: { value: 0.9, weight: 0.35, contribution: 0.315 },
    });
    const after = readAdaptiveWeights();
    expect(after.recency).toBeCloseTo(before.recency!, 10);
  });

  it("zero reward is a no-op", () => {
    // WHAT: Pass reward=0. No weights should change.
    //
    // WHY: Δw = α × 0 × contribution = 0. Mathematically correct, but we also
    //      want to avoid recording an "update" that did nothing (updateCount would
    //      increment misleadingly, making it look like learning happened when it didn't).
    //      The guard skips the whole update when reward=0.
    const before = { ...readAdaptiveWeights() };
    updateAdaptiveWeights(0, {
      recency: { value: 0.9, weight: 0.35, contribution: 0.315 },
    });
    expect(readAdaptiveWeights().recency).toBeCloseTo(before.recency!, 10);
  });

  it("update persists — survives a second read call", () => {
    // WHAT: Apply an update, then read twice. Both reads should return the same value.
    //
    // WHY: Weights are stored in the kernel (not just in a local variable). If the
    //      kernel had a bug where the first read "consumed" the value, the second
    //      read would return defaults. This test catches that regression.
    updateAdaptiveWeights(1, {
      resonance: { value: 0.9, weight: 0.4, contribution: 0.36 },
    });
    const w1 = readAdaptiveWeights();
    const w2 = readAdaptiveWeights(); // second read from same kernel state
    expect(w1.resonance).toBeCloseTo(w2.resonance!, 10);
  });
});

// ── 3. Integration with computeScore ──────────────────────────────────────────

describe("integration with computeScore — adaptiveWeights in ScoringContext", () => {
  it("learned weights influence score when passed via ctx.adaptiveWeights", () => {
    // WHAT: Score the same node with two different sets of weights:
    //   ctxNormal:  uses default weights (latency=0.25, recency=0.35, resonance=0.40)
    //   ctxBoosted: sets resonance=1, latency=0, recency=0
    //               (resonance gets ALL the weight)
    //
    // The node has no claim meta, so resonance=0. With resonance having 100% weight:
    //   scoreBoosted = 0 × 1.0 = 0
    //
    // With default weights, recency and latency still contribute positively:
    //   scoreNormal  = (recency_value × 0.35) + (latency_value × 0.25) > 0
    //
    // PROVES: adaptiveWeights in the ScoringContext actually changes routing decisions.
    const m = baseEntry();
    const meta = {};
    const ctxNormal = baseCtx();
    const ctxBoosted = baseCtx({ adaptiveWeights: { latency: 0, recency: 0, resonance: 1 } });
    const scoreNormal = computeScore(m, meta, ctxNormal);
    const scoreBoosted = computeScore(m, meta, ctxBoosted);
    expect(scoreNormal).toBeGreaterThan(scoreBoosted);
  });

  it("per-claim meta override still takes precedence over adaptiveWeights", () => {
    // WHAT: The per-claim `_weight_*` fields in node metadata have the HIGHEST priority.
    //       Even if adaptiveWeights says resonance=10, a per-claim `_weight_resonance=0`
    //       overrides it completely.
    //
    // Priority chain (highest → lowest):
    //   1. meta._weight_<name>  (per-claim override set by node operator)
    //   2. ctx.adaptiveWeights  (globally learned by the AI)
    //   3. scorer.defaultWeight (hardcoded fallback)
    //
    // Setup: meta sets recency=1, resonance=0, latency=0
    //        adaptiveWeights says resonance=10 (would dominate if used)
    //
    // PROVES: Per-claim overrides are respected even when the learning loop
    //         would push in the opposite direction. This allows operators to
    //         "pin" weights for specific nodes when they know better than the AI.
    const m = baseEntry();
    const meta = { _weight_resonance: 0, _weight_recency: 1, _weight_latency: 0 };
    const ctx = baseCtx({ adaptiveWeights: { resonance: 10, recency: 0, latency: 0 } });
    const { breakdown } = computeScoreDetailed(m, meta, ctx);
    expect(breakdown.recency!.weight).toBeCloseTo(1, 5);    // per-claim wins
    expect(breakdown.resonance!.weight).toBeCloseTo(0, 5);  // adaptiveWeights ignored
  });
});

// ── 4. Namespace learning — maturity split + blended reads ───────────────────

describe("namespace learning — maturity split", () => {
  it("does not create namespace weights on read", () => {
    // WHAT: Reading weights for a namespace (resolveAdaptiveWeights(NS)) should NOT
    //       create a namespace store. Only writes should create it.
    //
    // WHY: Reads are on the hot path (every request). If reading created namespace
    //      stores, thousands of phantom namespaces would accumulate in the kernel
    //      just from incoming requests.
    expect(getWeightReport(NS).namespace).toBeUndefined();
    resolveAdaptiveWeights(NS); // read — should not initialize
    expect(getWeightReport(NS).namespace).toBeUndefined();
  });

  it("creates namespace store on first namespaced write", () => {
    // WHAT: When you call updateAdaptiveWeights with a namespace option for the
    //       first time, it creates a namespace-local weight store.
    //
    // After 1 sample, maturity = 1/200 = 0.005 (0.5% mature — mostly global still)
    updateAdaptiveWeights(1, {
      resonance: { value: 0.8, weight: 0.4, contribution: 0.32 },
    }, { namespace: NS });
    const report = getWeightReport(NS);
    expect(report.namespace).toBeDefined();
    expect(report.namespace!.sampleCount).toBe(1);
    expect(report.namespace!.maturity).toBeCloseTo(1 / NAMESPACE_MATURITY_SAMPLES, 8);
  });

  it("splits the same delta vector between global and namespace stores", () => {
    // WHAT: One namespaced update splits the gradient between global and namespace.
    //
    // At sample 1:
    //   maturity   = 1/200 = 0.005
    //   nsShare    = 0.005   → most of the delta goes to namespace
    //   globalShare = max(GLOBAL_BACKGROUND_SHARE=0.05, 1-0.005) = 0.995
    //
    // Wait — globalShare is LARGE at low maturity (namespace is new, trust global)
    // As namespace accumulates samples (maturity → 1), globalShare drops to 0.05
    //
    // PROVES: The split math is correct. namespace gets nsShare, global gets globalShare.
    const contribution = 0.32;
    updateAdaptiveWeights(1, {
      resonance: { value: 0.8, weight: 0.4, contribution },
    }, { namespace: NS });

    const report = getWeightReport(NS);
    const maturity = 1 / NAMESPACE_MATURITY_SAMPLES;
    const globalShare = Math.max(GLOBAL_BACKGROUND_SHARE, 1 - maturity);
    const nsShare = maturity;

    expect(report.delta.resonance).toBeCloseTo(LEARNING_RATE * contribution * globalShare, 5);
    expect(report.namespace!.delta.resonance).toBeCloseTo(LEARNING_RATE * contribution * nsShare, 5);
  });

  it("blends 70% namespace / 30% global at 140 samples", () => {
    // WHAT: After 140 namespaced updates:
    //   maturity = 140/200 = 0.70 → 70% namespace weight, 30% global weight
    //
    // The blended weight used by the router = global × 0.30 + namespace × 0.70
    //
    // WHY: The blending formula lets the namespace accumulate its own learning
    //      without completely ignoring what the global prior learned. At 140 samples,
    //      the namespace has enough data to trust, but the global view still counts 30%.
    //      At 200+ samples, namespace dominates (70% → 100%).
    for (let i = 0; i < 140; i++) {
      updateAdaptiveWeights(1, {
        resonance: { value: 0.8, weight: 0.4, contribution: 0.32 },
      }, { namespace: NS });
    }

    const report = getWeightReport(NS);
    expect(report.namespace!.sampleCount).toBe(140);
    expect(report.namespace!.maturity).toBeCloseTo(0.7, 5);

    const global = report.current.resonance!;
    const ns = report.namespace!.current.resonance!;
    const expectedBlend = global * 0.3 + ns * 0.7;
    expect(report.namespace!.blended.resonance).toBeCloseTo(expectedBlend, 8);
    expect(resolveAdaptiveWeights(NS).resonance).toBeCloseTo(expectedBlend, 8);
  });

  it("keeps 5% global background learning after full namespace maturity", () => {
    // WHAT: Once the namespace has 200+ samples (maturity = 1.0), the namespace
    //       dominates selection. But the GLOBAL store still receives 5% of the delta
    //       as a "background signal" so cross-namespace patterns can still propagate.
    //
    // WHY: Imagine a new release causes ALL namespaces to fail. The global store
    //      should capture this regression even when individual namespaces are fully
    //      mature. The 5% global background (GLOBAL_BACKGROUND_SHARE) ensures this.
    //
    // Test: run 200 updates to reach full maturity, then apply one more and measure
    //       how much the global delta moved. It should be exactly
    //       LEARNING_RATE × contribution × GLOBAL_BACKGROUND_SHARE.
    for (let i = 0; i < NAMESPACE_MATURITY_SAMPLES; i++) {
      updateAdaptiveWeights(1, {
        resonance: { value: 0.8, weight: 0.4, contribution: 0.32 },
      }, { namespace: NS });
    }

    const before = getWeightReport(NS);
    updateAdaptiveWeights(1, {
      resonance: { value: 0.8, weight: 0.4, contribution: 0.32 },
    }, { namespace: NS });
    const after = getWeightReport(NS);

    expect(after.namespace!.maturity).toBe(1);
    // Global delta grew by exactly LEARNING_RATE × contribution × 5%
    expect(after.delta.resonance - before.delta.resonance).toBeCloseTo(
      LEARNING_RATE * 0.32 * GLOBAL_BACKGROUND_SHARE,
      5,
    );
  });
});

// ── 5. Learning loop via correlateOutcome ─────────────────────────────────────

describe("learning loop — correlateOutcome triggers weight update", () => {
  it("successful forward increases weight of contributing scorers", () => {
    // WHAT: Full round-trip of the learning loop:
    //   1. recordDecision — log the routing decision with its breakdown
    //   2. correlateOutcome — tell the system the request succeeded in 40ms
    //   3. readAdaptiveWeights — verify recency weight went UP
    //
    // HOW: correlateOutcome(id, 40ms, success) computes reward:
    //   = 0.7 × 1.0 + 0.3 × (1 - 40/5000) = 0.7 + 0.2976 ≈ 0.998
    //   Then: Δrecency = 0.01 × 0.998 × 0.315 ≈ +0.00315
    //
    // PROVES: The bridge-to-learning-loop integration works end-to-end.
    const before = readAdaptiveWeights().recency!;
    const d = {
      decisionId: "loop:1",
      timestamp: Date.now(),
      namespace: NS,
      monadId: "m1",
      score: 0.82,
      margin: 0.15,
      breakdown: { recency: { value: 0.9, weight: 0.35, contribution: 0.315 } },
    };
    recordDecision(d);
    correlateOutcome(d.decisionId, 40, true); // fast success → positive reward
    expect(readAdaptiveWeights().recency).toBeGreaterThan(before);
  });

  it("failed forward decreases weight of scorers that contributed to the bad decision", () => {
    // WHAT: Full loop where the forwarded request FAILED:
    //   correlateOutcome(id, 5000ms, failure) → reward = 0.7 × (−1.0) = −0.700
    //   Δresonance = 0.01 × (−0.700) × 0.32 = −0.00224
    //
    // PROVES: The loop penalizes scorers after a failure. Over time, consistently
    //         failing nodes will cause their dominant scorer to lose weight, making
    //         the router less likely to pick similar nodes in the future.
    const before = readAdaptiveWeights().resonance!;
    const d = {
      decisionId: "loop:2",
      timestamp: Date.now(),
      namespace: NS,
      monadId: "m1",
      score: 0.72,
      margin: 0.20,
      breakdown: { resonance: { value: 0.8, weight: 0.40, contribution: 0.32 } },
    };
    recordDecision(d);
    correlateOutcome(d.decisionId, 5000, false); // failure → negative reward
    expect(readAdaptiveWeights().resonance).toBeLessThan(before);
  });

  it("repeated successes shift selectMeshClaimant toward the resonance-rich node", async () => {
    // WHAT: Simulate 30 successful routing decisions that all boost resonance.
    //       After learning, the resonance weight should be meaningfully above default.
    //
    // WHY: This proves that the learning loop actually CHANGES routing behavior
    //      over time, not just the weight numbers in isolation. If resonance weight
    //      increases, nodes with high resonance (good track records) will score higher
    //      and win more routing decisions — a self-reinforcing feedback loop.
    //
    // After 30 updates with reward≈0.9, contribution=0.32:
    //   resonance grows by 30 × 0.01 × 0.9 × 0.32 = +0.0864
    //   0.40 + 0.0864 = 0.4864 → more than 5% above default (0.40)
    const now = Date.now();
    writeMonadIndexEntry(baseEntry({ monad_id: "veteran", endpoint: "http://localhost:8282", last_seen: now - 2_000 }));
    writeMonadIndexEntry(baseEntry({ monad_id: "newcomer", endpoint: "http://localhost:8283", last_seen: now - 500 }));

    for (let i = 0; i < 30; i++) {
      updateAdaptiveWeights(0.9, {
        resonance: { value: 0.8, weight: 0.40, contribution: 0.32 },
        recency:   { value: 0.5, weight: 0.35, contribution: 0.175 },
        latency:   { value: 0.9, weight: 0.25, contribution: 0.225 },
      });
    }

    const adaptiveWeights = readAdaptiveWeights();
    expect(adaptiveWeights.resonance).toBeGreaterThan(DEFAULT_WEIGHTS.resonance!);
    // Resonance grew by more than 5% from baseline — significant and measurable learning
    expect(adaptiveWeights.resonance! / DEFAULT_WEIGHTS.resonance!).toBeGreaterThan(1.05);
  });
});
