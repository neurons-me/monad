/**
 * NRP Scoring Engine — test suite
 *
 * Organization:
 *   1. claim meta I/O     — readClaimMeta / writeClaimMeta
 *   2. computeScore       — behavioral (scorers work correctly)
 *   3. computeScore       — invariants (contracts that must NEVER break)
 *   4. recordForwardResult — learning loop
 *   5. integration        — selectMeshClaimant uses scoring to pick the best node
 */

import fs from "fs";
import os from "os";
import path from "path";
import { resetKernelStateForTests } from "../../src/kernel/manager.js";
import { writeMonadIndexEntry, type MonadIndexEntry } from "../../src/kernel/monadIndex.js";
import {
  computeScore,
  readClaimMeta,
  recordForwardResult,
  writeClaimMeta,
  type ClaimMeta,
  type ScoringContext,
} from "../../src/kernel/scoring.js";
import { selectMeshClaimant } from "../../src/kernel/meshSelect.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const savedSeed = process.env.SEED;
const savedStateDir = process.env.ME_STATE_DIR;

beforeEach(() => {
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

function baseCtx(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return { namespace: NS, requestedAt: Date.now(), ...overrides };
}

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

// ── 1. Claim meta I/O ─────────────────────────────────────────────────────────

describe("claim meta I/O", () => {
  it("returns empty object for unknown monad/namespace", () => {
    expect(readClaimMeta("nobody", "unknown.local")).toEqual({});
  });

  it("roundtrips a claim meta object", () => {
    writeClaimMeta("frank-m", NS, { resonance: 42, avgLatencyMs: 55 });
    const meta = readClaimMeta("frank-m", NS);
    expect(meta.resonance).toBe(42);
    expect(meta.avgLatencyMs).toBe(55);
  });

  it("merges partial updates without overwriting other fields", () => {
    writeClaimMeta("frank-m", NS, { resonance: 10, avgLatencyMs: 100 });
    writeClaimMeta("frank-m", NS, { avgLatencyMs: 50 });
    const meta = readClaimMeta("frank-m", NS);
    expect(meta.resonance).toBe(10);   // untouched
    expect(meta.avgLatencyMs).toBe(50); // updated
  });

  it("stores any arbitrary field — schema is open", () => {
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
    const m = baseEntry({ last_seen: Date.now() - 500 });
    writeClaimMeta("m1", NS, { resonance: 50, avgLatencyMs: 40 });
    const meta = readClaimMeta("m1", NS);
    expect(computeScore(m, meta, baseCtx())).toBeGreaterThan(0);
  });

  it("stale entry scores lower than fresh entry (same meta)", () => {
    const now = Date.now();
    const fresh = baseEntry({ monad_id: "fresh", last_seen: now - 500 });
    const stale = baseEntry({ monad_id: "stale", last_seen: now - 280_000 });
    const meta: ClaimMeta = { resonance: 50, avgLatencyMs: 100 };
    const c = baseCtx({ requestedAt: now });
    expect(computeScore(fresh, meta, c)).toBeGreaterThan(computeScore(stale, meta, c));
  });

  it("high resonance scores higher than zero resonance (same freshness)", () => {
    const m = baseEntry({ last_seen: Date.now() - 1_000 });
    const c = baseCtx();
    expect(computeScore(m, { resonance: 80 }, c)).toBeGreaterThan(
      computeScore(m, { resonance: 0 }, c),
    );
  });

  it("low latency scores higher than high latency (same freshness)", () => {
    const m = baseEntry({ last_seen: Date.now() - 1_000 });
    const c = baseCtx();
    expect(computeScore(m, { avgLatencyMs: 10 }, c)).toBeGreaterThan(
      computeScore(m, { avgLatencyMs: 1800 }, c),
    );
  });

  it("extra scorer stacks on top of built-ins", () => {
    const m = baseEntry();
    const c = baseCtx();
    const base = computeScore(m, {}, c);
    const withExtra = computeScore(m, {}, c, [
      { name: "bonus", defaultWeight: 0.5, fn: () => 1 },
    ]);
    expect(withExtra).toBeGreaterThan(base);
  });

  it("extra scorer can read arbitrary meta fields", () => {
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
    const m = baseEntry({ last_seen: Date.now() - 280_000 }); // nearly stale
    // Maximize resonance contribution, zero out others
    const meta: ClaimMeta = {
      resonance: 100,
      _weight_recency: 0,
      _weight_resonance: 1,
      _weight_latency: 0,
    };
    // Score should be close to 1 (resonance fully dominates)
    expect(computeScore(m, meta, baseCtx())).toBeCloseTo(1, 1);
  });
});

// ── 3. computeScore — invariants ──────────────────────────────────────────────
// These are hard contracts. If any of these break, the engine is broken.

describe("computeScore — invariants", () => {
  it("score is always in [0, 1] with default weights", () => {
    const score = computeScore(baseEntry(), {}, baseCtx());
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("score is always in [0, 1] with extreme weight overrides", () => {
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
    const m = baseEntry();
    const c = baseCtx();
    // Same relative weights: 0.35:0.40:0.25 is equal to 350:400:250
    const unit: ClaimMeta = { _weight_recency: 0.35, _weight_resonance: 0.40, _weight_latency: 0.25 };
    const scaled: ClaimMeta = { _weight_recency: 350, _weight_resonance: 400, _weight_latency: 250 };
    expect(computeScore(m, unit, c)).toBeCloseTo(computeScore(m, scaled, c), 10);
  });

  it("is deterministic — identical inputs produce identical output", () => {
    const m = baseEntry();
    const meta: ClaimMeta = { resonance: 50, avgLatencyMs: 80 };
    const c = baseCtx({ requestedAt: 1_000_000_000 }); // fixed timestamp
    const a = computeScore(m, meta, c);
    const b = computeScore(m, meta, c);
    expect(a).toBe(b);
  });

  it("extra scorer injection order does not change the score", () => {
    const m = baseEntry();
    const c = baseCtx({ requestedAt: 1_000_000_000 });
    const geo = { name: "geo", defaultWeight: 0.2, fn: () => 0.7 };
    const energy = { name: "energy", defaultWeight: 0.1, fn: () => 0.5 };
    // Different injection order → same result (alphabetical sort inside)
    const ab = computeScore(m, {}, c, [geo, energy]);
    const ba = computeScore(m, {}, c, [energy, geo]);
    expect(ab).toBe(ba);
  });

  it("NaN in meta does not propagate — score remains finite", () => {
    const meta: ClaimMeta = { avgLatencyMs: NaN, resonance: NaN };
    const score = computeScore(baseEntry(), meta, baseCtx());
    expect(Number.isFinite(score)).toBe(true);
  });

  it("Infinity in meta does not propagate — score stays in [0, 1]", () => {
    const meta: ClaimMeta = { resonance: Infinity, avgLatencyMs: -Infinity };
    const score = computeScore(baseEntry(), meta, baseCtx());
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("invalid weight (NaN) falls back to zero — scorer excluded gracefully", () => {
    const meta: ClaimMeta = { _weight_resonance: NaN };
    const score = computeScore(baseEntry(), meta, baseCtx());
    expect(Number.isFinite(score)).toBe(true);
  });

  it("raw mode is unbounded but still finite when weights are valid", () => {
    const meta: ClaimMeta = { _weight_resonance: 10 };
    const score = computeScore(baseEntry(), meta, baseCtx({ mode: "raw" }));
    expect(Number.isFinite(score)).toBe(true);
    // raw mode with weight=10 can exceed 1
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

// ── 4. recordForwardResult — learning loop ────────────────────────────────────

describe("recordForwardResult — learning loop", () => {
  it("increments resonance and forwardCount on success", () => {
    recordForwardResult("m1", NS, 80, true);
    const meta = readClaimMeta("m1", NS);
    expect(Number(meta.resonance)).toBeGreaterThan(0);
    expect(Number(meta.forwardCount)).toBe(1);
    expect(Number(meta.failureCount)).toBe(0);
  });

  it("decrements resonance and increments failureCount on failure", () => {
    writeClaimMeta("m1", NS, { resonance: 10 });
    recordForwardResult("m1", NS, 5_000, false);
    const meta = readClaimMeta("m1", NS);
    expect(Number(meta.resonance)).toBeLessThan(10);
    expect(Number(meta.failureCount)).toBe(1);
  });

  it("tracks EWMA latency (weighted toward recent values)", () => {
    recordForwardResult("m1", NS, 1_000, true); // seed with slow value
    recordForwardResult("m1", NS, 100, true);   // fast follow-up
    const meta = readClaimMeta("m1", NS);
    // EWMA pulls toward recent — should be between 100 and 1000
    expect(Number(meta.avgLatencyMs)).toBeGreaterThan(100);
    expect(Number(meta.avgLatencyMs)).toBeLessThan(1_000);
  });

  it("resonance decays with 0.97 factor — old wins don't last forever", () => {
    writeClaimMeta("m1", NS, { resonance: 100 });
    recordForwardResult("m1", NS, 50, true);
    const meta = readClaimMeta("m1", NS);
    // 100 * 0.97 + 1 = 98 — decayed from 100 despite success
    expect(Number(meta.resonance)).toBeLessThan(100);
  });

  it("effectiveResonance is penalized by failure rate", () => {
    // Seed with some history
    writeClaimMeta("m1", NS, { resonance: 50, forwardCount: 4, failureCount: 2 });
    recordForwardResult("m1", NS, 80, false); // one more failure
    const meta = readClaimMeta("m1", NS);
    // failureRate = 3/5 = 0.6 → effectiveResonance = resonance * 0.4
    expect(Number(meta.effectiveResonance)).toBeLessThan(Number(meta.resonance));
  });

  it("resonance never exceeds 1000", () => {
    writeClaimMeta("m1", NS, { resonance: 999.9 });
    recordForwardResult("m1", NS, 10, true);
    expect(Number(readClaimMeta("m1", NS).resonance)).toBeLessThanOrEqual(1000);
  });

  it("resonance never goes below 0", () => {
    writeClaimMeta("m1", NS, { resonance: 0 });
    recordForwardResult("m1", NS, 5_000, false);
    expect(Number(readClaimMeta("m1", NS).resonance)).toBeGreaterThanOrEqual(0);
  });
});

// ── 5. Integration — selectMeshClaimant uses scoring ─────────────────────────

describe("selectMeshClaimant — scoring integration", () => {
  it("selects the higher-resonance claimant over a fresher but unknown node", async () => {
    const now = Date.now();

    // veteran: slightly older, but with real resonance history
    writeMonadIndexEntry(baseEntry({ monad_id: "veteran", endpoint: "http://localhost:8282", last_seen: now - 3_000 }));
    writeClaimMeta("veteran", NS, {
      resonance: 90,
      avgLatencyMs: 30,
      // upweight resonance so it dominates freshness
      _weight_resonance: 0.8, _weight_recency: 0.1, _weight_latency: 0.1,
    });

    // newcomer: fresher, but zero history
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
    const now = Date.now();
    // "a" is fresher by default ranking
    writeMonadIndexEntry(baseEntry({ monad_id: "a", endpoint: "http://localhost:8282", last_seen: now - 1_000 }));
    // "b" is slightly older but has a geo advantage
    writeMonadIndexEntry(baseEntry({ monad_id: "b", endpoint: "http://localhost:8283", last_seen: now - 2_000 }));
    writeClaimMeta("b", NS, { geopoliticalZone: "mx-east" });

    const r = await selectMeshClaimant({
      monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID, now,
      extraScorers: [{
        name: "geo",
        defaultWeight: 10, // dominates — "a" gets 0 for this, "b" gets full weight
        fn: (_m, meta) => meta.geopoliticalZone === "mx-east" ? 1 : 0,
      }],
    });
    expect(r!.entry.monad_id).toBe("b");
  });

  it("learning loop shifts winner after repeated successful forwards", async () => {
    const now = Date.now();
    writeMonadIndexEntry(baseEntry({ monad_id: "a", endpoint: "http://localhost:8282", last_seen: now - 1_000 }));
    writeMonadIndexEntry(baseEntry({ monad_id: "b", endpoint: "http://localhost:8283", last_seen: now - 1_000 }));

    // Simulate "b" having accumulated many successful forwards
    for (let i = 0; i < 20; i++) recordForwardResult("b", NS, 30, true);

    const r = await selectMeshClaimant({
      monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID, now,
    });
    expect(r!.entry.monad_id).toBe("b");
  });
});
