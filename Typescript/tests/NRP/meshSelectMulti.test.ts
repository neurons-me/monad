/**
 * meshSelectMulti.test.ts — Phase 10: Multi-candidate mesh selection
 *
 * WHAT IS THIS?
 * selectMeshClaimants is the Phase 10 extension of selectMeshClaimant.
 * Instead of returning one winner, it returns a ranked list of qualified
 * candidates that the synthesis engine will query in parallel.
 *
 * Key differences from selectMeshClaimant:
 * - Returns MeshMultiSelection (candidates[]) instead of MeshSelection | null.
 * - No explorationRate: synthesis consults all candidates, not runner-up.
 * - minRelativeScore filters out low-confidence claimants before synthesis.
 * - maxCandidates caps the list so synthesis stays bounded.
 *
 * WHAT WE TEST (5 groups):
 *   1. No claimants — returns empty array, not null
 *   2. Self-exclusion — never includes self
 *   3. Staleness — respects stalenessMs
 *   4. Ranking and filtering — top-N, minRelativeScore, score order preserved
 *   5. Single candidate — degenerates gracefully to length-1 list
 */

import fs from "fs";
import os from "os";
import path from "path";
import { resetKernelStateForTests } from "../../src/kernel/manager.js";
import { writeMonadIndexEntry, type MonadIndexEntry } from "../../src/kernel/monadIndex.js";
import { selectMeshClaimants } from "../../src/kernel/meshSelectMulti.js";

// ── Test isolation ──────────────────────────────────────────────────────────

const savedSeed = process.env.SEED;
const savedStateDir = process.env.ME_STATE_DIR;

beforeEach(() => {
  process.env.ME_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "monad-nrp-multi-"));
  process.env.SEED = "nrp-multi-test-seed";
  resetKernelStateForTests();
});

afterEach(() => {
  process.env.SEED = savedSeed;
  process.env.ME_STATE_DIR = savedStateDir;
  resetKernelStateForTests();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const SELF = "http://localhost:8161";
const SELF_ID = "self-monad-xyz";
const NS = "suis-macbook-air.local";
const NOW = Date.now();

function mesh(overrides: Partial<MonadIndexEntry>): MonadIndexEntry {
  return {
    monad_id: "frank-m",
    namespace: NS,
    endpoint: "http://localhost:8282",
    name: "frank",
    claimed_namespaces: [NS],
    first_seen: NOW - 10_000,
    last_seen: NOW - 1_000,
    ...overrides,
  };
}

function baseOpts() {
  return {
    namespace: NS,
    selfEndpoint: SELF,
    selfMonadId: SELF_ID,
    now: NOW,
  };
}

// ── 1. No claimants ─────────────────────────────────────────────────────────

describe("selectMeshClaimants — no claimants", () => {
  it("returns empty candidates array when index is empty", async () => {
    const result = await selectMeshClaimants(baseOpts());
    expect(result.candidates).toHaveLength(0);
    expect(result.namespace).toBe(NS);
  });

  it("returns empty candidates when only self is in the index", async () => {
    writeMonadIndexEntry(mesh({ monad_id: SELF_ID, endpoint: SELF }));
    const result = await selectMeshClaimants(baseOpts());
    expect(result.candidates).toHaveLength(0);
  });
});

// ── 2. Self-exclusion ───────────────────────────────────────────────────────

describe("selectMeshClaimants — self exclusion", () => {
  it("excludes entry matching selfEndpoint", async () => {
    writeMonadIndexEntry(mesh({ monad_id: "other-m", endpoint: SELF }));
    const result = await selectMeshClaimants(baseOpts());
    expect(result.candidates).toHaveLength(0);
  });

  it("excludes entry matching selfMonadId regardless of endpoint", async () => {
    writeMonadIndexEntry(mesh({ monad_id: SELF_ID, endpoint: "http://other:9000" }));
    const result = await selectMeshClaimants(baseOpts());
    expect(result.candidates).toHaveLength(0);
  });

  it("does not exclude non-self entries", async () => {
    writeMonadIndexEntry(mesh({ monad_id: "frank-m", endpoint: "http://frank:8282" }));
    const result = await selectMeshClaimants(baseOpts());
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.entry.monad_id).toBe("frank-m");
  });
});

// ── 3. Staleness ────────────────────────────────────────────────────────────

describe("selectMeshClaimants — staleness", () => {
  it("excludes entries older than stalenessMs", async () => {
    const staleMs = 60_000;
    writeMonadIndexEntry(mesh({ monad_id: "stale-m", last_seen: NOW - staleMs - 1 }));
    const result = await selectMeshClaimants({ ...baseOpts(), stalenessMs: staleMs });
    expect(result.candidates).toHaveLength(0);
  });

  it("includes entries exactly at the staleness boundary", async () => {
    const staleMs = 60_000;
    writeMonadIndexEntry(mesh({ monad_id: "edge-m", endpoint: "http://edge:8282", last_seen: NOW - staleMs }));
    const result = await selectMeshClaimants({ ...baseOpts(), stalenessMs: staleMs });
    expect(result.candidates).toHaveLength(1);
  });
});

// ── 4. Ranking and filtering ─────────────────────────────────────────────────

describe("selectMeshClaimants — ranking and filtering", () => {
  it("returns candidates sorted descending by score", async () => {
    // fresh > stale-ish in recency scorer → frank (1s ago) beats alice (10s ago)
    writeMonadIndexEntry(mesh({ monad_id: "frank-m", endpoint: "http://frank:8282", last_seen: NOW - 1_000 }));
    writeMonadIndexEntry(mesh({ monad_id: "alice-m", endpoint: "http://alice:8282", last_seen: NOW - 10_000 }));
    const result = await selectMeshClaimants({ ...baseOpts(), maxCandidates: 3 });
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < result.candidates.length; i++) {
      expect(result.candidates[i - 1]!.score).toBeGreaterThanOrEqual(result.candidates[i]!.score);
    }
  });

  it("respects maxCandidates cap", async () => {
    for (let i = 0; i < 5; i++) {
      writeMonadIndexEntry(
        mesh({ monad_id: `node-${i}`, endpoint: `http://node${i}:${8282 + i}`, last_seen: NOW - i * 1_000 }),
      );
    }
    const result = await selectMeshClaimants({ ...baseOpts(), maxCandidates: 2, minRelativeScore: 0 });
    expect(result.candidates.length).toBeLessThanOrEqual(2);
  });

  it("minRelativeScore=0 includes all structural candidates", async () => {
    for (let i = 0; i < 4; i++) {
      writeMonadIndexEntry(
        mesh({ monad_id: `node-${i}`, endpoint: `http://node${i}:${8282 + i}`, last_seen: NOW - i * 30_000 }),
      );
    }
    const result = await selectMeshClaimants({ ...baseOpts(), maxCandidates: 10, minRelativeScore: 0 });
    expect(result.candidates.length).toBe(4);
  });

  it("minRelativeScore=1 keeps only exact-score-match candidates", async () => {
    // Two nodes with same last_seen → same recency score → both should pass score=1.0
    writeMonadIndexEntry(mesh({ monad_id: "a-m", endpoint: "http://a:8282", last_seen: NOW - 1_000 }));
    writeMonadIndexEntry(mesh({ monad_id: "b-m", endpoint: "http://b:8283", last_seen: NOW - 1_000 }));
    // A third with much older last_seen → lower score → should be filtered
    writeMonadIndexEntry(mesh({ monad_id: "c-m", endpoint: "http://c:8284", last_seen: NOW - 200_000 }));
    const result = await selectMeshClaimants({ ...baseOpts(), maxCandidates: 10, minRelativeScore: 1.0 });
    const ids = result.candidates.map((c) => c.entry.monad_id);
    expect(ids).not.toContain("c-m");
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it("first candidate is the winner that selectMeshClaimant would have chosen", async () => {
    writeMonadIndexEntry(mesh({ monad_id: "fresh-m", endpoint: "http://fresh:8282", last_seen: NOW - 500 }));
    writeMonadIndexEntry(mesh({ monad_id: "old-m", endpoint: "http://old:8283", last_seen: NOW - 100_000 }));
    const result = await selectMeshClaimants({ ...baseOpts(), maxCandidates: 3, minRelativeScore: 0 });
    expect(result.candidates[0]!.entry.monad_id).toBe("fresh-m");
  });

  it("each candidate exposes score and breakdown", async () => {
    writeMonadIndexEntry(mesh({ monad_id: "frank-m", endpoint: "http://frank:8282" }));
    const result = await selectMeshClaimants(baseOpts());
    expect(result.candidates[0]!.score).toBeGreaterThanOrEqual(0);
    expect(result.candidates[0]!.breakdown).toBeDefined();
    expect(typeof result.candidates[0]!.breakdown.total).toBe("number");
  });
});

// ── 5. Single candidate ──────────────────────────────────────────────────────

describe("selectMeshClaimants — single candidate", () => {
  it("degenerates to a length-1 list when only one qualifies", async () => {
    writeMonadIndexEntry(mesh({ monad_id: "solo-m", endpoint: "http://solo:8282" }));
    const result = await selectMeshClaimants({ ...baseOpts(), maxCandidates: 3 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.entry.monad_id).toBe("solo-m");
  });

  it("maxCandidates=1 returns exactly one candidate even when more qualify", async () => {
    for (let i = 0; i < 3; i++) {
      writeMonadIndexEntry(
        mesh({ monad_id: `node-${i}`, endpoint: `http://node${i}:${8282 + i}` }),
      );
    }
    const result = await selectMeshClaimants({ ...baseOpts(), maxCandidates: 1, minRelativeScore: 0 });
    expect(result.candidates).toHaveLength(1);
  });
});
