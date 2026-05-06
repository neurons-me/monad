/**
 * monadIndex.test.ts — The Mesh Node Registry
 *
 * WHAT IS THE MONAD INDEX?
 * When a monad (a running instance of monad.ai) joins the mesh, it registers
 * itself in the index. Think of it as a phone book for all nodes in the mesh:
 *
 *   monad_id:   unique ID for this node ("frank-m")
 *   namespace:  the identity domain this node serves ("suis-macbook-air.local")
 *   endpoint:   the HTTP address to reach this node ("http://localhost:8282")
 *   name:       optional human-readable name ("frank")
 *   last_seen:  timestamp of last heartbeat — used to detect stale nodes
 *   claimed_namespaces: all namespaces this node has announced it can serve
 *
 * The routing engine reads this index to decide WHERE to forward a request.
 * If a node goes offline (old last_seen), the router skips it.
 *
 * WHAT WE TEST:
 *   1. write/read/overwrite — basic CRUD
 *   2. listMonadIndex ordering — newest first, alphabetical tiebreaker
 *   3. findMonadsForNamespace — lookup by namespace (primary or claimed)
 *   4. findMonadByName — lookup by human name or monad_id
 *   5. announceClaimedNamespaces — merging new namespaces into an existing entry
 */

import fs from "fs";
import os from "os";
import path from "path";
import { resetKernelStateForTests } from "../../src/kernel/manager.js";
import {
  announceClaimedNamespaces,
  findMonadByName,
  findMonadsForNamespace,
  listMonadIndex,
  readMonadIndexEntry,
  writeMonadIndexEntry,
  type MonadIndexEntry,
} from "../../src/kernel/monadIndex.js";

// ── Test isolation ─────────────────────────────────────────────────────────────
// Each test gets a fresh temporary directory and a fresh kernel state.
// Without this, writes from one test would pollute the next test.

const savedSeed = process.env.SEED;
const savedStateDir = process.env.ME_STATE_DIR;

beforeEach(() => {
  // Create a brand-new temp directory for each test — kernel stores to disk
  process.env.ME_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "monad-nrp-idx-"));
  process.env.SEED = "nrp-index-test-seed";
  resetKernelStateForTests(); // flush in-memory cache so no leftover state
});

afterEach(() => {
  process.env.SEED = savedSeed;
  process.env.ME_STATE_DIR = savedStateDir;
  resetKernelStateForTests();
});

// ── Fixture factory ────────────────────────────────────────────────────────────
// `makeEntry` builds a valid MonadIndexEntry with sensible defaults.
// Tests override only the fields they care about, keeping test code concise.

function makeEntry(overrides: Partial<MonadIndexEntry> = {}): MonadIndexEntry {
  return {
    monad_id: "test-m1",
    namespace: "suis-macbook-air.local",
    endpoint: "http://localhost:8161",
    name: "primary",
    claimed_namespaces: ["suis-macbook-air.local"],
    first_seen: Date.now() - 1000,
    last_seen: Date.now(),
    ...overrides,
  };
}

// ── 1. write / read ────────────────────────────────────────────────────────────

describe("write / read", () => {
  it("roundtrips an entry", () => {
    // WHAT: Write a node entry to the index, then read it back.
    // WHY: This is the most fundamental operation — if you can't store and retrieve,
    //      nothing else works. We check that the data survives the round-trip intact.
    writeMonadIndexEntry(makeEntry());
    const r = readMonadIndexEntry("test-m1");
    expect(r).toBeDefined();
    expect(r!.namespace).toBe("suis-macbook-air.local");
    expect(r!.name).toBe("primary");
  });

  it("returns undefined for unknown id", () => {
    // WHAT: Try to read a monad_id that was never written.
    // WHY: The router calls readMonadIndexEntry before forwarding. If the monad
    //      doesn't exist, it should get undefined (not crash) so it can route elsewhere.
    expect(readMonadIndexEntry("ghost")).toBeUndefined();
  });

  it("overwrites with the latest write", () => {
    // WHAT: Write the same monad_id twice with different data; only the second survives.
    // WHY: Nodes heartbeat by re-writing their entry (updating last_seen, etc.).
    //      The index stores exactly one entry per monad_id — the most recent.
    //      If we kept both, the index would grow without bound.
    writeMonadIndexEntry(makeEntry({ name: "v1" }));
    writeMonadIndexEntry(makeEntry({ name: "v2" }));
    expect(readMonadIndexEntry("test-m1")!.name).toBe("v2");
  });
});

// ── 2. listMonadIndex ordering ─────────────────────────────────────────────────

describe("listMonadIndex ordering", () => {
  it("sorts by last_seen descending", () => {
    // WHAT: Register three nodes with different last_seen timestamps.
    //       The list should come back newest-first.
    //
    // WHY: The routing engine needs to quickly identify the most active nodes.
    //      A freshly-seen node is more likely to be alive than one seen 5 minutes ago.
    //      Newest-first means the top of the list has the best candidates.
    //
    //   now-0ms = "c"  → should be index [0] (most recent)
    //   now-1s  = "b"  → should be index [1]
    //   now-3s  = "a"  → should be index [2] (oldest)
    const now = Date.now();
    writeMonadIndexEntry(makeEntry({ monad_id: "a", last_seen: now - 3000 }));
    writeMonadIndexEntry(makeEntry({ monad_id: "b", last_seen: now - 1000 }));
    writeMonadIndexEntry(makeEntry({ monad_id: "c", last_seen: now }));
    const ids = listMonadIndex().map((e) => e.monad_id);
    expect(ids).toEqual(["c", "b", "a"]);
  });

  it("uses name as alphabetical tie-breaker when last_seen is equal", () => {
    // WHAT: Three nodes with IDENTICAL last_seen timestamps.
    //       When times are equal, sort by name A→Z so the list is deterministic.
    //
    // WHY: Without a tie-breaker, the order would be random (depends on hash map
    //      iteration order). Random order makes tests flaky and makes the UI jump
    //      around on refresh. Alphabetical gives a stable, predictable order.
    const ts = Date.now();
    writeMonadIndexEntry(makeEntry({ monad_id: "z-m", name: "zach", last_seen: ts }));
    writeMonadIndexEntry(makeEntry({ monad_id: "a-m", name: "alice", last_seen: ts }));
    writeMonadIndexEntry(makeEntry({ monad_id: "m-m", name: "marco", last_seen: ts }));
    const names = listMonadIndex().map((e) => e.name);
    expect(names).toEqual(["alice", "marco", "zach"]);
  });
});

// ── 3. findMonadsForNamespace ──────────────────────────────────────────────────

describe("findMonadsForNamespace", () => {
  it("matches by primary namespace", () => {
    // WHAT: A node whose primary namespace is "frank.local" should be found
    //       when searching for "frank.local".
    //
    // WHY: Every node has a primary namespace (its "home"). When a request comes in
    //      for "frank.local", we need to find who can serve it.
    writeMonadIndexEntry(makeEntry({ monad_id: "n1", namespace: "frank.local", claimed_namespaces: ["frank.local"] }));
    const found = findMonadsForNamespace("frank.local");
    expect(found).toHaveLength(1);
    expect(found[0]!.monad_id).toBe("n1");
  });

  it("matches by claimed_namespaces", () => {
    // WHAT: A node can claim to serve MULTIPLE namespaces beyond its primary one.
    //       "multi" has primary "primary.local" but also claims "laptop.home" and "alias.local".
    //       Searching any of those three should find this node.
    //
    // WHY: A single powerful machine might host several virtual identities. For example,
    //      my desktop might serve "suis.local", "dev.local", and "backup.local" all at once.
    //      All three should route to it.
    writeMonadIndexEntry(makeEntry({
      monad_id: "multi",
      namespace: "primary.local",
      claimed_namespaces: ["primary.local", "laptop.home", "alias.local"],
    }));
    expect(findMonadsForNamespace("laptop.home")).toHaveLength(1);
    expect(findMonadsForNamespace("alias.local")).toHaveLength(1);
    expect(findMonadsForNamespace("unknown.local")).toHaveLength(0); // nobody claims this
  });

  it("is case-insensitive", () => {
    // WHAT: Namespace lookups must work regardless of letter case.
    //       "Frank.Local", "frank.local", and "FRANK.LOCAL" all refer to the same node.
    //
    // WHY: DNS hostnames are inherently case-insensitive. Users might type them in any
    //      case, and HTTP Host headers don't guarantee case. The index normalizes internally.
    writeMonadIndexEntry(makeEntry({ namespace: "Frank.Local", claimed_namespaces: ["Frank.Local"] }));
    expect(findMonadsForNamespace("frank.local")).toHaveLength(1);
    expect(findMonadsForNamespace("FRANK.LOCAL")).toHaveLength(1);
  });

  it("returns empty for unknown namespace", () => {
    // WHAT: A namespace with no registered claimants returns an empty array.
    // WHY: The router will see [] and know to return a 404 / "no claimant" response
    //      rather than crashing or throwing an error.
    expect(findMonadsForNamespace("nobody.local")).toHaveLength(0);
  });
});

// ── 4. findMonadByName ─────────────────────────────────────────────────────────

describe("findMonadByName", () => {
  it("finds by name (case-insensitive)", () => {
    // WHAT: Look up a node by its human-readable name "frank" in three different cases.
    //
    // WHY: The name-selector feature lets you route explicitly to a named node:
    //   "me://frank:read/profile" → send to the node named "frank"
    //
    // Users might capitalize names differently, so the lookup must be case-insensitive.
    // All three ("frank", "FRANK", "Frank") should find monad_id "frank-m".
    writeMonadIndexEntry(makeEntry({ monad_id: "frank-m", name: "frank" }));
    expect(findMonadByName("frank")?.monad_id).toBe("frank-m");
    expect(findMonadByName("FRANK")?.monad_id).toBe("frank-m");
    expect(findMonadByName("Frank")?.monad_id).toBe("frank-m");
  });

  it("finds by monad_id exact match", () => {
    // WHAT: When the query exactly matches a monad_id, find it even if the node has no name.
    //
    // WHY: monad_id values are generated (like "exact-id-123"), not user-facing.
    //      But internal tools and debug commands might look up a node by its raw ID.
    //      The function checks both the name AND the ID field.
    writeMonadIndexEntry(makeEntry({ monad_id: "exact-id-123" }));
    expect(findMonadByName("exact-id-123")?.monad_id).toBe("exact-id-123");
  });

  it("returns undefined when not found", () => {
    // WHAT: Searching for a name that doesn't exist returns undefined (not an error).
    // WHY: The bridge uses this function before forwarding. If the named monad doesn't
    //      exist, it should get undefined and return a "not found" response cleanly.
    expect(findMonadByName("ghost")).toBeUndefined();
  });
});

// ── 5. announceClaimedNamespaces ───────────────────────────────────────────────

describe("announceClaimedNamespaces", () => {
  it("merges new namespaces without duplicates", () => {
    // WHAT: A node that already claims "alpha.local" announces it also claims "beta.local".
    //       After the merge, the entry should have BOTH — and "alpha.local" must appear exactly once.
    //
    // WHY: Nodes announce claimed namespaces as they start up or add new capabilities.
    //      The announcement is additive (don't drop existing claims), but also idempotent
    //      (announcing the same namespace twice doesn't duplicate it in the list).
    //
    // Before: claimed_namespaces = ["alpha.local"]
    // Announce: ["alpha.local", "beta.local"]
    // After:  claimed_namespaces = ["alpha.local", "beta.local"]  (no duplicate "alpha")
    writeMonadIndexEntry(makeEntry({ monad_id: "m1", claimed_namespaces: ["alpha.local"] }));
    announceClaimedNamespaces("m1", ["alpha.local", "beta.local"]);
    const r = readMonadIndexEntry("m1");
    expect(r!.claimed_namespaces).toContain("alpha.local");
    expect(r!.claimed_namespaces).toContain("beta.local");
    expect(r!.claimed_namespaces!.filter((n) => n === "alpha.local")).toHaveLength(1);
  });

  it("is a no-op for unknown monad_id", () => {
    // WHAT: Announcing namespaces for a monad_id that doesn't exist must not throw.
    //
    // WHY: Race condition safety. When a node starts, it might announce namespaces
    //      before its index entry is fully written. The announcement should silently
    //      do nothing rather than crashing the server.
    expect(() => announceClaimedNamespaces("ghost", ["x.local"])).not.toThrow();
  });
});
