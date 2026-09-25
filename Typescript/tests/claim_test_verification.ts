import assert from "assert";
import crypto from "crypto";
import { normalizeProofMessage } from "this.me";
import { claimNamespace, openNamespace } from "../src/claim/records";
import { getRootNamespace } from "../src/kernel/manager";
import { listSemanticMemoriesByNamespace } from "../src/claim/memoryStore";

function uniqueNamespace() {
  return `claim-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.cleaker.me`;
}

function uniqueIdentityHash() {
  return crypto.randomBytes(32).toString("hex");
}

function pass(label: string) {
  console.log(`PASS ${label}`);
}

function fail(label: string, error: unknown): never {
  console.error(`FAIL ${label}`);
  throw error instanceof Error ? error : new Error(String(error));
}

// A real Ed25519 keypair this script fully controls -- claimNamespace()
// requires a real proof (mandatory, no legacy asserted-identityHash path),
// and openNamespace() now requires a real proof too (the SAME ClaimProof
// shape, with a per-open nonce carried in its own `challenge` field) from
// the SAME key the claim recorded -- there is no shared "secret" left to
// send on either call. See persistentClaim.test.ts for the same pattern
// with fuller commentary on why open reuses the claim-proof shape.
async function generateEd25519Keypair(): Promise<CryptoKeyPair> {
  return crypto.webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

function toBase64Url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64url");
}

// challenge: null builds a CLAIM proof (claimNamespace()'s own shape);
// a nonce string builds an OPEN proof -- same function, since the server
// verifies both through the identical pipeline.
async function buildProof(keypair: CryptoKeyPair, namespace: string, identityHash: string, challenge: string | null = null) {
  const rootNamespace = getRootNamespace();
  const timestamp = Date.now();
  const publicKeyRaw = toBase64Url(await crypto.webcrypto.subtle.exportKey("raw", keypair.publicKey));
  const payload = { identityHash, expression: "test-expression", namespace, rootNamespace, challenge, timestamp };
  const message = normalizeProofMessage(payload);
  const signature = toBase64Url(await crypto.webcrypto.subtle.sign("Ed25519", keypair.privateKey, new TextEncoder().encode(message)));
  return { message, signature, publicKey: publicKeyRaw, timestamp };
}

async function testVerified() {
  const namespace = uniqueNamespace();
  const identityHash = uniqueIdentityHash();
  const keypair = await generateEd25519Keypair();

  const claim = await claimNamespace({ namespace, identityHash, proof: await buildProof(keypair, namespace, identityHash) });
  assert.equal(claim.ok, true, "claim should succeed for a fresh namespace");
  if (!claim.ok) {
    throw new Error(`claim failed with ${claim.error}`);
  }

  const openProof = await buildProof(keypair, namespace, identityHash, "verified-nonce");
  const opened = await openNamespace({ namespace, proof: openProof });
  assert.equal(opened.ok, true, "open should succeed with a real proof from the claimed key");
  if (!opened.ok) {
    throw new Error(`open failed with ${opened.error}`);
  }

  assert.equal(opened.record.namespace, namespace);
  assert.equal(opened.record.identityHash, claim.record.identityHash);
}

async function testClaimMaterializesRootUserPointer() {
  const namespace = uniqueNamespace();
  const identityHash = uniqueIdentityHash();
  const keypair = await generateEd25519Keypair();
  const username = namespace.split(".")[0];
  const pointerPath = `users.${username}`;
  // The bare pointer itself is an EXACT entry at `users.<username>`, not
  // something living UNDER a prefix -- listSemanticMemoriesByNamespace's own
  // `prefix` option only ever returns paths strictly deeper than the
  // prefix (same "bare pointer vs. content beneath it" distinction as
  // kernel/manager.ts's ownerLabelOfCanonicalPath), so filtering by exact
  // path on an unfiltered listing is the correct way to find it -- the same
  // pattern rootUsersProjection.test.ts already uses.
  const countPointers = () =>
    listSemanticMemoriesByNamespace("cleaker.me", { limit: 500 }).filter((row) => row.path === pointerPath).length;

  const before = countPointers();

  const claim = await claimNamespace({ namespace, identityHash, proof: await buildProof(keypair, namespace, identityHash) });
  assert.equal(claim.ok, true, "claim should succeed for a projected namespace");
  if (!claim.ok) {
    throw new Error(`claim failed with ${claim.error}`);
  }

  const rootMemories = listSemanticMemoriesByNamespace("cleaker.me", { limit: 500 }).filter((row) => row.path === pointerPath);
  assert.equal(rootMemories.length, before + 1, "claim should materialize one root user pointer");

  const pointer = rootMemories[rootMemories.length - 1];
  assert.equal(pointer.path, pointerPath);
  assert.equal(pointer.operator, "__");
  assert.deepEqual(pointer.data, { __ptr: namespace });

  const afterClaimCount = rootMemories.length;
  const openProof = await buildProof(keypair, namespace, identityHash, "root-pointer-nonce");
  const opened = await openNamespace({ namespace, proof: openProof });
  assert.equal(opened.ok, true, "open should succeed after claim");
  if (!opened.ok) {
    throw new Error(`open failed with ${opened.error}`);
  }

  const afterOpen = countPointers();
  assert.equal(afterOpen, afterClaimCount, "open should not materialize root pointers again");
}

async function testFailed() {
  const namespace = uniqueNamespace();
  const identityHash = uniqueIdentityHash();
  const keypair = await generateEd25519Keypair();

  const claim = await claimNamespace({ namespace, identityHash, proof: await buildProof(keypair, namespace, identityHash) });
  assert.equal(claim.ok, true, "claim should succeed for a fresh namespace");
  if (!claim.ok) {
    throw new Error(`claim failed with ${claim.error}`);
  }

  // A proof from a DIFFERENT keypair -- well-formed, just not the one the
  // claim recorded -- must fail verification, not merely "not match a secret".
  const wrongKeypair = await generateEd25519Keypair();
  const wrongKeyProof = await buildProof(wrongKeypair, namespace, identityHash, "failed-nonce");
  const opened = await openNamespace({ namespace, proof: wrongKeyProof });
  assert.equal(opened.ok, false, "open should fail with a proof from the wrong key");
  if (opened.ok) {
    throw new Error("open unexpectedly succeeded");
  }

  assert.equal(opened.error, "CLAIM_VERIFICATION_FAILED");
}

async function testNonceReused() {
  const namespace = uniqueNamespace();
  const identityHash = uniqueIdentityHash();
  const keypair = await generateEd25519Keypair();

  const claim = await claimNamespace({ namespace, identityHash, proof: await buildProof(keypair, namespace, identityHash) });
  assert.equal(claim.ok, true, "claim should succeed for a fresh namespace");
  if (!claim.ok) {
    throw new Error(`claim failed with ${claim.error}`);
  }

  const openProof = await buildProof(keypair, namespace, identityHash, "reused-nonce");

  const firstOpen = await openNamespace({ namespace, proof: openProof });
  assert.equal(firstOpen.ok, true, "first open with a fresh nonce should succeed");

  const replayed = await openNamespace({ namespace, proof: openProof });
  assert.equal(replayed.ok, false, "replaying the exact same open proof should fail");
  if (replayed.ok) {
    throw new Error("replayed open unexpectedly succeeded");
  }
  assert.equal(replayed.error, "NONCE_REUSED");
}

async function main() {
  await testVerified();
  pass("claim_test_verification.verified");

  await testClaimMaterializesRootUserPointer();
  pass("claim_test_verification.root_pointer");

  await testFailed();
  pass("claim_test_verification.failed");

  await testNonceReused();
  pass("claim_test_verification.nonce_reused");

  console.log("All claim verification tests passed.");
}

main().catch((error) => {
  fail("claim_test_verification", error);
});
