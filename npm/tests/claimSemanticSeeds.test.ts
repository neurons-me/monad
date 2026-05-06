/**
 * claimSemanticSeeds.test.ts — Namespace Claiming + Semantic Data Seeding
 *
 * WHAT IS A CLAIMED NAMESPACE?
 * A "namespace" is an identity address like "alice.cleaker.me".
 * "Claiming" it means registering ownership: generating a keypair, signing the claim,
 * and storing a persistent record on disk. After claiming, only the holder of the
 * secret + identityHash can modify data under that namespace.
 *
 * WHAT ARE SEMANTIC SEEDS?
 * When a user first registers, `seedClaimNamespaceSemantics` pre-populates their
 * namespace with a standard set of initial data:
 *
 *   keys.username       → their login handle
 *   profile.name        → their display name
 *   keys.password_hash  → their hashed password
 *   keys.namespace      → the full namespace string
 *
 * It also seeds application-specific data. For polls.studio users, that includes
 * a preset set of categories (jobs, housing, events, etc.) that appear in the
 * polls creation interface.
 *
 * WHAT WE TEST:
 * 1. Claim a namespace successfully
 * 2. Seed it with user data + polls.studio categories
 * 3. Verify the seeded data is readable through readSemanticValueForNamespace
 */

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { claimNamespace } from "../src/claim/records";
import { seedClaimNamespaceSemantics } from "../src/claim/claimSemantics";
import { readSemanticValueForNamespace } from "../src/claim/memoryStore";

describe("claim semantic seeds", () => {
  // Each test gets its own isolated claim directory on disk.
  // Without isolation, claims from one test would persist into the next.
  const originalClaimDir = process.env.MONAD_CLAIM_DIR;
  let claimDir = "";

  beforeEach(() => {
    claimDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-claims-"));
    process.env.MONAD_CLAIM_DIR = claimDir;
  });

  afterEach(() => {
    // Restore the original env var (or delete it if it was unset)
    if (originalClaimDir === undefined) {
      delete process.env.MONAD_CLAIM_DIR;
    } else {
      process.env.MONAD_CLAIM_DIR = originalClaimDir;
    }
    // Clean up temp files so disk doesn't fill up during CI
    fs.rmSync(claimDir, { recursive: true, force: true });
  });

  it("seeds keys and polls.studio categories for a claimed namespace", async () => {
    // WHAT: Full end-to-end test of the new user registration flow:
    //   1. Generate a unique username + namespace (to avoid collision between test runs)
    //   2. Claim the namespace (creates a keypair and persistent claim file on disk)
    //   3. Seed the namespace with profile data and polls.studio categories
    //   4. Verify every seeded value is accessible via readSemanticValueForNamespace
    //
    // WHY: This is the path every new user goes through. If seeding fails or data
    //      is missing, the user's profile page would render with missing fields
    //      and the polls creation interface would have no categories to show.
    //
    // Data seeded and verified:
    //   keys.username              → the login handle ("polls<timestamp>")
    //   profile.name               → display name ("Polls Studio Seed User")
    //   keys.password_hash         → hashed password (from claim.identityHash)
    //   keys.namespace             → the full namespace string
    //   polls.studio.categories.jobs.label    → "Jobs" (polls category label)
    //   polls.studio.categories.housing.kind  → "housing" (polls category kind)

    // Generate unique names to prevent collision between parallel test runs
    const username = `polls${Date.now().toString(36)}`;
    const namespace = `${username}.cleaker.me`;

    // Step 1: Claim the namespace
    // identityHash is a random 32-byte hex string (simulating a hashed password)
    const claim = await claimNamespace({
      namespace,
      secret: "luna",                                      // the signing secret
      identityHash: crypto.randomBytes(32).toString("hex"), // simulated password hash
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return; // TypeScript narrowing — claim.record is only available when ok=true

    // Step 2: Seed the namespace with user profile + application defaults
    seedClaimNamespaceSemantics({
      namespace,
      username,
      name: "Polls Studio Seed User",
      email: `${username}@example.com`,
      phone: "5512345678",
      passwordHash: claim.record.identityHash, // use the stored hash as the auth token
      timestamp: Date.now(),
    });

    // Step 3: Verify all seeded values are readable
    expect(readSemanticValueForNamespace(namespace, "keys.username")).toBe(username);
    expect(readSemanticValueForNamespace(namespace, "profile.name")).toBe("Polls Studio Seed User");
    expect(readSemanticValueForNamespace(namespace, "keys.password_hash")).toBeTruthy(); // exists + non-empty
    expect(readSemanticValueForNamespace(namespace, "keys.namespace")).toBe(namespace);

    // Polls.studio categories — these are pre-configured for all new users
    expect(readSemanticValueForNamespace(namespace, "polls.studio.categories.jobs.label")).toBe("Jobs");
    expect(readSemanticValueForNamespace(namespace, "polls.studio.categories.housing.kind")).toBe("housing");
  });
});
