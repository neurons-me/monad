import fs from "fs";
import os from "os";
import path from "path";
import { resetKernelStateForTests } from "../../src/kernel/manager.js";
import { writeMonadIndexEntry, type MonadIndexEntry } from "../../src/kernel/monadIndex.js";
import { DEFAULT_STALE_MS, matchesMeshSelector, selectMeshClaimant } from "../../src/kernel/meshSelect.js";

const savedSeed = process.env.SEED;
const savedStateDir = process.env.ME_STATE_DIR;

beforeEach(() => {
  process.env.ME_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "monad-nrp-sel-"));
  process.env.SEED = "nrp-select-test-seed";
  resetKernelStateForTests();
});

afterEach(() => {
  process.env.SEED = savedSeed;
  process.env.ME_STATE_DIR = savedStateDir;
  resetKernelStateForTests();
});

const SELF = "http://localhost:8161";
const SELF_ID = "self-monad-xyz";
const NS = "suis-macbook-air.local";

function mesh(overrides: Partial<MonadIndexEntry>): MonadIndexEntry {
  return {
    monad_id: "frank-m",
    namespace: NS,
    endpoint: "http://localhost:8282",
    name: "frank",
    claimed_namespaces: [NS],
    first_seen: Date.now() - 10_000,
    last_seen: Date.now() - 1_000,
    ...overrides,
  };
}

describe("selectMeshClaimant — no claimants", () => {
  it("returns null when index is empty", async () => {
    const r = await selectMeshClaimant({ monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID });
    expect(r).toBeNull();
  });
});

describe("selectMeshClaimant — self exclusion", () => {
  it("excludes entry matching selfEndpoint", async () => {
    writeMonadIndexEntry(mesh({ monad_id: "m-other", endpoint: SELF }));
    const r = await selectMeshClaimant({ monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: "" });
    expect(r).toBeNull();
  });

  it("excludes entry matching selfEndpoint with trailing slash", async () => {
    writeMonadIndexEntry(mesh({ monad_id: "m-slash", endpoint: `${SELF}/` }));
    const r = await selectMeshClaimant({ monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: "" });
    expect(r).toBeNull();
  });

  it("excludes entry matching selfMonadId regardless of endpoint", async () => {
    writeMonadIndexEntry(mesh({ monad_id: SELF_ID, endpoint: "http://localhost:9999" }));
    const r = await selectMeshClaimant({ monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID });
    expect(r).toBeNull();
  });
});

describe("selectMeshClaimant — staleness", () => {
  it("excludes entries older than stalenessMs", async () => {
    const staleTs = Date.now() - DEFAULT_STALE_MS - 500;
    writeMonadIndexEntry(mesh({ monad_id: "stale-m", endpoint: "http://localhost:8282", last_seen: staleTs }));
    const r = await selectMeshClaimant({
      monadSelector: "",
      namespace: NS,
      selfEndpoint: SELF,
      selfMonadId: SELF_ID,
      stalenessMs: DEFAULT_STALE_MS,
    });
    expect(r).toBeNull();
  });

  it("includes entries exactly at the staleness boundary", async () => {
    const now = Date.now();
    const boundary = now - DEFAULT_STALE_MS;
    writeMonadIndexEntry(mesh({ monad_id: "boundary-m", endpoint: "http://localhost:8282", last_seen: boundary }));
    const r = await selectMeshClaimant({
      monadSelector: "",
      namespace: NS,
      selfEndpoint: SELF,
      selfMonadId: SELF_ID,
      stalenessMs: DEFAULT_STALE_MS,
      now,
    });
    expect(r).not.toBeNull();
  });
});

describe("selectMeshClaimant — selection", () => {
  it("selects a fresh non-self claimant with reason mesh-claim", async () => {
    writeMonadIndexEntry(mesh({ monad_id: "frank-m", endpoint: "http://localhost:8282" }));
    const r = await selectMeshClaimant({ monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID });
    expect(r).not.toBeNull();
    expect(r!.entry.monad_id).toBe("frank-m");
    expect(r!.reason).toBe("mesh-claim");
  });

  it("prefers most-recently-seen when multiple claimants qualify", async () => {
    const now = Date.now();
    writeMonadIndexEntry(mesh({ monad_id: "older", endpoint: "http://localhost:8282", last_seen: now - 5_000 }));
    writeMonadIndexEntry(mesh({ monad_id: "newer", endpoint: "http://localhost:8283", last_seen: now - 1_000 }));
    const r = await selectMeshClaimant({ monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID, now });
    expect(r!.entry.monad_id).toBe("newer");
  });
});

describe("selectMeshClaimant — name selector", () => {
  it("finds monad by name and returns name-selector reason", async () => {
    writeMonadIndexEntry(mesh({ monad_id: "frank-m", name: "frank", endpoint: "http://localhost:8282" }));
    const r = await selectMeshClaimant({ monadSelector: "frank", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID });
    expect(r!.reason).toBe("name-selector");
    expect(r!.entry.name).toBe("frank");
  });

  it("name selector is case-insensitive", async () => {
    writeMonadIndexEntry(mesh({ monad_id: "frank-m", name: "Frank", endpoint: "http://localhost:8282" }));
    const r = await selectMeshClaimant({ monadSelector: "FRANK", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID });
    expect(r).not.toBeNull();
  });

  it("returns null when named monad does not exist", async () => {
    const r = await selectMeshClaimant({ monadSelector: "nobody", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID });
    expect(r).toBeNull();
  });

  it("name selector bypasses namespace filter and staleness", async () => {
    const stale = Date.now() - DEFAULT_STALE_MS - 10_000;
    writeMonadIndexEntry(mesh({
      monad_id: "frank-m",
      name: "frank",
      namespace: "other.local",
      claimed_namespaces: ["other.local"],
      endpoint: "http://localhost:8282",
      last_seen: stale,
    }));
    const r = await selectMeshClaimant({
      monadSelector: "frank",
      namespace: NS,
      selfEndpoint: SELF,
      selfMonadId: SELF_ID,
      stalenessMs: DEFAULT_STALE_MS,
    });
    expect(r).not.toBeNull();
    expect(r!.reason).toBe("name-selector");
  });
});

// ── Phase 4: selector-aware matching ─────────────────────────────────────────

describe("matchesMeshSelector", () => {
  function entry(overrides: Partial<MonadIndexEntry> = {}): MonadIndexEntry {
    return {
      monad_id: "m1", namespace: NS, endpoint: "http://localhost:8282",
      tags: ["desktop", "primary", "suis-macbook-air.local"],
      type: "desktop",
      claimed_namespaces: [NS],
      first_seen: Date.now() - 5000, last_seen: Date.now() - 1000,
      ...overrides,
    };
  }

  it("null selector always matches", () => {
    expect(matchesMeshSelector(entry(), null)).toBe(true);
  });

  it("empty string selector always matches", () => {
    expect(matchesMeshSelector(entry(), "")).toBe(true);
  });

  it("matches by tag", () => {
    expect(matchesMeshSelector(entry({ tags: ["desktop", "primary"] }), "desktop")).toBe(true);
    expect(matchesMeshSelector(entry({ tags: ["mobile"], type: "mobile" }), "desktop")).toBe(false);
  });

  it("matches by type as tag", () => {
    expect(matchesMeshSelector(entry({ type: "server", tags: [] }), "server")).toBe(true);
    expect(matchesMeshSelector(entry({ type: "server", tags: [] }), "desktop")).toBe(false);
  });

  it("matches explicit tag: prefix", () => {
    expect(matchesMeshSelector(entry({ tags: ["primary"] }), "tag:primary")).toBe(true);
    expect(matchesMeshSelector(entry({ tags: [] }), "tag:primary")).toBe(false);
  });

  it("matches device: prefix against tags", () => {
    expect(matchesMeshSelector(entry({ tags: ["macbook"] }), "device:macbook")).toBe(true);
    expect(matchesMeshSelector(entry({ tags: ["iphone"] }), "device:macbook")).toBe(false);
  });

  it("matches host: prefix against namespace", () => {
    expect(matchesMeshSelector(entry({ namespace: "frank.local" }), "host:frank.local")).toBe(true);
    expect(matchesMeshSelector(entry({ namespace: "other.local" }), "host:frank.local")).toBe(false);
  });

  it("OR groups — matches if any group satisfies", () => {
    const e = entry({ tags: ["mobile"], type: "mobile" });
    // "desktop|mobile" — mobile matches second group
    expect(matchesMeshSelector(e, "desktop|mobile")).toBe(true);
  });

  it("AND within group — all clauses must match", () => {
    const e = entry({ tags: ["primary"], type: "desktop" });
    // "desktop;primary" — both must match
    expect(matchesMeshSelector(e, "desktop;primary")).toBe(true);
    // "desktop;cloud" — cloud is missing
    expect(matchesMeshSelector(e, "desktop;cloud")).toBe(false);
  });

  it("multi-value clause — any value matches", () => {
    const e = entry({ tags: ["iphone"] });
    expect(matchesMeshSelector(e, "device:macbook,iphone")).toBe(true);
  });
});

describe("selectMeshClaimant — selectorConstraint", () => {
  it("only returns claimants matching the selector", async () => {
    writeMonadIndexEntry(mesh({ monad_id: "desktop-m", tags: ["desktop"], type: "desktop", endpoint: "http://localhost:8282" }));
    writeMonadIndexEntry(mesh({ monad_id: "mobile-m", tags: ["mobile"], type: "mobile", endpoint: "http://localhost:8283" }));

    const r = await selectMeshClaimant({
      monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID,
      selectorConstraint: "mobile",
    });
    expect(r).not.toBeNull();
    expect(r!.entry.monad_id).toBe("mobile-m");
  });

  it("returns null when no claimant satisfies the selector", async () => {
    writeMonadIndexEntry(mesh({ monad_id: "desktop-m", tags: ["desktop"], type: "desktop", endpoint: "http://localhost:8282" }));

    const r = await selectMeshClaimant({
      monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID,
      selectorConstraint: "mobile",
    });
    expect(r).toBeNull();
  });

  it("null selectorConstraint does not filter by tags", async () => {
    writeMonadIndexEntry(mesh({ monad_id: "any-m", tags: ["whatever"], endpoint: "http://localhost:8282" }));
    const r = await selectMeshClaimant({
      monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID,
      selectorConstraint: null,
    });
    expect(r).not.toBeNull();
  });
});
