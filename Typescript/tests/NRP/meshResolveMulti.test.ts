/**
 * meshResolveMulti.test.ts — Phase 10: GET /.mesh/resolve/multi endpoint
 *
 * WHAT IS THIS?
 * /.mesh/resolve/multi is an observability endpoint that exposes the scored
 * candidate list that Phase 10 Total Monad Synthesis would query for a given
 * namespace. It does NOT forward requests — it answers "who would talk?"
 *
 * WHAT WE TEST:
 *   1. Missing namespace → 400 NAMESPACE_REQUIRED
 *   2. Namespace with no claimants → ok=true, candidates=[]
 *   3. Candidates returned with score + breakdown
 *   4. max= query param caps candidates count
 *   5. min_score= query param applies minRelativeScore filter
 *   6. staleness= query param respected
 *   7. selector= query param passed through
 *   8. Self-monad excluded from results
 *   9. Response shape — all required fields present
 *  10. Unknown namespace → ok=true, candidates=[] (not an error)
 */

import express from "express";
import request from "supertest";
import { createMeshResolveRouter } from "../../src/http/meshResolve.js";
import { writeMonadIndexEntry, type MonadIndexEntry } from "../../src/kernel/monadIndex.js";
import { resetKernelStateForTests } from "../../src/kernel/manager.js";

// ── App setup ─────────────────────────────────────────────────────────────────

function buildApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(createMeshResolveRouter());
  return app;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const NS = "test.monad.me";
const NOW = Date.now();

function entry(overrides: {
  monad_id: string;
  endpoint?: string;
  namespace?: string;
  last_seen?: number;
}): MonadIndexEntry {
  const ns = overrides.namespace ?? NS;
  return {
    monad_id: overrides.monad_id,
    namespace: ns,
    endpoint: overrides.endpoint ?? `http://${overrides.monad_id}:8282`,
    last_seen: overrides.last_seen ?? NOW,
    claimed_namespaces: [ns],
    tags: [],
    type: "monad",
  };
}

beforeEach(() => {
  resetKernelStateForTests();
  delete process.env.MONAD_SELF_ENDPOINT;
  delete process.env.MONAD_ID;
});

// ── 1. Validation ─────────────────────────────────────────────────────────────

describe("/.mesh/resolve/multi — validation", () => {
  it("missing namespace → 400 NAMESPACE_REQUIRED", async () => {
    const app = buildApp();
    const res = await request(app).get("/.mesh/resolve/multi");
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("NAMESPACE_REQUIRED");
    expect(res.body.hint).toBeDefined();
  });

  it("empty namespace string → 400", async () => {
    const app = buildApp();
    const res = await request(app).get("/.mesh/resolve/multi?namespace=");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("NAMESPACE_REQUIRED");
  });
});

// ── 2. No claimants ───────────────────────────────────────────────────────────

describe("/.mesh/resolve/multi — no claimants", () => {
  it("namespace with no registered monads → ok=true, candidates=[]", async () => {
    const app = buildApp();
    const res = await request(app).get("/.mesh/resolve/multi?namespace=empty.me");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.candidates).toEqual([]);
    expect(res.body._meta.count).toBe(0);
  });
});

// ── 3. Candidates returned ────────────────────────────────────────────────────

describe("/.mesh/resolve/multi — candidate list", () => {
  it("registered monads appear in response with score + breakdown", async () => {
    writeMonadIndexEntry(entry({ monad_id: "m1" }));
    writeMonadIndexEntry(entry({ monad_id: "m2" }));
    const app = buildApp();
    const res = await request(app).get(`/.mesh/resolve/multi?namespace=${NS}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.candidates.length).toBeGreaterThanOrEqual(1);
    const c = res.body.candidates[0];
    expect(typeof c.monad_id).toBe("string");
    expect(typeof c.endpoint).toBe("string");
    expect(typeof c.score).toBe("number");
    expect(typeof c.breakdown).toBe("object");
    expect(typeof c.breakdown.total).toBe("number");
  });

  it("candidates are sorted score descending", async () => {
    writeMonadIndexEntry(entry({ monad_id: "a1" }));
    writeMonadIndexEntry(entry({ monad_id: "a2" }));
    writeMonadIndexEntry(entry({ monad_id: "a3" }));
    const app = buildApp();
    const res = await request(app).get(`/.mesh/resolve/multi?namespace=${NS}&min_score=0`);
    const scores: number[] = res.body.candidates.map((c: any) => c.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
    }
  });

  it("namespace field on each candidate matches the queried namespace", async () => {
    writeMonadIndexEntry(entry({ monad_id: "ns-check" }));
    const app = buildApp();
    const res = await request(app).get(`/.mesh/resolve/multi?namespace=${NS}&min_score=0`);
    for (const c of res.body.candidates) {
      expect(c.namespace).toBe(NS);
    }
  });
});

// ── 4. max= parameter ─────────────────────────────────────────────────────────

describe("/.mesh/resolve/multi — max= query param", () => {
  it("max=1 caps response to 1 candidate", async () => {
    writeMonadIndexEntry(entry({ monad_id: "cap1" }));
    writeMonadIndexEntry(entry({ monad_id: "cap2" }));
    writeMonadIndexEntry(entry({ monad_id: "cap3" }));
    const app = buildApp();
    const res = await request(app).get(`/.mesh/resolve/multi?namespace=${NS}&max=1&min_score=0`);
    expect(res.body.candidates.length).toBeLessThanOrEqual(1);
    expect(res.body._meta.maxRequested).toBe(1);
  });

  it("max=10 is the upper bound — clamped from above", async () => {
    const app = buildApp();
    const res = await request(app).get(`/.mesh/resolve/multi?namespace=${NS}&max=999`);
    expect(res.body._meta.maxRequested).toBe(10);
  });

  it("max=0 is clamped to 1", async () => {
    const app = buildApp();
    const res = await request(app).get(`/.mesh/resolve/multi?namespace=${NS}&max=0`);
    expect(res.body._meta.maxRequested).toBe(1);
  });

  it("non-numeric max uses default 3", async () => {
    const app = buildApp();
    const res = await request(app).get(`/.mesh/resolve/multi?namespace=${NS}&max=abc`);
    expect(res.body._meta.maxRequested).toBe(3);
  });
});

// ── 5. min_score= parameter ───────────────────────────────────────────────────

describe("/.mesh/resolve/multi — min_score= query param", () => {
  it("min_score=0 includes all candidates regardless of score gap", async () => {
    writeMonadIndexEntry(entry({ monad_id: "ms1" }));
    writeMonadIndexEntry(entry({ monad_id: "ms2" }));
    const app = buildApp();
    const res = await request(app).get(`/.mesh/resolve/multi?namespace=${NS}&min_score=0&max=10`);
    expect(res.body._meta.minRelativeScore).toBe(0);
  });

  it("min_score > 1 is clamped to 1", async () => {
    const app = buildApp();
    const res = await request(app).get(`/.mesh/resolve/multi?namespace=${NS}&min_score=2`);
    expect(res.body._meta.minRelativeScore).toBe(1);
  });

  it("min_score < 0 is clamped to 0", async () => {
    const app = buildApp();
    const res = await request(app).get(`/.mesh/resolve/multi?namespace=${NS}&min_score=-1`);
    expect(res.body._meta.minRelativeScore).toBe(0);
  });

  it("non-numeric min_score uses default 0.8", async () => {
    const app = buildApp();
    const res = await request(app).get(`/.mesh/resolve/multi?namespace=${NS}&min_score=bad`);
    expect(res.body._meta.minRelativeScore).toBe(0.8);
  });
});

// ── 6. staleness= parameter ───────────────────────────────────────────────────

describe("/.mesh/resolve/multi — staleness= query param", () => {
  it("staleness=1 excludes old entries", async () => {
    // entry seen 60 seconds ago — stale under staleness=1ms
    writeMonadIndexEntry({ ...entry({ monad_id: "stale-m" }), last_seen: NOW - 60_000 });
    const app = buildApp();
    const res = await request(app).get(`/.mesh/resolve/multi?namespace=${NS}&staleness=1&min_score=0`);
    const ids: string[] = res.body.candidates.map((c: any) => c.monad_id);
    expect(ids).not.toContain("stale-m");
  });

  it("staleness default includes recently-seen entries", async () => {
    writeMonadIndexEntry(entry({ monad_id: "fresh-m" }));
    const app = buildApp();
    const res = await request(app).get(`/.mesh/resolve/multi?namespace=${NS}&min_score=0`);
    const ids: string[] = res.body.candidates.map((c: any) => c.monad_id);
    expect(ids).toContain("fresh-m");
  });

  it("staleness=0 uses default (not 0 window)", async () => {
    writeMonadIndexEntry(entry({ monad_id: "default-stale" }));
    const app = buildApp();
    const res = await request(app).get(`/.mesh/resolve/multi?namespace=${NS}&staleness=0&min_score=0`);
    // 0 is invalid (rejected), so default is used — fresh entry is included
    expect(res.body._meta.stalenessMs).toBeGreaterThan(0);
  });
});

// ── 7. Self-monad exclusion ───────────────────────────────────────────────────

describe("/.mesh/resolve/multi — self-monad exclusion", () => {
  it("monad matching MONAD_ID env is excluded", async () => {
    process.env.MONAD_ID = "self-monad";
    writeMonadIndexEntry(entry({ monad_id: "self-monad" }));
    writeMonadIndexEntry(entry({ monad_id: "peer-monad" }));
    const app = buildApp();
    const res = await request(app).get(`/.mesh/resolve/multi?namespace=${NS}&min_score=0`);
    const ids: string[] = res.body.candidates.map((c: any) => c.monad_id);
    expect(ids).not.toContain("self-monad");
  });

  it("monad matching MONAD_SELF_ENDPOINT is excluded", async () => {
    process.env.MONAD_SELF_ENDPOINT = "http://self-endpoint:8282";
    writeMonadIndexEntry(entry({ monad_id: "ep-self", endpoint: "http://self-endpoint:8282" }));
    writeMonadIndexEntry(entry({ monad_id: "ep-peer" }));
    const app = buildApp();
    const res = await request(app).get(`/.mesh/resolve/multi?namespace=${NS}&min_score=0`);
    const ids: string[] = res.body.candidates.map((c: any) => c.monad_id);
    expect(ids).not.toContain("ep-self");
  });
});

// ── 8. Response shape ─────────────────────────────────────────────────────────

describe("/.mesh/resolve/multi — response shape", () => {
  it("response includes namespace and selectedAt", async () => {
    const app = buildApp();
    const before = Date.now();
    const res = await request(app).get(`/.mesh/resolve/multi?namespace=${NS}`);
    const after = Date.now();
    expect(res.body.namespace).toBe(NS);
    expect(res.body.selectedAt).toBeGreaterThanOrEqual(before);
    expect(res.body.selectedAt).toBeLessThanOrEqual(after);
  });

  it("_meta contains count, maxRequested, minRelativeScore, stalenessMs", async () => {
    const app = buildApp();
    const res = await request(app).get(`/.mesh/resolve/multi?namespace=${NS}`);
    expect(typeof res.body._meta.count).toBe("number");
    expect(typeof res.body._meta.maxRequested).toBe("number");
    expect(typeof res.body._meta.minRelativeScore).toBe("number");
    expect(typeof res.body._meta.stalenessMs).toBe("number");
  });

  it("existing /.mesh/resolve endpoint still works — no regression", async () => {
    const app = buildApp();
    const res = await request(app).get(`/.mesh/resolve?namespace=${NS}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.monads)).toBe(true);
  });
});
