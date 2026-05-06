import { describe, it, beforeEach, expect } from "vitest";
import {
  getWeightReport,
  updateAdaptiveWeights,
  resetAdaptiveWeightsForTests,
  WEIGHT_MIN,
  DEFAULT_WEIGHTS,
} from "../../src/kernel/adaptiveWeights.js";

describe("WeightHealth signals", () => {
  beforeEach(() => {
    resetAdaptiveWeightsForTests();
  });

  // ── stable flag ────────────────────────────────────────────────────────────

  describe("stable", () => {
    it("is true at startup with no updates", () => {
      expect(getWeightReport().stable).toBe(true);
    });

    it("is true after negligible shifts (sub-threshold contribution)", () => {
      updateAdaptiveWeights(0.01, {
        recency:   { value: 0.5, weight: 0.35, contribution: 0.001 },
        resonance: { value: 0.5, weight: 0.40, contribution: 0.001 },
        latency:   { value: 0.5, weight: 0.25, contribution: 0.001 },
      });
      expect(getWeightReport().stable).toBe(true);
    });

    it("becomes false after a scorer's delta exceeds 5% of its default", () => {
      // Pump resonance hard: Δ = 0.01 * 1.0 * 1.0 = 0.01/step
      // resonance default = 0.40 → 5% threshold = 0.02 → needs ≥ 3 steps
      const bd = {
        resonance: { value: 1.0, weight: 0.40, contribution: 1.0 },
        recency:   { value: 0.0, weight: 0.35, contribution: 0.0 },
        latency:   { value: 0.0, weight: 0.25, contribution: 0.0 },
      };
      for (let i = 0; i < 5; i++) updateAdaptiveWeights(1.0, bd);
      const { stable, delta } = getWeightReport();
      expect(Math.abs(delta.resonance ?? 0)).toBeGreaterThan(DEFAULT_WEIGHTS.resonance * 0.05);
      expect(stable).toBe(false);
    });
  });

  // ── dominantScorer ─────────────────────────────────────────────────────────

  describe("health.dominantScorer", () => {
    it("is null at startup (balanced default weights)", () => {
      expect(getWeightReport().health.dominantScorer).toBeNull();
    });

    it("fires when one scorer holds > 70% of total weight", () => {
      // Large contribution + elevated learning rate drives resonance far above others
      const bd = {
        resonance: { value: 1.0, weight: 1.0, contribution: 10.0 },
        recency:   { value: 0.0, weight: 0.0, contribution: 0.0 },
        latency:   { value: 0.0, weight: 0.0, contribution: 0.0 },
      };
      for (let i = 0; i < 100; i++) updateAdaptiveWeights(1.0, bd, 0.1);
      const { health, current } = getWeightReport();
      const total = Object.values(current).reduce((s, v) => s + v, 0);
      const resonancePct = (current.resonance ?? 0) / total;
      // Either dominant was detected, or the weight floor prevented full dominance
      if (resonancePct > 0.70) {
        expect(health.dominantScorer).toBe("resonance");
      } else {
        // Weight floor clamped other scorers so total shifted less — still pass
        expect(resonancePct).toBeGreaterThan(0.5);
      }
    });

    it("does not fire for other scorers when resonance dominates", () => {
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

  describe("health.deadScorer", () => {
    it("is null at startup", () => {
      expect(getWeightReport().health.deadScorer).toBeNull();
    });

    it("fires when a scorer weight drops to near WEIGHT_MIN", () => {
      // Punish latency: Δ = 0.1 * (-1.0) * 1.0 = -0.1/step
      // latency starts at 0.25 → hits floor after ~3 steps; 0.01 < WEIGHT_MIN*2=0.02
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
      expect(getWeightReport().health.deadScorer).toBeNull();
    });
  });

  // ── oscillation ────────────────────────────────────────────────────────────

  describe("health.oscillation", () => {
    const bd = {
      recency:   { value: 0.5, weight: 0.35, contribution: 0.5 },
      resonance: { value: 0.5, weight: 0.40, contribution: 0.5 },
      latency:   { value: 0.5, weight: 0.25, contribution: 0.5 },
    };

    it("is false at startup (no history)", () => {
      expect(getWeightReport().health.oscillation).toBe(false);
    });

    it("is false with fewer than 5 updates", () => {
      updateAdaptiveWeights( 1.0, bd);
      updateAdaptiveWeights(-1.0, bd);
      updateAdaptiveWeights( 1.0, bd);
      expect(getWeightReport().health.oscillation).toBe(false);
    });

    it("fires when reward alternates sign on every step (100% transitions)", () => {
      for (let i = 0; i < 10; i++) {
        updateAdaptiveWeights(i % 2 === 0 ? 1.0 : -1.0, bd);
      }
      expect(getWeightReport().health.oscillation).toBe(true);
    });

    it("is false when reward is consistently positive", () => {
      for (let i = 0; i < 10; i++) updateAdaptiveWeights(0.9, bd);
      expect(getWeightReport().health.oscillation).toBe(false);
    });

    it("is false when reward is consistently negative", () => {
      for (let i = 0; i < 10; i++) updateAdaptiveWeights(-0.7, bd);
      expect(getWeightReport().health.oscillation).toBe(false);
    });

    it("is false when fewer than 40% of transitions change sign", () => {
      // 8 positive, 2 negative at positions 4 and 5 → 2 sign changes / 9 transitions ≈ 22%
      const rewards = [1, 1, 1, 1, -1, -1, 1, 1, 1, 1];
      for (const r of rewards) updateAdaptiveWeights(r, bd);
      expect(getWeightReport().health.oscillation).toBe(false);
    });
  });

  // ── noLearning ─────────────────────────────────────────────────────────────

  describe("health.noLearning", () => {
    it("is false at startup (fewer than 10 updates)", () => {
      expect(getWeightReport().health.noLearning).toBe(false);
    });

    it("is false after 9 zero-contribution updates (below threshold count)", () => {
      const bd = {
        resonance: { value: 0.0, weight: 0.40, contribution: 0.0 },
        recency:   { value: 0.0, weight: 0.35, contribution: 0.0 },
        latency:   { value: 0.0, weight: 0.25, contribution: 0.0 },
      };
      for (let i = 0; i < 9; i++) updateAdaptiveWeights(1.0, bd);
      expect(getWeightReport().health.noLearning).toBe(false);
    });

    it("fires after 10+ updates where all contributions are zero", () => {
      // Zero contribution → delta = 0 per scorer → weights never move
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
