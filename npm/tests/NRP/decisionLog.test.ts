/**
 * decisionLog.test.ts — Tracking Routing Decisions and Learning from Outcomes
 *
 * WHAT IS THIS MODULE?
 * When the mesh router picks a node, it records a "decision":
 *   • Which node was chosen (monadId)
 *   • How confident it was (score, margin)
 *   • What drove the choice (breakdown per scorer)
 *
 * Later, when the response comes back (or times out), it "correlates" the outcome:
 *   • Was it a success or failure?
 *   • How long did it take?
 *
 * This two-step process (record → correlate) is what powers the adaptive learning loop.
 * The learning loop can only update weights AFTER it knows whether the decision was good.
 *
 * OPTIONAL LOGGING: When MONAD_DECISION_LOG is set to a file path, every correlated
 * decision is appended as a JSON line to that file. This lets you run offline analysis
 * with `tsx scripts/analyze-decisions.ts decisions.jsonl` to understand why weights shifted.
 *
 * REWARD FORMULA (verified in section 2):
 *   rewardQuality = ok ? 1.0 : −1.0
 *   rewardLatency = ok ? max(0, 1 − latencyMs/5000) : 0
 *   reward = 0.7 × rewardQuality + 0.3 × rewardLatency
 *
 * Examples:
 *   success in    0ms → 0.7×1.0 + 0.3×1.0 = 1.000  (perfect)
 *   success in 2500ms → 0.7×1.0 + 0.3×0.5 = 0.850  (good but slow)
 *   success in 5000ms → 0.7×1.0 + 0.3×0.0 = 0.700  (quality only, no speed bonus)
 *   failure in  any ms → 0.7×(−1) + 0.3×0 = −0.700 (always penalized)
 *
 * WHAT WE TEST:
 *   1. In-memory correlation — recordDecision/correlateOutcome lifecycle
 *   2. Reward computation    — exact formula verification for all latency/outcome combos
 *   3. JSONL file output     — written only when MONAD_DECISION_LOG env var is set
 *   4. Edge cases            — unknown IDs, double correlation, bad log path
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

// Creates a unique temporary file path for each test that needs file output.
// Using a unique name prevents tests from interfering with each other's log files.
function tmpLog(): string {
  return path.join(os.tmpdir(), `decision-log-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

// Reads a JSONL file and parses each line into a DecisionEntry object.
// JSONL = JSON Lines: one JSON object per line, separated by newlines.
function readLog(filePath: string): DecisionEntry[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DecisionEntry);
}

// Builds a minimal valid decision entry. Tests override only what they care about.
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

// Clear pending decisions and unset the log path before each test.
// Without this, a decision recorded in test A could be accidentally correlated in test B.
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
    // WHAT: The most basic flow: record a decision, then correlate its outcome.
    //       No log file is configured (MONAD_DECISION_LOG is unset).
    //
    // WHY: Even without file logging, the correlation must succeed silently.
    //      This is the normal production path for the learning loop:
    //      correlate → compute reward → update adaptive weights.
    //      The file log is optional, the learning is not.
    const d = baseDecision();
    recordDecision(d);
    expect(() => correlateOutcome(d.decisionId, 80, true)).not.toThrow();
  });

  it("correlateOutcome on an unknown decisionId is a no-op", () => {
    // WHAT: Call correlateOutcome with a decisionId that was never recorded.
    //
    // WHY: Race conditions and crashes can cause "orphaned" outcomes. For example:
    //      1. The daemon restarts mid-request
    //      2. The pending decision map is cleared
    //      3. The HTTP response arrives and tries to correlate
    //
    //      In this case, the correlation should silently do nothing rather than crash.
    //      "Orphaned" outcomes are expected in normal operation and must be safe.
    expect(() => correlateOutcome("nonexistent-id", 80, true)).not.toThrow();
  });

  it("pending entry is removed after correlation — second call is a no-op", () => {
    // WHAT: Record one decision, correlate it twice. The log file should have exactly 1 entry.
    //
    // WHY: If the same decisionId could be correlated multiple times, the same routing
    //      decision would contribute to weight learning twice — double-counting the reward.
    //      After the first correlation, the pending entry is removed (consumed), so the
    //      second correlateOutcome finds nothing and writes nothing.
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    const d = baseDecision();
    recordDecision(d);
    correlateOutcome(d.decisionId, 80, true);
    correlateOutcome(d.decisionId, 80, true); // second call: already consumed
    expect(readLog(logFile)).toHaveLength(1);  // only 1 entry, not 2
  });

  it("concurrent decisions for the same monad use distinct decisionIds — no collision", () => {
    // WHAT: Two simultaneous routing decisions to the same monad (m1) with different
    //       decisionIds ("1000:m1" and "1001:m1") must be tracked independently.
    //       The first succeeds quickly, the second fails slowly.
    //
    // WHY: A monad might receive several requests in parallel. Each routing decision
    //      must be independently tracked. If they shared a key, the first outcome
    //      would overwrite the second's data or the second correlation would fail.
    //
    //      After correlation, the log should have exactly 2 entries:
    //      - "1000:m1" → success, score=0.8
    //      - "1001:m1" → failure, score=0.6
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
    // WHAT: Two decisions going to different monads (a and b) are tracked separately.
    //       "a" succeeds, "b" fails — the log correctly records which monad had which outcome.
    //
    // WHY: The learning loop needs to know WHICH node's scorers to reward or penalize.
    //      If decisions for monad "a" and "b" were mixed up, we'd update the wrong weights.
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
//
// The reward formula converts an outcome into a learning signal:
//
//   reward = 0.7 × rewardQuality + 0.3 × rewardLatency
//
//   rewardQuality = ok ? +1.0 : −1.0
//   rewardLatency = ok ? max(0, 1 − latencyMs / 5000) : 0
//
// Breaking it down:
//   70% of the signal is about WHETHER the request succeeded (quality)
//   30% of the signal is about HOW FAST it responded (latency)
//
//   For failures, latency doesn't matter — always −0.70
//   For successes, speed provides a bonus up to +0.30

describe("reward computation", () => {
  it("fast success yields reward close to 1", () => {
    // 0ms latency = maximum speed bonus
    // reward = 0.7 × 1.0 + 0.3 × (1 − 0/5000) = 0.7 + 0.3 × 1.0 = 1.000
    // This is the best possible outcome: instant correct response.
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    const d = baseDecision({ decisionId: "r:fast" });
    recordDecision(d);
    correlateOutcome(d.decisionId, 0, true);
    expect(readLog(logFile)[0]!.reward).toBeCloseTo(1, 5);
  });

  it("moderate latency success yields intermediate reward (not capped by latency alone)", () => {
    // 2500ms = halfway to the 5000ms cap
    // rewardLatency = 1 − 2500/5000 = 0.5
    // reward = 0.7 × 1.0 + 0.3 × 0.5 = 0.7 + 0.15 = 0.85
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    const d = baseDecision({ decisionId: "r:med" });
    recordDecision(d);
    correlateOutcome(d.decisionId, 2500, true);
    expect(readLog(logFile)[0]!.reward).toBeCloseTo(0.85, 5);
  });

  it("success at 5000ms still yields reward 0.7 (quality dominates)", () => {
    // 5000ms = exactly at the latency cap — no speed bonus at all
    // rewardLatency = max(0, 1 − 5000/5000) = max(0, 0) = 0
    // reward = 0.7 × 1.0 + 0.3 × 0 = 0.700
    //
    // Even a very slow success still gets a positive reward (quality = correct answer).
    // We never penalize a node just for being slow — only for being WRONG (failure).
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    const d = baseDecision({ decisionId: "r:sat" });
    recordDecision(d);
    correlateOutcome(d.decisionId, 5000, true);
    expect(readLog(logFile)[0]!.reward).toBeCloseTo(0.70, 5);
  });

  it("success beyond 5000ms is still positive — latency clamped, quality wins", () => {
    // 9000ms >> 5000ms cap → latency contribution is clamped to 0
    // reward = 0.7 × 1.0 + 0.3 × 0 = 0.700 (same as 5000ms)
    // The reward is POSITIVE because the request succeeded.
    // A slow correct answer is always better than a fast wrong one.
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    const d = baseDecision({ decisionId: "r:over" });
    recordDecision(d);
    correlateOutcome(d.decisionId, 9000, true);
    expect(readLog(logFile)[0]!.reward).toBeGreaterThan(0);
  });

  it("failure always yields reward -0.7 regardless of latency (default quality weight)", () => {
    // Failures get: reward = 0.7 × (−1.0) + 0.3 × 0 = −0.700
    // Note that rewardLatency = 0 for failures (we don't care about speed if it was wrong).
    // This means a fast failure and a slow failure both produce reward = −0.700.
    // Design intent: don't let a node "redeem" itself for returning errors quickly.
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    const d1 = baseDecision({ decisionId: "r:f-fast" });
    const d2 = baseDecision({ decisionId: "r:f-slow" });
    recordDecision(d1);
    recordDecision(d2);
    correlateOutcome(d1.decisionId, 10, false);    // fast failure
    correlateOutcome(d2.decisionId, 8000, false);  // slow failure
    const entries = readLog(logFile);
    for (const e of entries) expect(e.reward).toBeCloseTo(-0.7, 5);
  });

  it("reward is always in [-0.7, 1] for all outcomes with default quality weight", () => {
    // For any combination of latency and outcome, reward must stay in [−0.7, 1].
    // This is the invariant that guarantees weight updates are bounded.
    // If reward could go below −0.7, repeated failures would drive weights negative
    // and below WEIGHT_MIN much faster than intended.
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    const cases: [number, boolean][] = [
      [0, true], [100, true], [5000, true], [10000, true],
      [50, false], [9000, false],
    ];
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
    // WHAT: Without the env var, no file is created. The correlation happens in-memory
    //       (updating weights) but no disk write occurs.
    //
    // WHY: File logging is opt-in for two reasons:
    //   1. Performance: disk writes on every request add latency
    //   2. Privacy: decision logs contain routing metadata; not everyone wants them on disk
    //
    // The router works perfectly fine without file logging. Logging is for debugging.
    const logFile = tmpLog(); // a path that should NOT get created
    const d = baseDecision();
    recordDecision(d);
    correlateOutcome(d.decisionId, 80, true);
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it("writes a complete entry including decisionId, outcome, latencyMs, reward", () => {
    // WHAT: With MONAD_DECISION_LOG set, correlateOutcome writes a complete JSON line
    //       with all the fields needed for offline analysis.
    //
    // The written entry contains:
    //   - decisionId:  which decision this was (timestamp:monadId)
    //   - outcome:     "success" or "failure" (human-readable string)
    //   - latencyMs:   how long the forward request took (55ms here)
    //   - score:       the routing score that selected this node (0.77)
    //   - reward:      the computed learning signal (number)
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
    // WHAT: When a routing decision had a runner-up candidate, that info is preserved
    //       in the log entry. This is important for offline analysis:
    //       "Did we route to the right node, or was the runner-up actually better?"
    //
    // WHY: The `analyze-decisions.ts` script uses runnerUp data to detect when the
    //      router consistently picked the wrong node (second-best outcome on success,
    //      first-best on failure — a sign the scoring is inverted for some scorers).
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
    // WHAT: Three decisions are recorded and correlated in sequence.
    //       The log file should have 3 lines, one JSON object per line.
    //
    // WHY: JSONL format (one JSON object per line) is the standard for
    //      streaming log files. It allows `tail -f`, `grep`, and line-by-line
    //      parsing without loading the entire file into memory.
    //
    // We alternate success/failure (i%2===0 → success) to generate variety.
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
    // WHAT: MONAD_DECISION_LOG is set to a path in a directory that doesn't exist.
    //       The system should not crash — it should silently swallow the write error.
    //
    // WHY: The decision log is a best-effort diagnostic tool. If it fails to write,
    //      the routing decision still happened, the weights still update, and the
    //      daemon keeps running. A missing log directory is not worth crashing over.
    //
    //      This also handles the case where someone sets MONAD_DECISION_LOG in their
    //      config but forgets to create the parent directory.
    process.env.MONAD_DECISION_LOG = "/nonexistent/dir/decisions.jsonl";
    const d = baseDecision();
    recordDecision(d);
    expect(() => correlateOutcome(d.decisionId, 80, true)).not.toThrow();
  });
});
