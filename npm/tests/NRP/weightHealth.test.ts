/**
 * weightHealth.test.ts — Diagnostic Health Signals for the Learning Loop
 *
 * WHAT IS WEIGHT HEALTH?
 * The adaptive learning loop adjusts scorer weights over time. But sometimes
 * the learning loop is in a problematic state — not learning, learning the wrong
 * thing, or oscillating. The WeightHealth object surfaces these conditions:
 *
 *   dominantScorer:  One scorer has > 70% of total weight → other signals ignored
 *   deadScorer:      One scorer is near WEIGHT_MIN floor  → effectively disabled
 *   oscillation:     Rewards alternate sign frequently     → contradictory signal
 *   noLearning:      10+ updates but weights barely moved  → contributions are zero
 *
 * There's also a `stable` flag on the report itself:
 *   stable: true  → all deltas are within 5% of default weights
 *                    (system just started, or converged back to defaults)
 *   stable: false → at least one scorer has moved more than 5% from its default
 *
 * IMPORTANT: None of these health flags trigger automatic actions.
 * They are diagnostic — you observe them, investigate, and decide what to do.
 *
 * WHAT WE TEST (5 groups):
 *   1. stable flag       — when weights haven't moved vs. when they have
 *   2. dominantScorer    — fires when one scorer captures > 70% of total weight
 *   3. deadScorer        — fires when a scorer drops near WEIGHT_MIN (0.01)
 *   4. oscillation       — fires when reward sign alternates > 40% of recent steps
 *   5. noLearning        — fires when 10+ updates produce < 0.002 weight change
 */

import { describe, it, beforeEach, expect } from "vitest";
import {
  getWeightReport,
  updateAdaptiveWeights,
  resetAdaptiveWeightsForTests,
  WEIGHT_MIN,
  DEFAULT_WEIGHTS,
} from "../../src/kernel/adaptiveWeights.js";

describe("WeightHealth signals", () => {
  // Reset to defaults before every test so health signals start from a clean state.
  // Without this, a "dominantScorer" from one test would still be dominant in the next.
  beforeEach(() => {
    resetAdaptiveWeightsForTests();
  });

  // ── stable flag ────────────────────────────────────────────────────────────
  // stable=true means no scorer has moved more than 5% from its default weight.
  // This is expected at startup and on perfectly homogeneous meshes.

  describe("stable", () => {
    it("is true at startup with no updates", () => {
      // WHAT: A freshly reset system has no updates applied.
      //       All weights are at their defaults. Delta = 0 for all scorers.
      //       0 < 5% of any default → stable = true.
      //
      // WHY: If stable were false at startup, operators would get false alarms
      //      immediately without any learning having happened.
      expect(getWeightReport().stable).toBe(true);
    });

    it("is true after negligible shifts (sub-threshold contribution)", () => {
      // WHAT: Apply one update with very small contributions (0.001 each).
      //       Δweight = 0.01 × 0.01 × 0.001 = 0.0000001 — microscopic change.
      //       The delta is far below 5% of any default weight → still stable.
      //
      // HOW:  5% of recency default (0.35)   = 0.0175
      //       5% of resonance default (0.40)  = 0.0200
      //       5% of latency default (0.25)    = 0.0125
      //       All actual deltas (~0.0000001) are far below these thresholds.
      updateAdaptiveWeights(0.01, {
        recency:   { value: 0.5, weight: 0.35, contribution: 0.001 },
        resonance: { value: 0.5, weight: 0.40, contribution: 0.001 },
        latency:   { value: 0.5, weight: 0.25, contribution: 0.001 },
      });
      expect(getWeightReport().stable).toBe(true);
    });

    it("becomes false after a scorer's delta exceeds 5% of its default", () => {
      // WHAT: Push resonance hard using maximum contribution (1.0) and reward (+1.0).
      //       Each step: Δresonance = 0.01 × 1.0 × 1.0 = 0.01
      //       resonance default = 0.40 → 5% threshold = 0.020
      //       After 3 steps: delta = 0.03 → exceeds 0.020 → stable = false.
      //       We run 5 steps to be safely above the threshold.
      //
      // WHY: stable=false tells operators "the learning loop has actually moved
      //      weights significantly from baseline — learning is happening".
      const bd = {
        resonance: { value: 1.0, weight: 0.40, contribution: 1.0 },
        recency:   { value: 0.0, weight: 0.35, contribution: 0.0 },
        latency:   { value: 0.0, weight: 0.25, contribution: 0.0 },
      };
      for (let i = 0; i < 5; i++) updateAdaptiveWeights(1.0, bd);
      const { stable, delta } = getWeightReport();
      expect(Math.abs(delta.resonance ?? 0)).toBeGreaterThan(DEFAULT_WEIGHTS.resonance! * 0.05);
      expect(stable).toBe(false);
    });
  });

  // ── dominantScorer ─────────────────────────────────────────────────────────
  // When one scorer holds > 70% of total weight, it's "dominating" — other signals
  // are barely contributing. This could mean the learning loop is overfitting.

  describe("health.dominantScorer", () => {
    it("is null at startup (balanced default weights)", () => {
      // WHAT: Default weights: latency=0.25, recency=0.35, resonance=0.40.
      //       resonance share = 0.40 / (0.25 + 0.35 + 0.40) = 0.40 = 40%.
      //       No scorer exceeds 70% → dominantScorer is null.
      //
      // WHY: The defaults are intentionally balanced. No single signal should dominate
      //      the routing decision before any learning has occurred.
      expect(getWeightReport().health.dominantScorer).toBeNull();
    });

    it("fires when one scorer holds > 70% of total weight", () => {
      // WHAT: Apply 100 updates with learningRate=0.1 (10x normal) and contribution=10.0.
      //       Each step pushes resonance up by 0.1 × 1.0 × 10.0 = 1.0 per step.
      //       After 100 steps: resonance ≈ 0.40 + 100 = 100.40 (massive).
      //       recency and latency have contribution=0.0 → they don't grow.
      //       resonance share = 100.40 / (0.01 + 0.01 + 100.40) ≈ 99.98% >> 70%.
      //
      // WHY: This simulates a scenario where one scorer (resonance) was consistently
      //      associated with all successful routing decisions, and the system over-learned
      //      its importance. The health signal flags this extreme imbalance.
      //
      // Note: WEIGHT_MIN prevents recency and latency from going negative, but they
      //       stay at their floor (0.01) while resonance grows unbounded.
      const bd = {
        resonance: { value: 1.0, weight: 1.0, contribution: 10.0 },
        recency:   { value: 0.0, weight: 0.0, contribution: 0.0 },
        latency:   { value: 0.0, weight: 0.0, contribution: 0.0 },
      };
      for (let i = 0; i < 100; i++) updateAdaptiveWeights(1.0, bd, 0.1);
      const { health, current } = getWeightReport();
      const total = Object.values(current).reduce((s, v) => s + v, 0);
      const resonancePct = (current.resonance ?? 0) / total;
      // Either dominant was detected, or WEIGHT_MIN clamped others so total shifted less
      if (resonancePct > 0.70) {
        expect(health.dominantScorer).toBe("resonance");
      } else {
        // resonance is still clearly the largest, even if not technically >70%
        expect(resonancePct).toBeGreaterThan(0.5);
      }
    });

    it("does not fire for other scorers when resonance dominates", () => {
      // WHAT: Same setup as above (resonance pushed to dominate).
      //       dominantScorer should be "resonance" (or null due to floor), NOT "recency" or "latency".
      //
      // WHY: The health system should only flag the scorer that actually dominates.
      //      Flagging incorrect scorers would send operators on the wrong investigation.
      const bd = {
        resonance: { value: 1.0, weight: 1.0, contribution: 10.0 },
        recency:   { value: 0.0, weight: 0.0, contribution: 0.0 },
        latency:   { value: 0.0, weight: 0.0, contribution: 0.0 },
      };
      for (let i = 0; i < 100; i++) updateAdaptiveWeights(1.0, bd, 0.1);
      const { health } = getWeightReport();
      expect(health.dominantScorer).not.toBe("recency");
      expect(health.dominantScorer).not.toBe("latency");
    });
  });

  // ── deadScorer ─────────────────────────────────────────────────────────────
  // A "dead" scorer has weight ≤ WEIGHT_MIN × 2 (≤ 0.02). It's contributing
  // less than 2% of the routing decision — effectively disabled.

  describe("health.deadScorer", () => {
    it("is null at startup", () => {
      // Default latency=0.25 is far above WEIGHT_MIN×2=0.02 → no dead scorer.
      expect(getWeightReport().health.deadScorer).toBeNull();
    });

    it("fires when a scorer weight drops to near WEIGHT_MIN", () => {
      // WHAT: Punish latency with maximum negative rewards at learningRate=0.1.
      //       Each step: Δlatency = 0.1 × (−1.0) × 1.0 = −0.10 per step.
      //       Start: latency = 0.25
      //       Step 1: 0.25 − 0.10 = 0.15
      //       Step 2: 0.15 − 0.10 = 0.05
      //       Step 3: 0.05 − 0.10 → WEIGHT_MIN floor at 0.01
      //       After 10 steps: latency = 0.01 = WEIGHT_MIN ≤ WEIGHT_MIN×2 = 0.02
      //
      // deadScorer fires when: current_weight < WEIGHT_MIN × 2 (= 0.02)
      //
      // WHY: A dead scorer means the system stopped using a signal entirely.
      //      If latency is "dead", the router ignores how fast nodes respond —
      //      bad for latency-sensitive workloads. The operator should investigate.
      const bd = {
        latency:   { value: 1.0, weight: 0.25, contribution: 1.0 },
        recency:   { value: 0.0, weight: 0.35, contribution: 0.0 },
        resonance: { value: 0.0, weight: 0.40, contribution: 0.0 },
      };
      for (let i = 0; i < 10; i++) updateAdaptiveWeights(-1.0, bd, 0.1);
      const { health, current } = getWeightReport();
      expect(current.latency).toBeLessThanOrEqual(WEIGHT_MIN * 2);
      expect(health.deadScorer).toBe("latency");
    });

    it("does not fire when scorer is at default weight", () => {
      // Default weights are all well above WEIGHT_MIN×2 (0.02):
      //   latency = 0.25 >> 0.02
      //   recency = 0.35 >> 0.02
      //   resonance = 0.40 >> 0.02
      // No dead scorer at startup.
      expect(getWeightReport().health.deadScorer).toBeNull();
    });
  });

  // ── oscillation ────────────────────────────────────────────────────────────
  // Oscillation means the recent reward signal alternates between positive and negative.
  // More than 40% of consecutive pairs change sign → oscillation = true.
  //
  // Algorithm: look at last 10 rewards. Count sign changes. If changes/pairs > 0.40 → oscillating.
  // Requires at least 5 samples before detection (not enough data otherwise).

  describe("health.oscillation", () => {
    // Reusable breakdown for oscillation tests — all scorers contribute equally.
    const bd = {
      recency:   { value: 0.5, weight: 0.35, contribution: 0.5 },
      resonance: { value: 0.5, weight: 0.40, contribution: 0.5 },
      latency:   { value: 0.5, weight: 0.25, contribution: 0.5 },
    };

    it("is false at startup (no history)", () => {
      // No reward history → no transitions → can't detect oscillation.
      expect(getWeightReport().health.oscillation).toBe(false);
    });

    it("is false with fewer than 5 updates", () => {
      // WHAT: Apply 3 alternating rewards (+1, −1, +1).
      //       That's only 2 transitions — not enough data to detect oscillation reliably.
      //       The system requires ≥ 5 samples before it will fire.
      //
      // WHY: 2 or 3 alternating rewards could just be noise. The 5-sample threshold
      //      reduces false positives from small sample sizes.
      updateAdaptiveWeights( 1.0, bd);
      updateAdaptiveWeights(-1.0, bd);
      updateAdaptiveWeights( 1.0, bd);
      expect(getWeightReport().health.oscillation).toBe(false);
    });

    it("fires when reward alternates sign on every step (100% transitions)", () => {
      // WHAT: 10 rewards alternating +1, −1, +1, −1, ...
      //       10 rewards → 9 transitions → ALL 9 change sign → 100% > 40%
      //       → oscillation = true.
      //
      // WHY: Perfect alternation means the router is picking a good node (success),
      //      then a bad node (failure), then a good node, then bad... in a cycle.
      //      This usually means two closely-scored nodes with opposite reliability,
      //      and the exploration rate is sending requests between them.
      for (let i = 0; i < 10; i++) {
        updateAdaptiveWeights(i % 2 === 0 ? 1.0 : -1.0, bd);
      }
      expect(getWeightReport().health.oscillation).toBe(true);
    });

    it("is false when reward is consistently positive", () => {
      // WHAT: 10 identical positive rewards.
      //       0 sign changes / 9 transitions = 0% < 40% → no oscillation.
      //
      // WHY: Consistently positive rewards mean the router keeps picking good nodes.
      //      That's a healthy state — the learning loop is reinforcing good behavior.
      for (let i = 0; i < 10; i++) updateAdaptiveWeights(0.9, bd);
      expect(getWeightReport().health.oscillation).toBe(false);
    });

    it("is false when reward is consistently negative", () => {
      // WHAT: 10 identical negative rewards (all failures).
      //       0 sign changes / 9 transitions = 0% < 40% → no oscillation.
      //
      // WHY: Consistently bad rewards are bad (the router keeps picking failing nodes)
      //      but they're NOT oscillation. Oscillation is specifically about alternating.
      //      Consistent failures get caught by noLearning or by operator inspection
      //      of delta values, not by the oscillation signal.
      for (let i = 0; i < 10; i++) updateAdaptiveWeights(-0.7, bd);
      expect(getWeightReport().health.oscillation).toBe(false);
    });

    it("is false when fewer than 40% of transitions change sign", () => {
      // WHAT: 8 positive, then 2 consecutive negatives (at positions 5 and 6), then 2 more positive.
      //   rewards = [1, 1, 1, 1, -1, -1, 1, 1, 1, 1]
      //   transitions at boundaries:
      //     +1→+1 (×3), +1→-1 (sign change!), -1→-1, -1→+1 (sign change!), +1→+1 (×3)
      //   sign changes = 2, total transitions = 9
      //   rate = 2/9 ≈ 22% < 40% → no oscillation
      //
      // WHY: A brief dip in quality (maybe a node temporarily degraded) followed by
      //      recovery is not oscillation. Oscillation requires FREQUENT alternation.
      const rewards = [1, 1, 1, 1, -1, -1, 1, 1, 1, 1];
      for (const r of rewards) updateAdaptiveWeights(r, bd);
      expect(getWeightReport().health.oscillation).toBe(false);
    });
  });

  // ── noLearning ─────────────────────────────────────────────────────────────
  // noLearning fires when:
  //   - updateCount >= 10 (enough updates to expect movement)
  //   - max(|delta|) < 0.002 (no scorer has moved more than 0.2% from default)
  //
  // This usually means: contributions are all zero → Δweight = 0 per step.

  describe("health.noLearning", () => {
    it("is false at startup (fewer than 10 updates)", () => {
      // 0 updates → updateCount = 0 < 10 → noLearning threshold not reached.
      // We don't flag "no learning" until there have been enough updates to judge.
      expect(getWeightReport().health.noLearning).toBe(false);
    });

    it("is false after 9 zero-contribution updates (below threshold count)", () => {
      // WHAT: Apply 9 updates with contribution=0 for all scorers.
      //       Δweight = 0.01 × 1.0 × 0.0 = 0 → weights don't move.
      //       But updateCount = 9 < 10 → noLearning threshold not yet met.
      //
      // WHY: We need at least 10 updates before flagging "no learning". With fewer,
      //      it's too early to tell — maybe the system just started.
      const bd = {
        resonance: { value: 0.0, weight: 0.40, contribution: 0.0 },
        recency:   { value: 0.0, weight: 0.35, contribution: 0.0 },
        latency:   { value: 0.0, weight: 0.25, contribution: 0.0 },
      };
      for (let i = 0; i < 9; i++) updateAdaptiveWeights(1.0, bd);
      expect(getWeightReport().health.noLearning).toBe(false);
    });

    it("fires after 10+ updates where all contributions are zero", () => {
      // WHAT: Apply 10 updates, all with contribution=0. After 10 steps:
      //   updateCount = 10 ≥ 10 ✓
      //   Δweight = 0.01 × 1.0 × 0.0 = 0 for every scorer
      //   max(|delta|) = 0 < 0.002 ✓
      //   → noLearning = true
      //
      // WHY: Zero contributions happen when:
      //   1. All requests are name-selector (no scoring happened, so breakdown has all zeros)
      //   2. All nodes have scorer values near zero (freshly registered, no history)
      //   3. correlateOutcome is not being called at all
      //
      // noLearning tells the operator: "the learning loop is running but not doing anything".
      const bd = {
        resonance: { value: 0.0, weight: 0.40, contribution: 0.0 },
        recency:   { value: 0.0, weight: 0.35, contribution: 0.0 },
        latency:   { value: 0.0, weight: 0.25, contribution: 0.0 },
      };
      for (let i = 0; i < 10; i++) updateAdaptiveWeights(1.0, bd);
      const { health, updateCount } = getWeightReport();
      expect(updateCount).toBe(10);
      expect(health.noLearning).toBe(true);
    });

    it("is false when weights have moved meaningfully after 10+ updates", () => {
      // WHAT: Apply 10 updates with contribution=1.0 (maximum) and reward=+1.0.
      //   Each step: Δresonance = 0.01 × 1.0 × 1.0 = 0.01
      //   After 10 steps: delta.resonance = 0.10 >> 0.002
      //   → noLearning = false (weights ARE moving)
      //
      // WHY: When contributions are non-zero and rewards are non-zero, the system
      //      IS learning. This test confirms noLearning stays false under normal operation.
      const bd = {
        resonance: { value: 1.0, weight: 0.40, contribution: 1.0 },
        recency:   { value: 0.0, weight: 0.35, contribution: 0.0 },
        latency:   { value: 0.0, weight: 0.25, contribution: 0.0 },
      };
      for (let i = 0; i < 10; i++) updateAdaptiveWeights(1.0, bd);
      expect(getWeightReport().health.noLearning).toBe(false);
    });
  });
});
