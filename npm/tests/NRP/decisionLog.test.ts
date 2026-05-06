/**
 * NRP Decision Log — test suite
 *
 * Organization:
 *   1. recordDecision / correlateOutcome — in-memory correlation (decisionId as key)
 *   2. reward computation — continuous signal from outcome + latency
 *   3. JSONL file output — written only when MONAD_DECISION_LOG is set
 *   4. edge cases — missing pending, overwrite, no crash on bad path
 */

import fs from "fs";
import os from "os";
import path from "path";
import {
  correlateOutcome,
  recordDecision,
  resetDecisionLogForTests,
  type DecisionEntry,
} from "../../src/kernel/decisionLog.js";

const savedLog = process.env.MONAD_DECISION_LOG;

function tmpLog(): string {
  return path.join(os.tmpdir(), `decision-log-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

function readLog(filePath: string): DecisionEntry[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DecisionEntry);
}

function baseDecision(overrides: Partial<Omit<DecisionEntry, "outcome" | "latencyMs" | "reward">> = {}) {
  return {
    decisionId: `${Date.now()}:m1`,
    timestamp: Date.now(),
    namespace: "suis-macbook-air.local",
    monadId: "m1",
    score: 0.82,
    margin: 0.12,
    breakdown: { recency: { value: 0.9, weight: 0.35, contribution: 0.315 } },
    ...overrides,
  };
}

beforeEach(() => {
  resetDecisionLogForTests();
  delete process.env.MONAD_DECISION_LOG;
});

afterEach(() => {
  if (savedLog !== undefined) process.env.MONAD_DECISION_LOG = savedLog;
  else delete process.env.MONAD_DECISION_LOG;
});

// ── 1. In-memory correlation (decisionId as key) ──────────────────────────────

describe("recordDecision / correlateOutcome — in-memory", () => {
  it("correlates without a log path set — no throw", () => {
    const d = baseDecision();
    recordDecision(d);
    expect(() => correlateOutcome(d.decisionId, 80, true)).not.toThrow();
  });

  it("correlateOutcome on an unknown decisionId is a no-op", () => {
    expect(() => correlateOutcome("nonexistent-id", 80, true)).not.toThrow();
  });

  it("pending entry is removed after correlation — second call is a no-op", () => {
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    const d = baseDecision();
    recordDecision(d);
    correlateOutcome(d.decisionId, 80, true);
    correlateOutcome(d.decisionId, 80, true); // second call: pending already cleared
    expect(readLog(logFile)).toHaveLength(1);
  });

  it("concurrent decisions for the same monad use distinct decisionIds — no collision", () => {
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    const d1 = baseDecision({ decisionId: "1000:m1", score: 0.8 });
    const d2 = baseDecision({ decisionId: "1001:m1", score: 0.6 });
    recordDecision(d1);
    recordDecision(d2);
    correlateOutcome(d1.decisionId, 40, true);
    correlateOutcome(d2.decisionId, 90, false);
    const entries = readLog(logFile);
    expect(entries).toHaveLength(2);
    const success = entries.find((e) => e.outcome === "success")!;
    const failure = entries.find((e) => e.outcome === "failure")!;
    expect(success.score).toBe(0.8);
    expect(failure.score).toBe(0.6);
  });

  it("different monadIds are tracked independently", () => {
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    const da = baseDecision({ decisionId: "t:a", monadId: "a", score: 0.7 });
    const db = baseDecision({ decisionId: "t:b", monadId: "b", score: 0.5 });
    recordDecision(da);
    recordDecision(db);
    correlateOutcome(da.decisionId, 40, true);
    correlateOutcome(db.decisionId, 90, false);
    const entries = readLog(logFile);
    expect(entries.find((e) => e.monadId === "a")!.outcome).toBe("success");
    expect(entries.find((e) => e.monadId === "b")!.outcome).toBe("failure");
  });
});

// ── 2. Reward computation ─────────────────────────────────────────────────────
// Formula: reward = 0.7 * rewardQuality + 0.3 * rewardLatency
//   rewardQuality = ok ? 1.0 : -1.0
//   rewardLatency = ok ? max(0, 1 - ms/5000) : 0
// Fast success: 0.7*1 + 0.3*1 = 1.0
// Slow success (3s): 0.7*1 + 0.3*0.4 = 0.82
// Success at 5s: 0.7*1 + 0.3*0 = 0.70
// Any failure: 0.7*(-1) + 0.3*0 = -0.70

describe("reward computation", () => {
  it("fast success yields reward close to 1", () => {
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    const d = baseDecision({ decisionId: "r:fast" });
    recordDecision(d);
    correlateOutcome(d.decisionId, 0, true); // 0ms → 0.7*1 + 0.3*1 = 1.0
    expect(readLog(logFile)[0]!.reward).toBeCloseTo(1, 5);
  });

  it("moderate latency success yields intermediate reward (not capped by latency alone)", () => {
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    const d = baseDecision({ decisionId: "r:med" });
    recordDecision(d);
    correlateOutcome(d.decisionId, 2500, true); // 0.7*1 + 0.3*0.5 = 0.85
    expect(readLog(logFile)[0]!.reward).toBeCloseTo(0.85, 5);
  });

  it("success at 5000ms still yields reward 0.7 (quality dominates)", () => {
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    const d = baseDecision({ decisionId: "r:sat" });
    recordDecision(d);
    correlateOutcome(d.decisionId, 5000, true); // 0.7*1 + 0.3*0 = 0.70
    expect(readLog(logFile)[0]!.reward).toBeCloseTo(0.70, 5);
  });

  it("success beyond 5000ms is still positive — latency clamped, quality wins", () => {
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    const d = baseDecision({ decisionId: "r:over" });
    recordDecision(d);
    correlateOutcome(d.decisionId, 9000, true); // 0.7*1 + 0.3*0 = 0.70
    expect(readLog(logFile)[0]!.reward).toBeGreaterThan(0);
  });

  it("failure always yields reward -0.7 regardless of latency (default quality weight)", () => {
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    const d1 = baseDecision({ decisionId: "r:f-fast" });
    const d2 = baseDecision({ decisionId: "r:f-slow" });
    recordDecision(d1);
    recordDecision(d2);
    correlateOutcome(d1.decisionId, 10, false);   // 0.7*(-1) + 0.3*0 = -0.7
    correlateOutcome(d2.decisionId, 8000, false);
    const entries = readLog(logFile);
    for (const e of entries) expect(e.reward).toBeCloseTo(-0.7, 5);
  });

  it("reward is always in [-0.7, 1] for all outcomes with default quality weight", () => {
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    const cases: [number, boolean][] = [[0, true], [100, true], [5000, true], [10000, true], [50, false], [9000, false]];
    cases.forEach(([ms, ok], i) => {
      const d = baseDecision({ decisionId: `r:bound-${i}` });
      recordDecision(d);
      correlateOutcome(d.decisionId, ms, ok);
    });
    for (const e of readLog(logFile)) {
      expect(e.reward!).toBeGreaterThanOrEqual(-0.7);
      expect(e.reward!).toBeLessThanOrEqual(1);
    }
  });
});

// ── 3. JSONL file output ──────────────────────────────────────────────────────

describe("JSONL output", () => {
  it("does not write when MONAD_DECISION_LOG is unset", () => {
    const logFile = tmpLog();
    const d = baseDecision();
    recordDecision(d);
    correlateOutcome(d.decisionId, 80, true);
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it("writes a complete entry including decisionId, outcome, latencyMs, reward", () => {
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    const d = baseDecision({ decisionId: "j:1", score: 0.77, margin: 0.08 });
    recordDecision(d);
    correlateOutcome(d.decisionId, 55, true);
    const entries = readLog(logFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.decisionId).toBe("j:1");
    expect(entries[0]!.outcome).toBe("success");
    expect(entries[0]!.latencyMs).toBe(55);
    expect(entries[0]!.score).toBe(0.77);
    expect(typeof entries[0]!.reward).toBe("number");
  });

  it("preserves runnerUp field", () => {
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    const d = baseDecision({
      decisionId: "j:2",
      runnerUp: { monad_id: "m2", score: 0.70 },
    });
    recordDecision(d);
    correlateOutcome(d.decisionId, 40, true);
    expect(readLog(logFile)[0]!.runnerUp).toEqual({ monad_id: "m2", score: 0.70 });
  });

  it("appends multiple entries — each on its own line", () => {
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    for (let i = 0; i < 3; i++) {
      const d = baseDecision({ decisionId: `j:multi-${i}`, monadId: `m${i}` });
      recordDecision(d);
      correlateOutcome(d.decisionId, 50, i % 2 === 0);
    }
    expect(readLog(logFile)).toHaveLength(3);
  });
});

// ── 4. Edge cases ─────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("does not throw when log path directory does not exist", () => {
    process.env.MONAD_DECISION_LOG = "/nonexistent/dir/decisions.jsonl";
    const d = baseDecision();
    recordDecision(d);
    expect(() => correlateOutcome(d.decisionId, 80, true)).not.toThrow();
  });
});
