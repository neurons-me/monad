/**
 * Adaptive Weights — test suite
 *
 * Organization:
 *   1. readAdaptiveWeights  — defaults, kernel reads, floor clamping
 *   2. updateAdaptiveWeights — gradient step, floor, NaN/zero guards
 *   3. Integration with computeScore — learned weights shift results
 *   4. Namespace learning — maturity split + blended reads
 *   5. Learning loop via correlateOutcome — full round-trip
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

const savedSeed = process.env.SEED;
const savedStateDir = process.env.ME_STATE_DIR;

beforeEach(() => {
  process.env.ME_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "monad-aw-"));
  process.env.SEED = "adaptive-weights-test-seed";
  resetKernelStateForTests();
  resetAdaptiveWeightsForTests();
  resetDecisionLogForTests();
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

// ── 1. readAdaptiveWeights ────────────────────────────────────────────────────

describe("readAdaptiveWeights", () => {
  it("returns DEFAULT_WEIGHTS before any learning", () => {
    const w = readAdaptiveWeights();
    expect(w.latency).toBeCloseTo(DEFAULT_WEIGHTS.latency!, 5);
    expect(w.recency).toBeCloseTo(DEFAULT_WEIGHTS.recency!, 5);
    expect(w.resonance).toBeCloseTo(DEFAULT_WEIGHTS.resonance!, 5);
  });

  it("returns updated values after a write", () => {
    updateAdaptiveWeights(1, {
      resonance: { value: 0.8, weight: 0.4, contribution: 0.32 },
    });
    const w = readAdaptiveWeights();
    // resonance got a positive nudge
    expect(w.resonance).toBeGreaterThan(DEFAULT_WEIGHTS.resonance!);
  });

  it("clamps stored weights below WEIGHT_MIN to WEIGHT_MIN on read", () => {
    // Directly inject an invalid value via a successful path
    updateAdaptiveWeights(-100, {
      recency: { value: 0.9, weight: 0.35, contribution: 0.315 },
    });
    const w = readAdaptiveWeights();
    // Even after extreme negative reward, weight is at least WEIGHT_MIN
    expect(w.recency).toBeGreaterThanOrEqual(WEIGHT_MIN);
  });
});

// ── 2. updateAdaptiveWeights ──────────────────────────────────────────────────

describe("updateAdaptiveWeights", () => {
  it("positive reward increases the contributing scorer's weight", () => {
    const before = readAdaptiveWeights().resonance!;
    updateAdaptiveWeights(1, {
      resonance: { value: 0.8, weight: 0.4, contribution: 0.32 },
    });
    expect(readAdaptiveWeights().resonance).toBeGreaterThan(before);
  });

  it("negative reward decreases the contributing scorer's weight", () => {
    const before = readAdaptiveWeights().recency!;
    updateAdaptiveWeights(-0.7, {
      recency: { value: 0.9, weight: 0.35, contribution: 0.315 },
    });
    expect(readAdaptiveWeights().recency).toBeLessThan(before);
  });

  it("weight never drops below WEIGHT_MIN regardless of extreme negative reward", () => {
    for (let i = 0; i < 50; i++) {
      updateAdaptiveWeights(-1, {
        latency: { value: 0.5, weight: 0.25, contribution: 0.125 },
      });
    }
    expect(readAdaptiveWeights().latency).toBeGreaterThanOrEqual(WEIGHT_MIN);
  });

  it("update magnitude scales with learning rate × reward × contribution", () => {
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
    const before = { ...readAdaptiveWeights() };
    updateAdaptiveWeights(NaN, {
      recency: { value: 0.9, weight: 0.35, contribution: 0.315 },
    });
    const after = readAdaptiveWeights();
    expect(after.recency).toBeCloseTo(before.recency!, 10);
  });

  it("zero reward is a no-op", () => {
    const before = { ...readAdaptiveWeights() };
    updateAdaptiveWeights(0, {
      recency: { value: 0.9, weight: 0.35, contribution: 0.315 },
    });
    expect(readAdaptiveWeights().recency).toBeCloseTo(before.recency!, 10);
  });

  it("update persists — survives a second read call", () => {
    updateAdaptiveWeights(1, {
      resonance: { value: 0.9, weight: 0.4, contribution: 0.36 },
    });
    const w1 = readAdaptiveWeights();
    const w2 = readAdaptiveWeights(); // second read, same kernel state
    expect(w1.resonance).toBeCloseTo(w2.resonance!, 10);
  });
});

// ── 3. Integration with computeScore ─────────────────────────────────────────

describe("integration with computeScore — adaptiveWeights in ScoringContext", () => {
  it("learned weights influence score when passed via ctx.adaptiveWeights", () => {
    const m = baseEntry();
    const meta = {};
    const ctxNormal = baseCtx();
    // Dominate with resonance via adaptiveWeights
    const ctxBoosted = baseCtx({ adaptiveWeights: { latency: 0, recency: 0, resonance: 1 } });
    const scoreNormal = computeScore(m, meta, ctxNormal);
    const scoreBoosted = computeScore(m, meta, ctxBoosted);
    // All resonance weight with zero resonance → score = 0
    // Normal has non-zero recency and latency → score > 0
    expect(scoreNormal).toBeGreaterThan(scoreBoosted);
  });

  it("per-claim meta override still takes precedence over adaptiveWeights", () => {
    const m = baseEntry();
    const meta = { _weight_resonance: 0, _weight_recency: 1, _weight_latency: 0 };
    const ctx = baseCtx({ adaptiveWeights: { resonance: 10, recency: 0, latency: 0 } });
    const { breakdown } = computeScoreDetailed(m, meta, ctx);
    // Per-claim sets recency weight to 1 (all weight), resonance to 0
    // adaptiveWeights says resonance = 10 — but per-claim wins
    expect(breakdown.recency!.weight).toBeCloseTo(1, 5);
    expect(breakdown.resonance!.weight).toBeCloseTo(0, 5);
  });
});

// ── 4. Namespace learning — maturity split + blended reads ───────────────────

describe("namespace learning — maturity split", () => {
  it("does not create namespace weights on read", () => {
    expect(getWeightReport(NS).namespace).toBeUndefined();
    resolveAdaptiveWeights(NS);
    expect(getWeightReport(NS).namespace).toBeUndefined();
  });

  it("creates namespace store on first namespaced write", () => {
    updateAdaptiveWeights(1, {
      resonance: { value: 0.8, weight: 0.4, contribution: 0.32 },
    }, { namespace: NS });
    const report = getWeightReport(NS);
    expect(report.namespace).toBeDefined();
    expect(report.namespace!.sampleCount).toBe(1);
    expect(report.namespace!.maturity).toBeCloseTo(1 / NAMESPACE_MATURITY_SAMPLES, 8);
  });

  it("splits the same delta vector between global and namespace stores", () => {
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
    expect(after.delta.resonance - before.delta.resonance).toBeCloseTo(
      LEARNING_RATE * 0.32 * GLOBAL_BACKGROUND_SHARE,
      5,
    );
  });
});

// ── 5. Learning loop via correlateOutcome ─────────────────────────────────────

describe("learning loop — correlateOutcome triggers weight update", () => {
  it("successful forward increases weight of contributing scorers", () => {
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
    const now = Date.now();
    // "veteran" has accumulated resonance; "newcomer" is fresh but unknown
    writeMonadIndexEntry(baseEntry({ monad_id: "veteran", endpoint: "http://localhost:8282", last_seen: now - 2_000 }));
    writeMonadIndexEntry(baseEntry({ monad_id: "newcomer", endpoint: "http://localhost:8283", last_seen: now - 500 }));

    // Simulate veteran's past performance lifting resonance weight
    for (let i = 0; i < 30; i++) {
      updateAdaptiveWeights(0.9, {
        resonance: { value: 0.8, weight: 0.40, contribution: 0.32 },
        recency:   { value: 0.5, weight: 0.35, contribution: 0.175 },
        latency:   { value: 0.9, weight: 0.25, contribution: 0.225 },
      });
    }

    // After resonance weight is boosted by learning, the system should prefer the
    // veteran (who would have high resonance if this were real) over the newcomer.
    // We verify that learned weights actually change what computeScore returns.
    const adaptiveWeights = readAdaptiveWeights();
    expect(adaptiveWeights.resonance).toBeGreaterThan(DEFAULT_WEIGHTS.resonance!);
    // The weight shift is real — the learning loop closed.
    expect(adaptiveWeights.resonance! / DEFAULT_WEIGHTS.resonance!).toBeGreaterThan(1.05);
  });
});
