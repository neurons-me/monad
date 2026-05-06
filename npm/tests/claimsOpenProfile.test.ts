/**
 * claimsOpenProfile.test.ts — Reading a User's Public Profile from Their Namespace
 *
 * WHAT IS AN "OPEN PROFILE"?
 * When another user (or the API) reads a namespace's public data, they call
 * `readOpenedClaimProfile(namespace)`. This returns a structured object with:
 *
 *   profile: {
 *     username:  the login handle
 *     name:      display name
 *     email:     email address
 *     phone:     phone number
 *   }
 *   claimedAt: the Unix timestamp when the namespace was first claimed
 *
 * This is the "open" (public) view of a user's identity. The "claim" (private)
 * view includes the secret and keypair — this profile view strips those out.
 *
 * HOW DOES IT WORK?
 * The profile data lives in the semantic memory store under the namespace:
 *   namespace/"profile.name"    → "Maria Garcia"
 *   namespace/"keys.username"   → "maria..."
 *   namespace/"auth.claimed_at" → 1746412800000
 *
 * `readOpenedClaimProfile` reads those paths and assembles them into the profile object.
 *
 * WHAT WE TEST:
 * Full round-trip: claim a namespace, seed it with user data, then read back
 * the assembled profile and verify every field matches the input.
 */

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { claimNamespace } from "../src/claim/records";
import { seedClaimNamespaceSemantics } from "../src/claim/claimSemantics";
import { readOpenedClaimProfile } from "../src/http/claims";

describe("claims open profile hydration", () => {
  // Use beforeAll/afterAll (not beforeEach/afterEach) because this test file
  // only has one test. The claim directory is created once and cleaned up once.
  const previousClaimDir = process.env.MONAD_CLAIM_DIR;
  const claimDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-claims-open-"));

  beforeAll(() => {
    process.env.MONAD_CLAIM_DIR = claimDir;
  });

  afterAll(() => {
    if (previousClaimDir === undefined) {
      delete process.env.MONAD_CLAIM_DIR;
    } else {
      process.env.MONAD_CLAIM_DIR = previousClaimDir;
    }
    fs.rmSync(claimDir, { recursive: true, force: true });
  });

  it("reads profile fields and canonical claim timestamp from semantic state", async () => {
    // WHAT: Full round-trip of the profile hydration pipeline:
    //   1. Generate a unique namespace (to avoid collisions between test runs)
    //   2. Claim the namespace with a secret and identity hash
    //   3. Seed it with Maria's profile data and the claim timestamp
    //   4. Call readOpenedClaimProfile(namespace) and verify the assembled profile
    //
    // WHY: This is what the API returns for GET /profile (or GET /@username).
    //      If any field is missing or mismatched, the user's profile page shows
    //      wrong data or empty fields.
    //
    // The timestamp is captured BEFORE claiming so we can verify `claimedAt`
    // matches what was stored during seeding (not the actual claim time).
    // This matters because claimed_at is written by seedClaimNamespaceSemantics,
    // not by claimNamespace itself.

    // Generate unique suffix to prevent collision (multiple tests may run simultaneously)
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const username = `maria${suffix}`.slice(0, 24); // limit to 24 chars for realism
    const namespace = `${username}.cleaker.me`;
    const timestamp = Date.now(); // capture before seeding

    // Step 1: Claim the namespace
    const claimed = await claimNamespace({
      namespace,
      secret: "secret-123",
      identityHash: crypto.randomBytes(32).toString("hex"),
    });

    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    // Step 2: Seed profile data into the namespace's semantic store
    seedClaimNamespaceSemantics({
      namespace,
      username,
      name: "Maria Garcia",
      email: "maria@example.com",
      phone: "+52 729 167 1525",
      passwordHash: claimed.record.identityHash,
      timestamp, // this becomes the `claimedAt` in the profile
    });

    // Step 3: Read the assembled profile and verify every field
    expect(readOpenedClaimProfile(namespace)).toEqual({
      profile: {
        username,             // matches what was seeded
        name: "Maria Garcia", // matches what was seeded
        email: "maria@example.com",
        phone: "+52 729 167 1525",
      },
      claimedAt: timestamp, // the exact timestamp passed to seedClaimNamespaceSemantics
    });
  });
});
