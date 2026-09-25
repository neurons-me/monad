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
 *   - Only the holder of the private key can "open" (re-authenticate) the namespace
 *   - The daemon can verify its own claim file hasn't been tampered with
 *   - Different devices can hold different keypairs while sharing a namespace
 *
 * HOW TO "OPEN" A NAMESPACE (rewritten this session -- no more shared secret):
 * openNamespace({ namespace, proof }) verifies `proof` as a real this.me
 * ClaimProof -- the SAME shape claimNamespace() itself verifies -- from the
 * SAME key the claim recorded, with a real per-open nonce carried in the
 * proof's own `challenge` field. `rootNamespace` (also inside the proof)
 * doubles as the audience binding: checked against the server's own
 * getRootNamespace(), never trusted from the payload -- that is what stops
 * a signature made for one monad from being replayed against another
 * serving the same namespace. A shared "secret" is gone entirely: it used
 * to be the exact same material the signing key itself derives from
 * (deriveCompoundSeed), so sending it over the wire on every open leaked
 * key-deriving material for no corresponding security gain -- see
 * typedocs/Architecture/Identity-Namespace-Recovery-Audit.md §12 item 7.
 *
 * WHAT WE TEST:
 *   1. Happy path: claim, verify, open with a real signature, reject an
 *      invalid one, reject one from a different keypair, reject a repeated
 *      nonce.
 *   2. Supplied public key: client provides their own key, daemon adds its
 *      proof key.
 *   3. Keypair mismatch: public + private keys from different pairs → rejected.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { normalizeProofMessage } from "this.me";
import { claimNamespace, openNamespace, resetOpenNonceStoreForTests } from "../src/claim/records";
import { getRootNamespace } from "../src/kernel/manager";
import {
  getPersistentClaimPath,
  loadPersistentClaim,
  verifyPersistentClaim,
} from "../src/claim/manager";
import { buildClaimProof } from "./helpers/claimProof";

// Generate a unique namespace for each test to prevent file collisions.
function uniqueNamespace() {
  return `claim-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.cleaker.me`;
}

// Generate a random 32-byte hex identity hash (simulates a hashed password).
function uniqueIdentityHash() {
  return crypto.randomBytes(32).toString("hex");
}

// A real Ed25519 keypair the test controls end to end -- generated once,
// used to BOTH sign the claim proof (so record.publicKey is this key) and
// later sign an open challenge with it (or, for the negative cases,
// deliberately NOT with it). buildClaimProof (helpers/claimProof.ts)
// generates its own throwaway keypair internally and never exposes the
// private key, which is fine for tests that only claim -- these tests also
// need to open afterward with the SAME key, so they build the proof by hand.
async function generateEd25519Keypair(): Promise<CryptoKeyPair> {
  return crypto.webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

function toBase64Url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64url");
}

// Builds a real ClaimProof from a keypair this test fully controls.
// `challenge: null` (the default) matches claimNamespace()'s own shape;
// pass a nonce string to build an OPEN proof instead -- same function,
// since the server verifies both through the identical pipeline.
async function buildProof(keypair: CryptoKeyPair, namespace: string, identityHash: string, challenge: string | null = null) {
  const rootNamespace = getRootNamespace();
  const timestamp = Date.now();
  const publicKeyRaw = toBase64Url(await crypto.webcrypto.subtle.exportKey("raw", keypair.publicKey));
  const payload = { identityHash, expression: "test-expression", namespace, rootNamespace, challenge, timestamp };
  const message = normalizeProofMessage(payload);
  const signature = toBase64Url(await crypto.webcrypto.subtle.sign("Ed25519", keypair.privateKey, new TextEncoder().encode(message)));
  return { message, signature, publicKey: publicKeyRaw, timestamp };
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
    resetOpenNonceStoreForTests();
  });

  afterEach(() => {
    if (originalClaimDir === undefined) {
      delete process.env.MONAD_CLAIM_DIR;
    } else {
      process.env.MONAD_CLAIM_DIR = originalClaimDir;
    }
    fs.rmSync(claimDir, { recursive: true, force: true });
    resetOpenNonceStoreForTests();
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
    //     record.publicKey:            the namespace's Ed25519 public key (PEM) —
    //       here, the proof's own signing key, since no explicit publicKey
    //       was supplied and every first claim now requires a proof.
    //     persistentClaim.claim.publicKey.key: same key in the signed claim doc
    //     persistentClaim.claim.proofKey.key:  the daemon's OWN separate key
    //       (freshly generated — a namespace public key was supplied, via
    //       the proof, so this is the same "provided key" branch test 2
    //       exercises, not the "nothing supplied" branch).
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
    const identityHash = uniqueIdentityHash();
    const keypair = await generateEd25519Keypair();
    const claimProof = await buildProof(keypair, namespace, identityHash);
    const out = await claimNamespace({ namespace, identityHash, proof: claimProof });

    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // The claim file must exist on disk
    expect(fs.existsSync(getPersistentClaimPath(namespace))).toBe(true);

    // The public key fields must be populated and consistent between record and claim
    expect(out.record.publicKey).toBeTruthy();
    expect(out.persistentClaim.claim.publicKey.key).toBe(out.record.publicKey);
    // The proof supplies a namespace public key (the proof's own signing
    // key), so the daemon generates its OWN separate proof key here — same
    // "provided key" shape as the next test, not the "nothing supplied,
    // reuse one key for both roles" shape.
    expect(out.persistentClaim.claim.proofKey.key).not.toBe(out.record.publicKey);

    // The claim file signature must verify correctly
    expect(verifyPersistentClaim(namespace)).toBe(true);

    // Opening with a real proof from the SAME key the claim recorded succeeds.
    const openProof = await buildProof(keypair, namespace, identityHash, "open:open-nonce-1");
    const opened = await openNamespace({ namespace, proof: openProof });
    expect(opened.ok).toBe(true);

    // An invalid signature (garbage bytes, still base64url-shaped, on an
    // otherwise well-formed proof) is rejected.
    const invalidSigResult = await openNamespace({
      namespace,
      proof: { ...(await buildProof(keypair, namespace, identityHash, "open:open-nonce-2")), signature: toBase64Url(crypto.randomBytes(64)) },
    });
    expect(invalidSigResult).toEqual({ ok: false, error: "CLAIM_VERIFICATION_FAILED" });

    // A well-formed proof from a DIFFERENT keypair is rejected — proves
    // verification actually checks against record.publicKey, not just that
    // "some" valid proof was attached.
    const otherKeypair = await generateEd25519Keypair();
    const wrongKeyProof = await buildProof(otherKeypair, namespace, identityHash, "open:open-nonce-3");
    const wrongKeyResult = await openNamespace({ namespace, proof: wrongKeyProof });
    expect(wrongKeyResult).toEqual({ ok: false, error: "CLAIM_VERIFICATION_FAILED" });

    // Replaying the EXACT same proof that already succeeded above is
    // rejected — a repeated nonce, not silently re-verified.
    const replayed = await openNamespace({ namespace, proof: openProof });
    expect(replayed).toEqual({ ok: false, error: "NONCE_REUSED" });
  });

  it("rejects a captured CLAIM proof replayed as an open, even from the right key within the window", async () => {
    // The specific gap review caught: proveKernelNamespace()'s challenge:
    // null default is only true for cleaker's OWN claimRemote() -- a real
    // production caller (useCleakerAuth.ts's sign-up flow) signs a real,
    // non-null challenge on its CLAIM proof too (a canonicalJson string
    // binding it to /claims specifically). Before the "open:" prefix
    // requirement, that non-null challenge would trivially satisfy "looks
    // like an unused open nonce" -- meaning a claim response observed in
    // transit (e.g. network logging, a browser extension) could be
    // replayed as a real open within the 60s window, handing back real
    // memories a claim's own response never includes.
    const namespace = uniqueNamespace();
    const identityHash = uniqueIdentityHash();
    const keypair = await generateEd25519Keypair();

    // A claim proof with a real, non-null challenge -- exactly what
    // useCleakerAuth.ts's real /claims call signs (not cleaker's own
    // null-challenge claimRemote() shape).
    const claimProofWithChallenge = await buildProof(keypair, namespace, identityHash, "canonicalJson-style-challenge-not-a-nonce");
    const claimed = await claimNamespace({ namespace, identityHash, proof: claimProofWithChallenge });
    assert.equal(claimed.ok, true);

    // Replaying that EXACT claim proof as an open must fail -- it has no
    // "open:" prefix, so it is never even treated as a candidate nonce.
    const replayedAsOpen = await openNamespace({ namespace, proof: claimProofWithChallenge });
    assert.deepEqual(replayedAsOpen, { ok: false, error: "NONCE_REQUIRED" });

    // A genuinely "open:"-prefixed proof from the same key still works --
    // confirms the rejection above is about the prefix, not the key/namespace.
    const realOpenProof = await buildProof(keypair, namespace, identityHash, "open:the-real-thing");
    const realOpen = await openNamespace({ namespace, proof: realOpenProof });
    assert.equal(realOpen.ok, true);
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

    const identityHash = uniqueIdentityHash();
    const out = await claimNamespace({
      namespace,
      identityHash,
      publicKey: supplied, // client's own public key
      proof: await buildClaimProof({ namespace, identityHash }),
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

    const identityHash = uniqueIdentityHash();
    const out = await claimNamespace({
      namespace,
      identityHash,
      publicKey: a.publicKey.export({ type: "spki", format: "pem" }).toString(),   // from A
      privateKey: b.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), // from B (!)
      proof: await buildClaimProof({ namespace, identityHash }),
    });

    expect(out).toEqual({
      ok: false,
      error: "CLAIM_KEYPAIR_MISMATCH",
    });
  });
});
