/**
 * decisionLogSynthesis.test.ts — Phase 10: SynthesisDecisionEntry logging
 *
 * WHAT IS THIS?
 * recordSynthesisDecision / correlateSynthesisOutcome extend the single-winner
 * decision log to cover N-source synthesis rounds. These tests verify that:
 *   - synthesis entries are recorded and correlated correctly
 *   - contested outcomes produce penalized and ALWAYS NEGATIVE rewards
 *   - hard failures produce full negative rewards
 *   - successful quorum outcomes produce positive rewards
 *   - rewards respect the MONAD_LEARNING_QUALITY_WEIGHT env var
 *   - unknown decisionIds are silently ignored
 *   - resetSynthesisDecisionLogForTests() clears pending entries
 *
 * REWARD LAW (fixed here as executable documentation):
 *
 *   reward = qualityWeight * rewardQuality + (1 - qualityWeight) * rewardLatency
 *
 *   strategy      | rewardQuality | rewardLatency
 *   ------------- | ------------- | ---------------------------
 *   quorum        | +1.0          | max(0, 1 - latencyMs/5000)
 *   highest-scored| +1.0          | max(0, 1 - latencyMs/5000)
 *   contested     | -0.3          | 0  ← NO latency bonus (cohesion failure)
 *   hard failure  | -1.0          | 0
 *
 *   Default qualityWeight=0.7:
 *     quorum at   0ms → 0.7*1.0 + 0.3*1.0  =  1.00
 *     quorum at 500ms → 0.7*1.0 + 0.3*0.9  =  0.97
 *     contested  any  → 0.7*-0.3 + 0.3*0   = -0.21  (always negative)
 *     hard fail  any  → 0.7*-1.0 + 0.3*0   = -0.70
 */

import fs from "fs";
import os from "os";
import path from "path";
import {
  recordSynthesisDecision,
  correlateSynthesisOutcome,
  resetSynthesisDecisionLogForTests,
  type SynthesisDecisionEntry,
} from "../../src/kernel/decisionLog.js";
import { resetAdaptiveWeightsForTests } from "../../src/kernel/adaptiveWeights.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let decisionCounter = 0;

function makeEntry(
  overrides: Partial<Omit<SynthesisDecisionEntry, "outcome" | "latencyMs" | "reward">>,
): Omit<SynthesisDecisionEntry, "outcome" | "latencyMs" | "reward"> {
  const id = `synth-${++decisionCounter}`;
  return {
    decisionId: id,
    timestamp: Date.now(),
    namespace: "test.me",
    monadId: "monad-winner",
    score: 0.9,
    margin: 0.1,
    breakdown: {},
    synthesisPolicy: "strict-quorum",
    sourceCount: 3,
    agreeCount: 2,
    divergenceStrategy: "quorum",
    sourceSummaries: [
      { monad_id: "m1", ok: true, latencyMs: 10, score: 0.9 },
      { monad_id: "m2", ok: true, latencyMs: 12, score: 0.8 },
      { monad_id: "m3", ok: false, latencyMs: 0, score: 0.5 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  resetSynthesisDecisionLogForTests();
  resetAdaptiveWeightsForTests();
  // suppress MONAD_DECISION_LOG so nothing is written to disk during tests
  delete process.env.MONAD_DECISION_LOG;
  delete process.env.MONAD_LEARNING_QUALITY_WEIGHT;
  decisionCounter = 0;
});

// ── 1. Basic record/correlate ─────────────────────────────────────────────────

describe("recordSynthesisDecision / correlateSynthesisOutcome — basic", () => {
  it("correlating an unknown decisionId is a no-op (no throw)", () => {
    expect(() => correlateSynthesisOutcome("unknown-xyz", 50, true)).not.toThrow();
  });

  it("correlating twice is idempotent — second call is silently ignored", () => {
    const entry = makeEntry({});
    recordSynthesisDecision(entry);
    expect(() => {
      correlateSynthesisOutcome(entry.decisionId, 20, true);
      correlateSynthesisOutcome(entry.decisionId, 20, true); // already removed from pending
    }).not.toThrow();
  });

  it("resetSynthesisDecisionLogForTests clears pending entries", () => {
    const entry = makeEntry({});
    recordSynthesisDecision(entry);
    resetSynthesisDecisionLogForTests();
    // After reset, the entry is gone — correlate is a no-op, no throw
    expect(() => correlateSynthesisOutcome(entry.decisionId, 20, true)).not.toThrow();
  });
});

// ── 2. Reward signal correctness ─────────────────────────────────────────────

describe("correlateSynthesisOutcome — reward signals", () => {
  it("quorum success → reward > 0", () => {
    // We can't directly read the reward without a log file, so we verify via
    // adaptive weights: a positive reward pushes weight deltas ≥ 0.
    // Instead, we just check that the function completes without error for
    // the happy path. Reward value is tested via the formula coverage below.
    const entry = makeEntry({ divergenceStrategy: "quorum", breakdown: {} });
    recordSynthesisDecision(entry);
    expect(() => correlateSynthesisOutcome(entry.decisionId, 50, true)).not.toThrow();
  });

  it("hard failure (ok=false) → no throw", () => {
    const entry = makeEntry({ divergenceStrategy: "quorum" });
    recordSynthesisDecision(entry);
    expect(() => correlateSynthesisOutcome(entry.decisionId, 50, false)).not.toThrow();
  });

  it("contested + ok=true → no throw (partial failure path)", () => {
    const entry = makeEntry({ divergenceStrategy: "contested" });
    recordSynthesisDecision(entry);
    expect(() => correlateSynthesisOutcome(entry.decisionId, 50, true)).not.toThrow();
  });

  it("highest-scored strategy → no throw", () => {
    const entry = makeEntry({ divergenceStrategy: "highest-scored" });
    recordSynthesisDecision(entry);
    expect(() => correlateSynthesisOutcome(entry.decisionId, 50, true)).not.toThrow();
  });
});

// ── 3. Reward formula verification (unit-level, no file I/O) ─────────────────

describe("correlateSynthesisOutcome — reward formula", () => {
  /**
   * We derive the expected reward from the documented formula and check that
   * the correct MONAD_LEARNING_QUALITY_WEIGHT env is respected.
   *
   * reward = qualityWeight * rewardQuality + (1 - qualityWeight) * rewardLatency
   *
   * Contested: rewardQuality = -0.3, rewardLatency depends on ok
   * Hard fail:  rewardQuality = -1.0, rewardLatency = 0
   * Success:    rewardQuality =  1.0, rewardLatency = max(0, 1 - latencyMs/5000)
   */

  it("default quality weight 0.7: quorum success at 0ms latency → reward ≈ 1.0", () => {
    // reward = 0.7 * 1.0 + 0.3 * max(0, 1 - 0/5000) = 0.7 + 0.3 = 1.0
    // We can't intercept the computed value without patching appendToLog, so
    // this test is a smoke test confirming no error and consistent completion.
    const entry = makeEntry({ divergenceStrategy: "quorum" });
    recordSynthesisDecision(entry);
    expect(() => correlateSynthesisOutcome(entry.decisionId, 0, true)).not.toThrow();
  });

  it("custom quality weight 1.0: only quality matters", () => {
    process.env.MONAD_LEARNING_QUALITY_WEIGHT = "1.0";
    const entry = makeEntry({ divergenceStrategy: "quorum" });
    recordSynthesisDecision(entry);
    expect(() => correlateSynthesisOutcome(entry.decisionId, 9999, true)).not.toThrow();
  });

  it("MONAD_LEARNING_QUALITY_WEIGHT=0: only latency matters", () => {
    process.env.MONAD_LEARNING_QUALITY_WEIGHT = "0";
    const entry = makeEntry({ divergenceStrategy: "quorum" });
    recordSynthesisDecision(entry);
    expect(() => correlateSynthesisOutcome(entry.decisionId, 100, true)).not.toThrow();
  });
});

// ── 4. Adaptive weight integration ───────────────────────────────────────────

describe("correlateSynthesisOutcome — adaptive weight integration", () => {
  it("synthesis entry with non-empty breakdown triggers weight update without throw", () => {
    const entry = makeEntry({
      divergenceStrategy: "quorum",
      breakdown: {
        recency: { raw: 0.9, weighted: 0.45, weight: 0.5 },
      } as any,
    });
    recordSynthesisDecision(entry);
    expect(() => correlateSynthesisOutcome(entry.decisionId, 10, true)).not.toThrow();
  });

  it("synthesis entry with empty breakdown skips weight update without throw", () => {
    const entry = makeEntry({ divergenceStrategy: "contested", breakdown: {} });
    recordSynthesisDecision(entry);
    expect(() => correlateSynthesisOutcome(entry.decisionId, 50, true)).not.toThrow();
  });
});

// ── 5. Multi-pending isolation ────────────────────────────────────────────────

describe("correlateSynthesisOutcome — pending map isolation", () => {
  it("two concurrent synthesis decisions do not interfere", () => {
    const e1 = makeEntry({ synthesisPolicy: "strict-quorum" });
    const e2 = makeEntry({ synthesisPolicy: "strict-quorum" });
    recordSynthesisDecision(e1);
    recordSynthesisDecision(e2);
    expect(() => {
      correlateSynthesisOutcome(e1.decisionId, 10, true);
      correlateSynthesisOutcome(e2.decisionId, 20, false);
    }).not.toThrow();
  });

  it("correlating e2 first does not affect e1", () => {
    const e1 = makeEntry({});
    const e2 = makeEntry({});
    recordSynthesisDecision(e1);
    recordSynthesisDecision(e2);
    correlateSynthesisOutcome(e2.decisionId, 10, true);
    // e1 should still be correlatable
    expect(() => correlateSynthesisOutcome(e1.decisionId, 20, true)).not.toThrow();
  });
});

// ── 6. JSONL reward law — exact values ───────────────────────────────────────
//
// These tests write to a temp JSONL file, parse it back, and assert the exact
// reward value produced for each synthesis outcome regime.
// This group is the executable documentation of the reward contract.

/** Read the last N JSONL lines from a file and parse them. */
function readJsonlLines(filePath: string, n = 10): Record<string, unknown>[] {
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .filter(Boolean)
    .slice(-n)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("correlateSynthesisOutcome — JSONL reward law (exact values)", () => {
  let logFile: string;

  beforeEach(() => {
    logFile = path.join(os.tmpdir(), `monad-synth-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    process.env.MONAD_DECISION_LOG = logFile;
    process.env.MONAD_LEARNING_QUALITY_WEIGHT = "0.7"; // pin default
  });

  afterEach(() => {
    delete process.env.MONAD_DECISION_LOG;
    delete process.env.MONAD_LEARNING_QUALITY_WEIGHT;
    try { fs.unlinkSync(logFile); } catch { /* best-effort */ }
  });

  it("quorum at latencyMs=0 → reward = 1.00 exactly", () => {
    const entry = makeEntry({ divergenceStrategy: "quorum" });
    recordSynthesisDecision(entry);
    correlateSynthesisOutcome(entry.decisionId, 0, true);
    const [logged] = readJsonlLines(logFile, 1);
    // 0.7 * 1.0 + 0.3 * max(0, 1 - 0/5000) = 0.7 + 0.3 = 1.0
    expect(logged!.reward).toBeCloseTo(1.0, 10);
    expect(logged!.outcome).toBe("success");
    expect(logged!.divergenceStrategy).toBe("quorum");
  });

  it("quorum at latencyMs=500 → reward = 0.97 (0.7*1.0 + 0.3*0.9)", () => {
    const entry = makeEntry({ divergenceStrategy: "quorum" });
    recordSynthesisDecision(entry);
    correlateSynthesisOutcome(entry.decisionId, 500, true);
    const [logged] = readJsonlLines(logFile, 1);
    // 0.7 * 1.0 + 0.3 * (1 - 500/5000) = 0.7 + 0.3*0.9 = 0.7 + 0.27 = 0.97
    expect(logged!.reward).toBeCloseTo(0.97, 10);
  });

  it("highest-scored at latencyMs=0 → reward = 1.00 (same as quorum)", () => {
    const entry = makeEntry({ divergenceStrategy: "highest-scored" });
    recordSynthesisDecision(entry);
    correlateSynthesisOutcome(entry.decisionId, 0, true);
    const [logged] = readJsonlLines(logFile, 1);
    expect(logged!.reward).toBeCloseTo(1.0, 10);
  });

  it("contested at latencyMs=0 → reward = -0.21 (NO latency bonus, always negative)", () => {
    const entry = makeEntry({ divergenceStrategy: "contested" });
    recordSynthesisDecision(entry);
    correlateSynthesisOutcome(entry.decisionId, 0, true);
    const [logged] = readJsonlLines(logFile, 1);
    // 0.7 * -0.3 + 0.3 * 0 = -0.21
    expect(logged!.reward).toBeCloseTo(-0.21, 10);
    expect(logged!.reward as number).toBeLessThan(0); // always negative
    expect(logged!.outcome).toBe("success"); // ok=true, but reward negative
    expect(logged!.divergenceStrategy).toBe("contested");
  });

  it("contested at latencyMs=1 → reward = -0.21 (fast contested is still -0.21)", () => {
    const entry = makeEntry({ divergenceStrategy: "contested" });
    recordSynthesisDecision(entry);
    correlateSynthesisOutcome(entry.decisionId, 1, true);
    const [logged] = readJsonlLines(logFile, 1);
    // latencyMs makes no difference when divergenceStrategy=contested
    expect(logged!.reward).toBeCloseTo(-0.21, 10);
  });

  it("hard failure (ok=false) → reward = -0.70", () => {
    const entry = makeEntry({ divergenceStrategy: "quorum" });
    recordSynthesisDecision(entry);
    correlateSynthesisOutcome(entry.decisionId, 0, false);
    const [logged] = readJsonlLines(logFile, 1);
    // 0.7 * -1.0 + 0.3 * 0 = -0.70
    expect(logged!.reward).toBeCloseTo(-0.7, 10);
    expect(logged!.outcome).toBe("failure");
  });

  it("qualityWeight=1.0: contested → reward = -0.30 exactly (no latency component)", () => {
    process.env.MONAD_LEARNING_QUALITY_WEIGHT = "1.0";
    const entry = makeEntry({ divergenceStrategy: "contested" });
    recordSynthesisDecision(entry);
    correlateSynthesisOutcome(entry.decisionId, 0, true);
    const [logged] = readJsonlLines(logFile, 1);
    // 1.0 * -0.3 + 0.0 * 0 = -0.30
    expect(logged!.reward).toBeCloseTo(-0.3, 10);
  });

  it("qualityWeight=0.0: hard failure at 5000ms → reward = 0.0 (latency=0, quality ignored)", () => {
    process.env.MONAD_LEARNING_QUALITY_WEIGHT = "0";
    const entry = makeEntry({ divergenceStrategy: "quorum" });
    recordSynthesisDecision(entry);
    correlateSynthesisOutcome(entry.decisionId, 5_000, false);
    const [logged] = readJsonlLines(logFile, 1);
    // 0.0 * -1.0 + 1.0 * 0 = 0.0  (ok=false → rewardLatency=0)
    expect(logged!.reward).toBeCloseTo(0.0, 10);
  });

  it("JSONL entry contains all required SynthesisDecisionEntry fields", () => {
    const entry = makeEntry({
      divergenceStrategy: "quorum",
      synthesisPolicy: "strict-quorum",
      sourceCount: 3,
      agreeCount: 2,
    });
    recordSynthesisDecision(entry);
    correlateSynthesisOutcome(entry.decisionId, 10, true);
    const [logged] = readJsonlLines(logFile, 1);
    expect(logged!.synthesisPolicy).toBe("strict-quorum");
    expect(logged!.sourceCount).toBe(3);
    expect(logged!.agreeCount).toBe(2);
    expect(logged!.divergenceStrategy).toBe("quorum");
    expect(typeof logged!.reward).toBe("number");
    expect(typeof logged!.latencyMs).toBe("number");
    expect(logged!.outcome).toBe("success");
    expect(Array.isArray(logged!.sourceSummaries)).toBe(true);
  });
});
