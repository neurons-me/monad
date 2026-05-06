/**
 * replayCanonicalization.test.ts — Normalizing Writes into Replayable Memory
 *
 * WHAT IS CANONICAL REPLAY?
 * monad.ai stores user state as a log of "memories" — semantic entries that can
 * be replayed in order to reconstruct the current state from scratch.
 *
 * But writes can arrive in different formats:
 *   - Raw API write: { operation: "write", expression: "profile.name", value: "Ana" }
 *   - Semantic seed: { path: "profile.name", operator: "=", value: "Seed User" }
 *
 * The replay system normalizes ALL writes into a canonical memory format:
 *   { path, operator, expression, value }
 *
 * This canonical format is what gets stored and replayed on startup.
 *
 * `recordMemory(params)` normalizes and stores a raw write payload.
 * `getMemoriesForNamespace(ns)` returns all canonical memories for a namespace.
 * `seedClaimNamespaceSemantics` writes semantic seeds (a batch of canonical writes).
 *
 * WHAT WE TEST (2 cases):
 *   1. Raw API write is canonicalized into a replayable memory entry
 *   2. Semantic seeds are also accessible through the replay surface
 */

import crypto from "crypto";
import { claimNamespace } from "../src/claim/records";
import { getMemoriesForNamespace, recordMemory } from "../src/claim/replay";
import { seedClaimNamespaceSemantics } from "../src/claim/claimSemantics";

// Generate a unique namespace for each test to prevent state collisions
function uniqueNamespace() {
  return `replay-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.cleaker.me`;
}

describe("canonical replay memories", () => {
  it("normalizes generic write payloads into replayable .me memories", async () => {
    // WHAT: A raw API write arrives for a namespace:
    //   { operation: "write", expression: "profile.name", value: "Ana" }
    //
    // `recordMemory` must:
    //   1. Validate the namespace exists (it must be claimed first)
    //   2. Normalize the raw payload into a canonical memory entry
    //   3. Store it so getMemoriesForNamespace returns it
    //
    // The canonical form should contain:
    //   path:       "profile.name"  (the semantic key)
    //   operator:   null            (raw writes don't always have an operator)
    //   expression: "Ana"           (the value expression)
    //   value:      "Ana"           (the resolved value — same as expression for simple values)
    //
    // WHY: The replay system only knows how to process canonical entries.
    //      If raw writes bypassed canonicalization, a system restart would
    //      replay them in the wrong format and reconstruct wrong state.

    const namespace = uniqueNamespace();
    const identityHash = crypto.randomBytes(32).toString("hex");

    const claim = await claimNamespace({
      namespace,
      secret: "luna",
      identityHash,
    });

    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    // Write a raw operation (as it might arrive from an API client)
    recordMemory({
      namespace,
      identityHash,
      timestamp: Date.now(),
      payload: {
        operation: "write",
        expression: "profile.name",
        value: "Ana",
      },
    });

    // Retrieve all memories for this namespace and verify canonicalization
    const memories = getMemoriesForNamespace(namespace);
    expect(memories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "profile.name",   // the semantic key
          operator: null,         // raw write → no operator (null, not "=")
          expression: "Ana",      // the value expression
          value: "Ana",           // the resolved concrete value
        }),
      ]),
    );
  });

  it("returns semantic claim seeds through the same replay surface", async () => {
    // WHAT: After calling seedClaimNamespaceSemantics, the seeded data must
    //       be accessible through getMemoriesForNamespace — the same replay surface
    //       as raw writes.
    //
    // IMPORTANT: This verifies that seeds and raw writes are treated identically
    //            by the replay system. There must be ONE replay surface, not two.
    //            If seeds had their own private storage that bypassed getMemoriesForNamespace,
    //            a server restart would replay raw writes but lose seed data.
    //
    // We verify two specific entries that seedClaimNamespaceSemantics always writes:
    //   profile.name  → operator "=", value "Seed User"
    //   auth.claimed_at → operator "=", value <the claimedAt timestamp>

    const username = `seed${Date.now().toString(36)}`;
    const namespace = `${username}.cleaker.me`;
    const identityHash = crypto.randomBytes(32).toString("hex");
    const claimedAt = Date.now();

    const claim = await claimNamespace({
      namespace,
      secret: "sol",
      identityHash,
    });

    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    // Seed the namespace with standard user data
    seedClaimNamespaceSemantics({
      namespace,
      username,
      name: "Seed User",
      email: `${username}@example.com`,
      phone: "5512345678",
      passwordHash: identityHash,
      timestamp: claimedAt,
    });

    // Verify that the seeded data appears in the replay memory log
    const memories = getMemoriesForNamespace(namespace);
    expect(memories).toEqual(
      expect.arrayContaining([
        // The user's display name was seeded with operator "=" (set)
        expect.objectContaining({
          path: "profile.name",
          operator: "=",
          value: "Seed User",
        }),
        // The claim timestamp was seeded with operator "=" (set)
        expect.objectContaining({
          path: "auth.claimed_at",
          operator: "=",
          value: claimedAt,
        }),
      ]),
    );
  });
});
