/**
 * persistentClaim.test.ts — Namespace Ownership and Cryptographic Claims
 *
 * WHAT IS A PERSISTENT CLAIM?
 * When a user registers a namespace like "alice.cleaker.me", the system:
 *   1. Generates an Ed25519 keypair (or accepts one provided by the client)
 *   2. Creates a "claim" document signed with that private key
 *   3. Stores the claim on disk (in MONAD_CLAIM_DIR)
 *
 * The claim document is proof of ownership. It contains:
 *   publicKey:  the namespace's public key (for verifying signatures)
 *   proofKey:   the daemon's own public key (for verifying local signatures)
 *   (plus the identityHash, timestamp, and signature)
 *
 * WHY CRYPTOGRAPHIC CLAIMS?
 * Without crypto, anyone could claim any namespace by just writing to disk.
 * With cryptographic claims:
 *   - Only the holder of the private key + secret can "open" (re-authenticate) the namespace
 *   - The daemon can verify its own claim file hasn't been tampered with
 *   - Different devices can hold different keypairs while sharing a namespace
 *
 * HOW TO "OPEN" A NAMESPACE:
 * After claiming, you can re-authenticate with:
 *   openNamespace({ namespace, secret, identityHash }) → { ok: true }
 *   Wrong secret → { ok: false, error: "CLAIM_VERIFICATION_FAILED" }
 *
 * WHAT WE TEST (3 cases):
 *   1. Happy path: claim, verify, open, reject wrong secret
 *   2. Supplied public key: client provides their own key, daemon adds its proof key
 *   3. Keypair mismatch: public + private keys from different pairs → rejected
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { claimNamespace, openNamespace } from "../src/claim/records";
import {
  getPersistentClaimPath,
  loadPersistentClaim,
  verifyPersistentClaim,
} from "../src/claim/manager";

// Generate a unique namespace for each test to prevent file collisions.
function uniqueNamespace() {
  return `claim-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.cleaker.me`;
}

// Generate a random 32-byte hex identity hash (simulates a hashed password).
function uniqueIdentityHash() {
  return crypto.randomBytes(32).toString("hex");
}

describe("persistent claims", () => {
  // Each test gets a fresh temporary directory for claim files.
  // Without this, a claim from test A would already exist when test B runs,
  // causing "namespace already claimed" errors.
  const originalClaimDir = process.env.MONAD_CLAIM_DIR;
  let claimDir = "";

  beforeEach(() => {
    claimDir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-claims-"));
    process.env.MONAD_CLAIM_DIR = claimDir;
  });

  afterEach(() => {
    if (originalClaimDir === undefined) {
      delete process.env.MONAD_CLAIM_DIR;
    } else {
      process.env.MONAD_CLAIM_DIR = originalClaimDir;
    }
    fs.rmSync(claimDir, { recursive: true, force: true });
  });

  it("creates a signed persistent claim and stores it on disk", async () => {
    // WHAT: Full claim lifecycle:
    //   1. Claim a namespace → creates a keypair and writes a claim file
    //   2. Verify the claim file is valid (signature checks out)
    //   3. Open with the correct secret → succeeds
    //   4. Open with a wrong secret → fails with CLAIM_VERIFICATION_FAILED
    //
    // DETAILS:
    //   claimNamespace returns:
    //     ok: true
    //     record.publicKey:            the namespace's Ed25519 public key (PEM)
    //     persistentClaim.claim.publicKey.key: same key in the signed claim doc
    //     persistentClaim.claim.proofKey.key:  the daemon's public key (also in the doc)
    //
    //   The public key in the record EQUALS the public key in the claim:
    //     out.record.publicKey === out.persistentClaim.claim.publicKey.key
    //
    //   getPersistentClaimPath(namespace) → the path where the claim file lives.
    //   After claiming, the file must exist on disk.
    //
    //   verifyPersistentClaim(namespace) → true if the file signature is valid.
    //
    //   openNamespace(correct secret) → { ok: true }
    //   openNamespace(wrong secret)   → { ok: false, error: "CLAIM_VERIFICATION_FAILED" }
    //
    // WHY: This is the security foundation. If the claim file doesn't verify,
    //      anyone could forge ownership. If open doesn't reject wrong secrets,
    //      any user could access any namespace.

    const namespace = uniqueNamespace();
    const out = await claimNamespace({
      namespace,
      secret: "luna",
      identityHash: uniqueIdentityHash(),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // The claim file must exist on disk
    expect(fs.existsSync(getPersistentClaimPath(namespace))).toBe(true);

    // The public key fields must be populated and consistent between record and claim
    expect(out.record.publicKey).toBeTruthy();
    expect(out.persistentClaim.claim.publicKey.key).toBe(out.record.publicKey);
    expect(out.persistentClaim.claim.proofKey.key).toBe(out.record.publicKey);

    // The claim file signature must verify correctly
    expect(verifyPersistentClaim(namespace)).toBe(true);

    // Opening with the correct credentials should succeed
    const opened = openNamespace({
      namespace,
      secret: "luna",
      identityHash: out.record.identityHash,
    });
    expect(opened.ok).toBe(true);

    // Opening with a wrong secret must fail
    const rejected = openNamespace({
      namespace,
      secret: "sol", // wrong secret
      identityHash: out.record.identityHash,
    });
    expect(rejected).toEqual({
      ok: false,
      error: "CLAIM_VERIFICATION_FAILED",
    });
  });

  it("preserves an explicit namespace public key and still signs the passport locally", async () => {
    // WHAT: The client supplies their own Ed25519 public key during claiming.
    //       The claim should use the SUPPLIED key for the namespace identity,
    //       but the daemon still adds its OWN proof key (a separate key).
    //
    // WHY: Some use cases require the client to control their own keypair:
    //   - Hardware security keys (the private key never leaves the device)
    //   - External PKI (the namespace key is signed by a CA)
    //   - Cross-device identity (same public key, multiple devices each with their own proof key)
    //
    // The loaded claim file should show:
    //   claim.publicKey.key  = supplied (client's key)
    //   claim.proofKey.key   ≠ supplied (daemon's own key, different from client's)
    //
    // out.record.publicKey = supplied (stored in the record for verification)
    // verifyPersistentClaim → still true (daemon signed with its own key)

    const namespace = uniqueNamespace();
    // Generate a fresh keypair — this is what the "client" would supply
    const supplied = crypto.generateKeyPairSync("ed25519").publicKey.export({
      type: "spki",
      format: "pem",
    }).toString();

    const out = await claimNamespace({
      namespace,
      secret: "sol",
      identityHash: uniqueIdentityHash(),
      publicKey: supplied, // client's own public key
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const loaded = loadPersistentClaim(namespace);
    expect(loaded).not.toBeNull();
    expect(loaded?.claim.publicKey.key).toBe(supplied);        // client's key preserved
    expect(loaded?.claim.proofKey.key).not.toBe(supplied);     // daemon's key is different
    expect(out.record.publicKey).toBe(supplied);               // record shows client's key
    expect(verifyPersistentClaim(namespace)).toBe(true);       // daemon's proof still valid
  });

  it("rejects mismatched private/public key pairs", async () => {
    // WHAT: Try to claim with a public key from keypair A but a private key from keypair B.
    //       The system must detect this mismatch and reject the claim.
    //
    // WHY: A claim is signed with the private key and verified with the public key.
    //      If public and private keys don't match, the signature verification would
    //      fail for every subsequent operation. We catch this early during claiming
    //      to give a clear error instead of confusing verification failures later.
    //
    // Error: { ok: false, error: "CLAIM_KEYPAIR_MISMATCH" }

    const namespace = uniqueNamespace();
    const a = crypto.generateKeyPairSync("ed25519"); // keypair A
    const b = crypto.generateKeyPairSync("ed25519"); // keypair B — completely different

    const out = await claimNamespace({
      namespace,
      secret: "estrella",
      identityHash: uniqueIdentityHash(),
      publicKey: a.publicKey.export({ type: "spki", format: "pem" }).toString(),   // from A
      privateKey: b.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), // from B (!)
    });

    expect(out).toEqual({
      ok: false,
      error: "CLAIM_KEYPAIR_MISMATCH",
    });
  });
});
