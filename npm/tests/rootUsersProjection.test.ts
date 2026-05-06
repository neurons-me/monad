/**
 * rootUsersProjection.test.ts — Discovering All Users Under a Root Namespace
 *
 * WHAT IS THE ROOT NAMESPACE?
 * When monad.ai runs on "localhost:8161", its root namespace is derived from that
 * host (e.g., "localhost.local" or similar normalized form). This root namespace
 * acts as a directory of all local users:
 *
 *   root_namespace/"users.alice" → pointer to alice's namespace
 *   root_namespace/"users.bob"   → pointer to bob's namespace
 *
 * When a user claims a namespace like "alice.<root>" or "bob.<root>", the system
 * automatically writes a pointer entry in the root namespace's memory store.
 * This makes it possible to list all users on a given daemon.
 *
 * WHAT IS getUsersForRootNamespace?
 * Given a root host string (e.g., "localhost:8161"), it:
 *   1. Derives the canonical root namespace
 *   2. Reads all "users.*" pointers from that namespace's memory store
 *   3. Returns a list of user objects: { username, namespace, ... }
 *
 * WHAT WE TEST:
 * Claim two namespaces under the same root, then verify:
 *   1. getUsersForRootNamespace returns both users
 *   2. The root namespace's memory store has pointer entries for both
 *
 * CLEANUP: The test cleans up claim files in `finally` to avoid leaving
 * test artifacts on disk that could affect subsequent test runs.
 */

import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import { claimNamespace } from "../src/claim/records";
import { getUsersForRootNamespace } from "../src/Blockchain/users";
import { listSemanticMemoriesByNamespace } from "../src/claim/memoryStore";
import { composeProjectedNamespace, normalizeNamespaceRootName } from "../src/namespace/identity";
import { deletePersistentClaim, getPersistentClaimPath } from "../src/claim/manager";

// Generate unique usernames to avoid collision between test runs
function uniqueUsername(prefix: string) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

function uniqueIdentityHash() {
  return crypto.randomBytes(32).toString("hex");
}

test("projects claimed users from the root namespace", async () => {
  // WHAT: Simulate two users registering on the local daemon (localhost:8161).
  //       After they claim their namespaces, getUsersForRootNamespace should return both.
  //
  // SETUP:
  //   root = "localhost:8161"
  //   localRoot = normalizeNamespaceRootName("localhost:8161")
  //     → the canonical form of the root namespace (e.g., "localhost.local")
  //
  //   usernameA = "nefasto-<timestamp>-<rand>"
  //   namespaceA = composeProjectedNamespace(usernameA, root)
  //     → "nefasto-....localhost.local" (or similar)
  //
  // When claimNamespace(namespaceA) succeeds:
  //   - The claim file is written to disk
  //   - A pointer is written to the root namespace:
  //       localRoot/"users.nefasto-..." = namespaceA
  //
  // VERIFY:
  //   getUsersForRootNamespace(root) → includes both usernameA and usernameB
  //   listSemanticMemoriesByNamespace(localRoot, {limit:500}) → includes
  //     `users.usernameA` and `users.usernameB` pointer entries

  const root = "localhost:8161";
  const localRoot = normalizeNamespaceRootName(root);
  const usernameA = uniqueUsername("nefasto");
  const usernameB = uniqueUsername("neferefe");
  const namespaceA = composeProjectedNamespace(usernameA, root);
  const namespaceB = composeProjectedNamespace(usernameB, root);

  try {
    // Claim both namespaces — this triggers the root pointer writes
    const claimA = await claimNamespace({
      namespace: namespaceA,
      secret: "orwell1984",
      identityHash: uniqueIdentityHash(),
    });
    const claimB = await claimNamespace({
      namespace: namespaceB,
      secret: "animalfarm",
      identityHash: uniqueIdentityHash(),
    });

    assert.equal(claimA.ok, true, "first projected namespace should claim successfully");
    assert.equal(claimB.ok, true, "second projected namespace should claim successfully");

    // getUsersForRootNamespace reads the root namespace's "users.*" pointers
    // and returns them as structured user objects
    const users = getUsersForRootNamespace(root);
    const usernames = users.map((user) => user.username);

    assert.ok(
      usernames.includes(usernameA),
      "root namespace users should include the first claimed username",
    );
    assert.ok(
      usernames.includes(usernameB),
      "root namespace users should include the second claimed username",
    );

    // Verify the underlying memory pointers exist in the root namespace store.
    // These are the "users.<username>" entries that make projection possible.
    // We filter to only our specific test usernames (other tests might add more).
    const rootPointers = listSemanticMemoriesByNamespace(localRoot, { limit: 500 }).filter((row) =>
      row.path === `users.${usernameA}` || row.path === `users.${usernameB}`,
    );

    assert.equal(
      rootPointers.length,
      2,
      "root user pointers should be visible through the projected root namespace",
    );

  } finally {
    // Always clean up claim files, even if assertions fail.
    // Leaving claim files would cause "namespace already claimed" errors in other tests.
    deletePersistentClaim(namespaceA);
    deletePersistentClaim(namespaceB);
    const claimAPath = getPersistentClaimPath(namespaceA);
    const claimBPath = getPersistentClaimPath(namespaceB);
    if (fs.existsSync(claimAPath)) fs.rmSync(claimAPath, { force: true });
    if (fs.existsSync(claimBPath)) fs.rmSync(claimBPath, { force: true });
  }
});
