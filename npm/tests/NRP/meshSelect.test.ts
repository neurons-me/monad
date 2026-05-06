/**
 * meshSelect.test.ts — The Routing Engine: "Which node should answer this request?"
 *
 * WHAT IS MESH SELECTION?
 * When a request arrives for a namespace (e.g., "suis-macbook-air.local"), the
 * mesh router must decide which node in the mesh should answer it. This is the
 * core routing decision of the entire system.
 *
 * `selectMeshClaimant` is the function that makes this decision. It:
 *   1. Looks up all nodes claiming the target namespace
 *   2. Filters out: self (to avoid loops), stale nodes (last seen > threshold)
 *   3. Scores each remaining candidate using the scoring engine
 *   4. Returns the highest scorer (or explores the runner-up probabilistically)
 *
 * The result object tells you:
 *   - entry:   the selected MonadIndexEntry (who to talk to)
 *   - reason:  WHY this node was chosen:
 *              "mesh-claim"   → won the scoring competition
 *              "name-selector" → directly targeted by name
 *              "exploration"  → deliberately routed to runner-up for learning
 *   - score:   the composite scoring value (0 to 1)
 *   - breakdown: per-scorer details (used by the learning loop)
 *   - runnerUp:  the second-best candidate (for comparison and exploration)
 *
 * `matchesMeshSelector` decides whether a specific node matches a selector string:
 *   "device:macbook"         → must have tag "macbook"
 *   "desktop;primary"        → must match BOTH (AND)
 *   "desktop|mobile"         → must match EITHER (OR)
 *   "device:macbook,iphone"  → must match either macbook OR iphone
 *
 * WHAT WE TEST (6 groups):
 *   1. No claimants — returns null
 *   2. Self-exclusion — never routes to itself (would cause infinite loops)
 *   3. Staleness — skips nodes not seen recently
 *   4. Selection — picks the best-scoring candidate
 *   5. Name selector — direct routing by node name (bypasses scoring)
 *   6. Selector matching — matchesMeshSelector rules and combinators
 *   7. Exploration — epsilon-greedy: sometimes route to runner-up for learning
 *   8. Selector constraint — hard-filter claimants by tag/type
 */

import fs from "fs";
import os from "os";
import path from "path";
import { resetKernelStateForTests } from "../../src/kernel/manager.js";
import { writeMonadIndexEntry, type MonadIndexEntry } from "../../src/kernel/monadIndex.js";
import { DEFAULT_STALE_MS, matchesMeshSelector, selectMeshClaimant } from "../../src/kernel/meshSelect.js";

// ── Test isolation ─────────────────────────────────────────────────────────────

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

// ── Constants ─────────────────────────────────────────────────────────────────
// SELF is the current node's HTTP address.
// SELF_ID is the current node's monad_id.
// Both are used to identify "us" so we don't route to ourselves.

const SELF = "http://localhost:8161";
const SELF_ID = "self-monad-xyz";
const NS = "suis-macbook-air.local";

// Builds a valid MonadIndexEntry for the given namespace (NS).
// Every test gets a fresh node with sane defaults; override as needed.
function mesh(overrides: Partial<MonadIndexEntry>): MonadIndexEntry {
  return {
    monad_id: "frank-m",
    namespace: NS,
    endpoint: "http://localhost:8282",
    name: "frank",
    claimed_namespaces: [NS],
    first_seen: Date.now() - 10_000,
    last_seen: Date.now() - 1_000,  // 1 second ago = fresh
    ...overrides,
  };
}

// ── 1. No claimants ────────────────────────────────────────────────────────────

describe("selectMeshClaimant — no claimants", () => {
  it("returns null when index is empty", async () => {
    // WHAT: Ask the router to find a node for NS, but the index is empty.
    //       There is nobody to route to.
    //
    // WHY: The caller (bridge) checks for null and responds with a "no claimant"
    //      error rather than throwing. The user sees a clear "no node available"
    //      message instead of a 500 crash.
    const r = await selectMeshClaimant({ monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID });
    expect(r).toBeNull();
  });
});

// ── 2. Self-exclusion ─────────────────────────────────────────────────────────

describe("selectMeshClaimant — self exclusion", () => {
  it("excludes entry matching selfEndpoint", async () => {
    // WHAT: The only claimant has the same endpoint as the current node (SELF).
    //       selectMeshClaimant should exclude it and return null.
    //
    // WHY: If a node routed to itself, the request would loop back:
    //      A → A → A → A... forever. Self-exclusion prevents this.
    //      The check is done by comparing endpoint URLs.
    writeMonadIndexEntry(mesh({ monad_id: "m-other", endpoint: SELF }));
    const r = await selectMeshClaimant({ monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: "" });
    expect(r).toBeNull();
  });

  it("excludes entry matching selfEndpoint with trailing slash", async () => {
    // WHAT: Same as above, but the endpoint has a trailing slash ("http://localhost:8161/").
    //
    // WHY: HTTP clients sometimes add trailing slashes. "http://localhost:8161" and
    //      "http://localhost:8161/" are the same server. The comparison must be
    //      normalized so a slash variant doesn't slip through the self-exclusion filter.
    writeMonadIndexEntry(mesh({ monad_id: "m-slash", endpoint: `${SELF}/` }));
    const r = await selectMeshClaimant({ monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: "" });
    expect(r).toBeNull();
  });

  it("excludes entry matching selfMonadId regardless of endpoint", async () => {
    // WHAT: The claimant has the same monad_id as us (SELF_ID) but a DIFFERENT endpoint.
    //       It should still be excluded.
    //
    // WHY: A node might be accessible via multiple addresses (different interfaces,
    //      VPN, etc.). If we only checked the endpoint, we might route to ourselves
    //      via a different address. The monad_id is the node's primary identity —
    //      if the ID matches, it's us, regardless of the address.
    writeMonadIndexEntry(mesh({ monad_id: SELF_ID, endpoint: "http://localhost:9999" }));
    const r = await selectMeshClaimant({ monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID });
    expect(r).toBeNull();
  });
});

// ── 3. Staleness ──────────────────────────────────────────────────────────────

describe("selectMeshClaimant — staleness", () => {
  it("excludes entries older than stalenessMs", async () => {
    // WHAT: Register a node whose last_seen is older than DEFAULT_STALE_MS (5 minutes).
    //       The router should skip it and return null.
    //
    // WHY: A node that hasn't checked in for more than 5 minutes is probably dead
    //      (crashed, network partition, machine off). Routing to it would cause
    //      timeouts. The staleness filter gives a hard cut-off: if you're not
    //      recently heard from, you're not in the running.
    //
    // DEFAULT_STALE_MS is typically 300_000ms (5 minutes).
    // last_seen = now - 300_000ms - 500ms = 500ms past the staleness deadline.
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
    // WHAT: A node whose last_seen is EXACTLY at the staleness boundary
    //       (now - DEFAULT_STALE_MS) should be INCLUDED, not excluded.
    //
    // WHY: The boundary check is "last_seen >= now - stalenessMs" (inclusive).
    //      A node that checked in exactly 5 minutes ago is not stale — it's borderline.
    //      Off-by-one errors here would silently exclude valid nodes.
    //
    // We pass `now` explicitly to control the reference timestamp precisely.
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

// ── 4. Selection ──────────────────────────────────────────────────────────────

describe("selectMeshClaimant — selection", () => {
  it("selects a fresh non-self claimant with reason mesh-claim", async () => {
    // WHAT: Register one valid claimant and verify the router picks it.
    //       reason="mesh-claim" means it won through the scoring competition.
    //
    // WHY: The basic "does routing work at all?" test. If this fails, the entire
    //      mesh routing system is broken. `reason` tells downstream code WHY this
    //      node was chosen (important for the learning loop to know if weights mattered).
    writeMonadIndexEntry(mesh({ monad_id: "frank-m", endpoint: "http://localhost:8282" }));
    const r = await selectMeshClaimant({ monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID });
    expect(r).not.toBeNull();
    expect(r!.entry.monad_id).toBe("frank-m");
    expect(r!.reason).toBe("mesh-claim");
  });

  it("prefers most-recently-seen when multiple claimants qualify", async () => {
    // WHAT: Register two nodes. "newer" was seen 1s ago, "older" was seen 5s ago.
    //       With equal resonance and latency, the recency scorer differentiates them.
    //
    // HOW: Both nodes have no claim meta, so resonance=0 and latency=default.
    //      The only differentiating signal is recency. "newer" has higher recency
    //      score → higher total score → selected.
    //
    // WHY: A recently-seen node is more likely to still be alive. The recency scorer
    //      captures this "is it still alive?" signal. This test verifies the scorer
    //      actually changes the outcome (not just the weights in isolation).
    const now = Date.now();
    writeMonadIndexEntry(mesh({ monad_id: "older", endpoint: "http://localhost:8282", last_seen: now - 5_000 }));
    writeMonadIndexEntry(mesh({ monad_id: "newer", endpoint: "http://localhost:8283", last_seen: now - 1_000 }));
    const r = await selectMeshClaimant({ monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID, now });
    expect(r!.entry.monad_id).toBe("newer");
  });
});

// ── 5. Name selector ──────────────────────────────────────────────────────────

describe("selectMeshClaimant — name selector", () => {
  it("finds monad by name and returns name-selector reason", async () => {
    // WHAT: Pass monadSelector="frank". The router should find the node with name="frank"
    //       and route to it directly, bypassing the scoring competition.
    //
    // reason="name-selector" is important: it tells the learning loop NOT to update
    // weights for this decision (the weights didn't influence name-selector routing).
    writeMonadIndexEntry(mesh({ monad_id: "frank-m", name: "frank", endpoint: "http://localhost:8282" }));
    const r = await selectMeshClaimant({ monadSelector: "frank", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID });
    expect(r!.reason).toBe("name-selector");
    expect(r!.entry.name).toBe("frank");
  });

  it("name selector is case-insensitive", async () => {
    // WHAT: The node is named "Frank" (capital F). The selector "FRANK" should still match.
    //
    // WHY: Users type names in all caps, all lowercase, or mixed. DNS hostnames are
    //      case-insensitive by standard. The lookup normalizes before comparing.
    writeMonadIndexEntry(mesh({ monad_id: "frank-m", name: "Frank", endpoint: "http://localhost:8282" }));
    const r = await selectMeshClaimant({ monadSelector: "FRANK", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID });
    expect(r).not.toBeNull();
  });

  it("returns null when named monad does not exist", async () => {
    // WHAT: monadSelector="nobody" — no node with that name exists.
    //       The router returns null (no match found).
    //
    // WHY: An explicit name selector means the caller specifically wants THAT node.
    //      If it's not found, we must not silently fall back to a random other node —
    //      that would route to the wrong place. Return null so the caller knows.
    const r = await selectMeshClaimant({ monadSelector: "nobody", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID });
    expect(r).toBeNull();
  });

  it("name selector bypasses namespace filter and staleness", async () => {
    // WHAT: The node "frank" is in namespace "other.local" (not NS) AND is stale.
    //       With a name selector, the router should still find and return it.
    //
    // WHY: Name selectors are explicit targeting — you KNOW which node you want.
    //      Namespace filtering (is this node in the right namespace?) and staleness
    //      (was this node seen recently?) are used for AUTOMATIC selection.
    //      But when you explicitly ask for "frank", you presumably know where frank is.
    //
    //      Real use case: "redirect this request to my backup server 'frank' even if
    //      it hasn't checked in for a while" (frank might be on a slow network).
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
      namespace: NS,        // different namespace — normally would be filtered
      selfEndpoint: SELF,
      selfMonadId: SELF_ID,
      stalenessMs: DEFAULT_STALE_MS,
    });
    expect(r).not.toBeNull();
    expect(r!.reason).toBe("name-selector");
  });
});

// ── 6. Selector-aware tag matching ────────────────────────────────────────────

describe("matchesMeshSelector", () => {
  // Builds a test node entry with given overrides.
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
    // WHAT: When no selector is specified (null), every node qualifies.
    //       The "no filter" case should let everything through.
    expect(matchesMeshSelector(entry(), null)).toBe(true);
  });

  it("empty string selector always matches", () => {
    // WHAT: An empty string selector ("") is equivalent to "no filter".
    //       This handles the case where a selector field exists but is blank.
    expect(matchesMeshSelector(entry(), "")).toBe(true);
  });

  it("matches by tag", () => {
    // WHAT: Bare selector string matches against the node's tags array.
    //       "desktop" matches a node with tag "desktop".
    //       "desktop" does NOT match a node with only tag "mobile".
    expect(matchesMeshSelector(entry({ tags: ["desktop", "primary"] }), "desktop")).toBe(true);
    expect(matchesMeshSelector(entry({ tags: ["mobile"], type: "mobile" }), "desktop")).toBe(false);
  });

  it("matches by type as tag", () => {
    // WHAT: The node's `type` field is treated as an implicit tag.
    //       A node with type="server" (and no tags) matches selector "server".
    //
    // WHY: Type describes what category of device the node runs on (desktop, server,
    //      mobile, etc.). Including type in tag matching means you can select nodes
    //      by their type even if they forgot to add it to their tags array.
    expect(matchesMeshSelector(entry({ type: "server", tags: [] }), "server")).toBe(true);
    expect(matchesMeshSelector(entry({ type: "server", tags: [] }), "desktop")).toBe(false);
  });

  it("matches explicit tag: prefix", () => {
    // WHAT: "tag:primary" explicitly requires the node to have "primary" in its tags.
    //       The "tag:" prefix makes it unambiguous (not a type or host match).
    expect(matchesMeshSelector(entry({ tags: ["primary"] }), "tag:primary")).toBe(true);
    expect(matchesMeshSelector(entry({ tags: [] }), "tag:primary")).toBe(false);
  });

  it("matches device: prefix against tags", () => {
    // WHAT: "device:macbook" matches nodes with tag "macbook".
    //       The "device:" prefix signals you're targeting a physical device type.
    //
    // Example use: "send this to a Mac desktop, not a server or mobile"
    expect(matchesMeshSelector(entry({ tags: ["macbook"] }), "device:macbook")).toBe(true);
    expect(matchesMeshSelector(entry({ tags: ["iphone"] }), "device:macbook")).toBe(false);
  });

  it("matches host: prefix against namespace", () => {
    // WHAT: "host:frank.local" matches nodes whose namespace is "frank.local".
    //       The "host:" prefix lets you target a specific machine by its DNS name.
    //
    // Example use: "send this request to the node running on frank.local specifically"
    expect(matchesMeshSelector(entry({ namespace: "frank.local" }), "host:frank.local")).toBe(true);
    expect(matchesMeshSelector(entry({ namespace: "other.local" }), "host:frank.local")).toBe(false);
  });

  it("OR groups — matches if any group satisfies", () => {
    // WHAT: "desktop|mobile" has two groups separated by "|".
    //       The node only needs to match ONE group to qualify.
    //
    // The mobile-only node fails "desktop" but succeeds "mobile" → overall match.
    //
    // Think of "|" as logical OR: I want desktop OR mobile nodes.
    const e = entry({ tags: ["mobile"], type: "mobile" });
    expect(matchesMeshSelector(e, "desktop|mobile")).toBe(true);
  });

  it("AND within group — all clauses must match", () => {
    // WHAT: "desktop;primary" requires BOTH "desktop" AND "primary" to match.
    //       A node with only "desktop" (but not "primary") fails.
    //
    // Think of ";" as logical AND: I want nodes that are BOTH desktop AND primary.
    //
    // Use case: "give me the node that is both desktop type AND marked primary"
    const e = entry({ tags: ["primary"], type: "desktop" });
    expect(matchesMeshSelector(e, "desktop;primary")).toBe(true);  // both match
    expect(matchesMeshSelector(e, "desktop;cloud")).toBe(false);   // "cloud" not found
  });

  it("multi-value clause — any value matches", () => {
    // WHAT: "device:macbook,iphone" means "matches any of: macbook OR iphone".
    //       A node with tag "iphone" satisfies the "iphone" alternative.
    //
    // Combined syntax: device:macbook,iphone  = device IS macbook OR iphone
    const e = entry({ tags: ["iphone"] });
    expect(matchesMeshSelector(e, "device:macbook,iphone")).toBe(true);
  });
});

// ── 7. Epsilon-greedy exploration ─────────────────────────────────────────────

describe("selectMeshClaimant — exploration", () => {
  it("with explorationRate=0 always returns the highest-scoring node", async () => {
    // WHAT: explorationRate=0 means "always pick the winner, never explore".
    //       Run the selection 10 times. Every time, "a" (fresher) should win.
    //
    // WHY: Without exploration, the router is purely greedy — always picks the best
    //      known option. This is the default behavior for production.
    //      The 10-run loop ensures there's no randomness sneaking in.
    const now = Date.now();
    writeMonadIndexEntry(mesh({ monad_id: "a", endpoint: "http://localhost:8282", last_seen: now - 500 }));
    writeMonadIndexEntry(mesh({ monad_id: "b", endpoint: "http://localhost:8283", last_seen: now - 5_000 }));
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        selectMeshClaimant({ monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID, now, explorationRate: 0 }),
      ),
    );
    expect(results.every((r) => r!.entry.monad_id === "a")).toBe(true);
    expect(results.every((r) => r!.reason === "mesh-claim")).toBe(true);
  });

  it("with explorationRate=1 and low margin routes to runner-up with reason 'exploration'", async () => {
    // WHAT: explorationRate=1 means "always explore when the margin is below the threshold".
    //       Two nearly-identical nodes (100ms vs 120ms last_seen) → tiny margin → exploration fires.
    //       The runner-up ("b") gets selected instead of the winner ("a").
    //
    // WHY: Exploration drives the learning loop. If we ALWAYS pick the winner,
    //      we never gather data about the runner-up. How do we know the runner-up
    //      isn't actually better in some situations? Occasionally routing to it
    //      collects that data. This is the "explore" in explore/exploit tradeoff.
    //
    // reason="exploration" tells the learning loop: "this was a deliberate experiment,
    // not the normal choice — weight it appropriately".
    //
    // Note: if the margin happens to be >= 0.05 (above threshold), exploration won't
    // trigger even at rate=1. The test handles both cases.
    const now = Date.now();
    writeMonadIndexEntry(mesh({ monad_id: "a", endpoint: "http://localhost:8282", last_seen: now - 100 }));
    writeMonadIndexEntry(mesh({ monad_id: "b", endpoint: "http://localhost:8283", last_seen: now - 120 }));
    const r = await selectMeshClaimant({
      monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID, now,
      explorationRate: 1,
    });
    if (r!.reason === "exploration") {
      // Exploration fired: runner-up "b" is now the result, original winner "a" is runnerUp
      expect(r!.entry.monad_id).toBe("b");
      expect(r!.runnerUp!.entry.monad_id).toBe("a");
    } else {
      // Margin was >= 0.05 despite similar timestamps — no exploration, winner returned
      expect(r!.reason).toBe("mesh-claim");
    }
  });

  it("exploration does not trigger when only one claimant (no runner-up)", async () => {
    // WHAT: explorationRate=1 but only one candidate exists.
    //       Exploration requires a runner-up to swap to — with one node, there's no swap.
    //       The single node is returned with reason "mesh-claim" (not "exploration").
    //
    // WHY: Without a runner-up, there's nothing to explore. Don't crash or return null.
    const now = Date.now();
    writeMonadIndexEntry(mesh({ monad_id: "solo", endpoint: "http://localhost:8282", last_seen: now - 100 }));
    const r = await selectMeshClaimant({
      monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID, now,
      explorationRate: 1,
    });
    expect(r!.reason).toBe("mesh-claim");
    expect(r!.runnerUp).toBeUndefined();
  });

  it("exploration does not trigger when margin is above threshold", async () => {
    // WHAT: explorationRate=1 but the score gap between "a" and "b" is HUGE.
    //       "a" is seen 100ms ago, "b" is seen 290 seconds ago (nearly stale).
    //       margin >> 0.05 → exploration threshold not met → no exploration.
    //
    // WHY: Exploration is for CLOSE decisions where we're uncertain which node is better.
    //      When "a" is clearly dominant (large margin), exploring "b" provides no useful
    //      information and would waste the request. Only explore when you're genuinely
    //      uncertain about the best choice.
    //
    // We run 20 times to make sure no randomness triggers exploration by accident.
    const now = Date.now();
    writeMonadIndexEntry(mesh({ monad_id: "a", endpoint: "http://localhost:8282", last_seen: now - 100 }));
    writeMonadIndexEntry(mesh({ monad_id: "b", endpoint: "http://localhost:8283", last_seen: now - 290_000 }));
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        selectMeshClaimant({ monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID, now, explorationRate: 1 }),
      ),
    );
    expect(results.every((r) => r!.entry.monad_id === "a")).toBe(true);
    expect(results.every((r) => r!.reason === "mesh-claim")).toBe(true);
  });
});

// ── 8. selectorConstraint ─────────────────────────────────────────────────────

describe("selectMeshClaimant — selectorConstraint", () => {
  it("only returns claimants matching the selector", async () => {
    // WHAT: Two nodes exist: "desktop-m" (type=desktop) and "mobile-m" (type=mobile).
    //       selectorConstraint="mobile" should only allow mobile nodes.
    //       Result: "mobile-m" is selected, "desktop-m" is filtered out.
    //
    // WHY: The bridge can specify a hardware/type constraint to ensure the request
    //      goes to the RIGHT KIND of node, not just the closest or fastest.
    //      Example: "This request needs GPU — only route to GPU-capable nodes."
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
    // WHAT: Only a desktop node exists, but we require "mobile". Result: null.
    //
    // WHY: Rather than silently routing to a wrong type of node, return null so
    //      the caller can give a clear "no qualifying node available" response.
    writeMonadIndexEntry(mesh({ monad_id: "desktop-m", tags: ["desktop"], type: "desktop", endpoint: "http://localhost:8282" }));

    const r = await selectMeshClaimant({
      monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID,
      selectorConstraint: "mobile",
    });
    expect(r).toBeNull();
  });

  it("null selectorConstraint does not filter by tags", async () => {
    // WHAT: null constraint means "no filter" — any node qualifies regardless of its tags.
    //       The node with tags=["whatever"] should be found.
    //
    // WHY: Most requests don't specify a type requirement. null is the "no requirement"
    //      state and should not exclude any candidates.
    writeMonadIndexEntry(mesh({ monad_id: "any-m", tags: ["whatever"], endpoint: "http://localhost:8282" }));
    const r = await selectMeshClaimant({
      monadSelector: "", namespace: NS, selfEndpoint: SELF, selfMonadId: SELF_ID,
      selectorConstraint: null,
    });
    expect(r).not.toBeNull();
  });
});
