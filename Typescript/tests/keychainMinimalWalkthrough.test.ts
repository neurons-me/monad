/**
 * keychainMinimalWalkthrough.test.ts — the real minimal keychain walkthrough:
 * list public keys -> register a new key with signed authorization -> sign
 * an operation with it -> revoke it -> confirm new operations with it are
 * rejected. Plus the negative cases the design depends on: replay rejection,
 * revocation blocking further admin actions, and a non-admin active key
 * still being rejected for admin mutations while remaining able to sign --
 * the keychain only ever gates its OWN operations (register/revoke) by the
 * admin bit; signing is gated by nothing but "is this key currently active
 * and does the signature verify." Whether some other system trusts that
 * signature for anything specific is that system's own business, not the
 * keychain's.
 *
 * Signing reuses this.me's real Ed25519 primitives -- the same ones
 * SeedSession.signPayload() wraps for a BIP-39-recovered identity
 * (packages/GUI/Typescript/src/core/session/createCleakerSession.ts) and
 * the same ones commitGate.test.ts already uses to represent a claimed
 * identity end to end. The namespace's claim (established via POST /
 * {operation:'claim',...}, exactly as a recoverable identity's first real
 * claim would be) stands in for "the existing recoverable identity" and is
 * the sole authority for the FIRST keychain key; every key after that is
 * authorized by an already-active admin keychain key, never the claim again.
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createMonadApp } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";
import { resetKeychainNonceCacheForTests } from "../src/claim/keychain";
import {
  deriveBranchProofSeed,
  importEd25519SigningKey,
  normalizeProofMessage,
  signEd25519Proof,
// @ts-expect-error -- see commitGate.test.ts's identical note: no .d.ts
// resolution across this relative path; the runtime import reaches the
// local workspace build directly.
} from "../../../me/Typescript/dist/me.es.js";

const ROOT_NAMESPACE = "cleaker.me";

function createTempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-keychain-"));
  return {
    root,
    stateDir: path.join(root, "me-state"),
    claimDir: path.join(root, "claims"),
    selfConfigPath: path.join(root, "self.json"),
  };
}

async function startServer(runtimeRoot: string) {
  const runtime = createTempRuntime();
  const app = await createMonadApp({
    cwd: runtimeRoot,
    seed: "test-seed-keychain",
    namespace: ROOT_NAMESPACE,
    stateDir: runtime.stateDir,
    claimDir: runtime.claimDir,
    selfConfigPath: runtime.selfConfigPath,
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { server, origin: `http://127.0.0.1:${port}` };
}

async function post(origin: string, urlPath: string, body: unknown) {
  const res = await fetch(`${origin}${urlPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function get(origin: string, urlPath: string) {
  const res = await fetch(`${origin}${urlPath}`);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// The recoverable identity's own root signing capability: same derivation
// SeedSession.signPayload() uses, same claim-establishment commitGate.test.ts
// already exercises end to end.
async function claimTestIdentity(origin: string, username: string, secret: string) {
  const namespace = `${username}.${ROOT_NAMESPACE}`;
  const identityHash = username;
  const branchSeed = await deriveBranchProofSeed(secret, username);
  const { privateKey, publicKey } = await importEd25519SigningKey(branchSeed);
  const publicKeyRaw = Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64url");

  const timestamp = Date.now();
  const proofPayload = { identityHash, expression: username, namespace, rootNamespace: ROOT_NAMESPACE, challenge: null, timestamp };
  const proofMessage = normalizeProofMessage(proofPayload);
  const proofSignature = await signEd25519Proof(privateKey, proofMessage);

  const claimRes = await post(origin, "/", {
    operation: "claim",
    namespace,
    secret,
    identityHash,
    proof: { message: proofMessage, signature: proofSignature, publicKey: publicKeyRaw, timestamp },
  });
  if (claimRes.status !== 201) {
    throw new Error(`Test setup failed: claim returned ${claimRes.status} ${JSON.stringify(claimRes.json)}`);
  }

  return {
    namespace,
    identityHash,
    sign: (message: string) => signEd25519Proof(privateKey, message),
  };
}

// A freshly generated device/app key -- never derived from any identity's
// seed, exactly how a real "register a new key" flow would generate one
// locally before ever sending its public half to the server.
async function generateDeviceKey() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const { privateKey, publicKey } = await importEd25519SigningKey(seed);
  const publicKeyRaw = Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64url");
  return {
    publicKeyRaw,
    sign: (message: string) => signEd25519Proof(privateKey, message),
  };
}

function randomNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
}

describe("keychain: minimal real walkthrough", () => {
  let server: Server;
  let origin: string;
  let runtimeRoot: string;

  beforeEach(async () => {
    resetKernelStateForTests();
    resetKeychainNonceCacheForTests();
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monad-keychain-cwd-"));
    const started = await startServer(runtimeRoot);
    server = started.server;
    origin = started.origin;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    resetKernelStateForTests();
    resetKeychainNonceCacheForTests();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it("runs the full list -> register -> sign -> revoke -> reject walkthrough", async () => {
    const identity = await claimTestIdentity(origin, "quinn", "quinn-secret");

    // 1) list -> empty keychain
    const emptyList = await get(origin, `/api/v1/keychain/keys?namespace=${identity.namespace}`);
    expect(emptyList.status).toBe(200);
    expect(emptyList.json.keys).toEqual([]);

    // 2) register the first key, authorized by the recoverable identity's
    // own root claim key -- the bootstrap path. The first key is always
    // admin (a keychain that started with zero admin keys could never be
    // administered again).
    const key1 = await generateDeviceKey();
    const key1Nonce = randomNonce();
    const key1Timestamp = Date.now();
    const key1NewKey = { publicKey: key1.publicKeyRaw, label: "This laptop" };
    const key1Signed = { op: "keychain-register", namespace: identity.namespace, newKey: key1NewKey, nonce: key1Nonce, timestamp: key1Timestamp, identityHash: identity.identityHash };
    const key1Signature = await identity.sign(normalizeProofMessage(key1Signed));

    const registerKey1 = await post(origin, "/api/v1/keychain/keys", {
      namespace: identity.namespace,
      identityHash: identity.identityHash,
      newKey: key1NewKey,
      nonce: key1Nonce,
      timestamp: key1Timestamp,
      signature: key1Signature,
    });
    expect(registerKey1.status).toBe(201);
    expect(registerKey1.json.key.authorization).toBe("active");
    expect(registerKey1.json.key.admin).toBe(true);
    const key1Id = registerKey1.json.key.keyId as string;

    // 3) list -> one active key
    const listAfterKey1 = await get(origin, `/api/v1/keychain/keys?namespace=${identity.namespace}`);
    expect(listAfterKey1.json.keys.map((k: any) => k.keyId)).toEqual([key1Id]);

    // 4) sign a real operation with key1 -- the keychain gates this by
    // nothing but "active + signature verifies", never a permission label.
    const opNonce = randomNonce();
    const opTimestamp = Date.now();
    const opSignedFields = { op: "keychain-sign", namespace: identity.namespace, keyId: key1Id, payload: { op: "ping" }, nonce: opNonce, timestamp: opTimestamp };
    const opSignature = await key1.sign(normalizeProofMessage(opSignedFields));
    const signRes = await post(origin, `/api/v1/keychain/keys/${key1Id}/sign`, {
      namespace: identity.namespace,
      payload: { op: "ping" },
      nonce: opNonce,
      timestamp: opTimestamp,
      signature: opSignature,
    });
    expect(signRes.status).toBe(200);
    expect(signRes.json.opId).toBeTruthy();

    // Replay: resending the exact same signed request must be rejected,
    // even though key1 is still perfectly active.
    const replayRes = await post(origin, `/api/v1/keychain/keys/${key1Id}/sign`, {
      namespace: identity.namespace,
      payload: { op: "ping" },
      nonce: opNonce,
      timestamp: opTimestamp,
      signature: opSignature,
    });
    expect(replayRes.status).toBe(403);
    expect(replayRes.json.error).toBe("REPLAY_REJECTED");

    // 5) register a second key, this time authorized by key1 (the
    // post-bootstrap, peer-signed path -- the claim/root key is not asked).
    // This one is deliberately NOT admin.
    const key2 = await generateDeviceKey();
    const key2Nonce = randomNonce();
    const key2Timestamp = Date.now();
    const key2NewKey = { publicKey: key2.publicKeyRaw, label: "Scoped app key", admin: false };
    const key2Signed = { op: "keychain-register", namespace: identity.namespace, newKey: key2NewKey, nonce: key2Nonce, timestamp: key2Timestamp, actingKeyId: key1Id };
    const key2Signature = await key1.sign(normalizeProofMessage(key2Signed));

    const registerKey2 = await post(origin, "/api/v1/keychain/keys", {
      namespace: identity.namespace,
      actingKeyId: key1Id,
      newKey: key2NewKey,
      nonce: key2Nonce,
      timestamp: key2Timestamp,
      signature: key2Signature,
    });
    expect(registerKey2.status).toBe(201);
    expect(registerKey2.json.key.admin).toBe(false);
    const key2Id = registerKey2.json.key.keyId as string;

    // 5b) a non-admin key can still sign, same as any active key -- the
    // gap this design closes is admin actions by an underscoped key, not
    // ordinary signing.
    const key2SignNonce = randomNonce();
    const key2SignTimestamp = Date.now();
    const key2SignFields = { op: "keychain-sign", namespace: identity.namespace, keyId: key2Id, payload: { op: "scoped-ping" }, nonce: key2SignNonce, timestamp: key2SignTimestamp };
    const key2SignSignature = await key2.sign(normalizeProofMessage(key2SignFields));
    const key2SignRes = await post(origin, `/api/v1/keychain/keys/${key2Id}/sign`, {
      namespace: identity.namespace,
      payload: { op: "scoped-ping" },
      nonce: key2SignNonce,
      timestamp: key2SignTimestamp,
      signature: key2SignSignature,
    });
    expect(key2SignRes.status).toBe(200);

    // 5c) but key2 (non-admin) cannot register a third key.
    const key3 = await generateDeviceKey();
    const key3ViaKey2Nonce = randomNonce();
    const key3ViaKey2Timestamp = Date.now();
    const key3ViaKey2NewKey = { publicKey: key3.publicKeyRaw, label: "Should not register" };
    const key3ViaKey2Signed = { op: "keychain-register", namespace: identity.namespace, newKey: key3ViaKey2NewKey, nonce: key3ViaKey2Nonce, timestamp: key3ViaKey2Timestamp, actingKeyId: key2Id };
    const key3ViaKey2Signature = await key2.sign(normalizeProofMessage(key3ViaKey2Signed));
    const key3ViaKey2Res = await post(origin, "/api/v1/keychain/keys", {
      namespace: identity.namespace,
      actingKeyId: key2Id,
      newKey: key3ViaKey2NewKey,
      nonce: key3ViaKey2Nonce,
      timestamp: key3ViaKey2Timestamp,
      signature: key3ViaKey2Signature,
    });
    expect(key3ViaKey2Res.status).toBe(403);
    expect(key3ViaKey2Res.json.error).toBe("PERMISSION_DENIED");

    // 6) register a third, admin key (via key1) so there are two admins,
    // then revoke key1, signed by the new admin key3.
    const key3Nonce = randomNonce();
    const key3Timestamp = Date.now();
    const key3NewKey = { publicKey: key3.publicKeyRaw, label: "Second admin", admin: true };
    const key3Signed = { op: "keychain-register", namespace: identity.namespace, newKey: key3NewKey, nonce: key3Nonce, timestamp: key3Timestamp, actingKeyId: key1Id };
    const key3Signature = await key1.sign(normalizeProofMessage(key3Signed));
    const registerKey3 = await post(origin, "/api/v1/keychain/keys", {
      namespace: identity.namespace,
      actingKeyId: key1Id,
      newKey: key3NewKey,
      nonce: key3Nonce,
      timestamp: key3Timestamp,
      signature: key3Signature,
    });
    expect(registerKey3.status).toBe(201);
    const key3Id = registerKey3.json.key.keyId as string;

    const revokeNonce = randomNonce();
    const revokeTimestamp = Date.now();
    const revokeSigned = { op: "keychain-revoke", namespace: identity.namespace, actingKeyId: key3Id, targetKeyId: key1Id, nonce: revokeNonce, timestamp: revokeTimestamp };
    const revokeSignature = await key3.sign(normalizeProofMessage(revokeSigned));
    const revokeRes = await post(origin, `/api/v1/keychain/keys/${key1Id}/revoke`, {
      namespace: identity.namespace,
      actingKeyId: key3Id,
      nonce: revokeNonce,
      timestamp: revokeTimestamp,
      signature: revokeSignature,
    });
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.json.key.authorization).toBe("revoked");

    // 7) confirm: a NEW operation signed by the now-revoked key1 is rejected.
    const postRevokeNonce = randomNonce();
    const postRevokeTimestamp = Date.now();
    const postRevokeSignedFields = { op: "keychain-sign", namespace: identity.namespace, keyId: key1Id, payload: { op: "ping-again" }, nonce: postRevokeNonce, timestamp: postRevokeTimestamp };
    const postRevokeSignature = await key1.sign(normalizeProofMessage(postRevokeSignedFields));
    const rejectedOp = await post(origin, `/api/v1/keychain/keys/${key1Id}/sign`, {
      namespace: identity.namespace,
      payload: { op: "ping-again" },
      nonce: postRevokeNonce,
      timestamp: postRevokeTimestamp,
      signature: postRevokeSignature,
    });
    expect(rejectedOp.status).toBe(403);
    expect(rejectedOp.json.error).toBe("ACTING_KEY_REVOKED");

    // 8) revocation also blocks admin actions, not just signing: key1
    // trying to register a fourth key must fail the same way.
    const key4 = await generateDeviceKey();
    const key4ViaRevokedNonce = randomNonce();
    const key4ViaRevokedTimestamp = Date.now();
    const key4ViaRevokedNewKey = { publicKey: key4.publicKeyRaw, label: "Should not register" };
    const key4ViaRevokedSigned = { op: "keychain-register", namespace: identity.namespace, newKey: key4ViaRevokedNewKey, nonce: key4ViaRevokedNonce, timestamp: key4ViaRevokedTimestamp, actingKeyId: key1Id };
    const key4ViaRevokedSignature = await key1.sign(normalizeProofMessage(key4ViaRevokedSigned));
    const key4ViaRevokedRes = await post(origin, "/api/v1/keychain/keys", {
      namespace: identity.namespace,
      actingKeyId: key1Id,
      newKey: key4ViaRevokedNewKey,
      nonce: key4ViaRevokedNonce,
      timestamp: key4ViaRevokedTimestamp,
      signature: key4ViaRevokedSignature,
    });
    expect(key4ViaRevokedRes.status).toBe(403);
    expect(key4ViaRevokedRes.json.error).toBe("ACTING_KEY_REVOKED");
  });

  it("rejects the first key registration when no claim exists for the namespace yet", async () => {
    const key1 = await generateDeviceKey();
    const nonce = randomNonce();
    const timestamp = Date.now();
    const newKey = { publicKey: key1.publicKeyRaw, label: "Orphan key" };
    const signedFields = { op: "keychain-register", namespace: "ghost.cleaker.me", newKey, nonce, timestamp, identityHash: "ghost" };
    const signature = await key1.sign(normalizeProofMessage(signedFields));

    const res = await post(origin, "/api/v1/keychain/keys", {
      namespace: "ghost.cleaker.me",
      identityHash: "ghost",
      newKey,
      nonce,
      timestamp,
      signature,
    });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("CLAIM_REQUIRED");
  });

  it("refuses to revoke the last remaining admin key", async () => {
    const identity = await claimTestIdentity(origin, "riley", "riley-secret");
    const key1 = await generateDeviceKey();
    const nonce = randomNonce();
    const timestamp = Date.now();
    const newKey = { publicKey: key1.publicKeyRaw, label: "Only key" };
    const signedFields = { op: "keychain-register", namespace: identity.namespace, newKey, nonce, timestamp, identityHash: identity.identityHash };
    const signature = await identity.sign(normalizeProofMessage(signedFields));
    const registerRes = await post(origin, "/api/v1/keychain/keys", {
      namespace: identity.namespace,
      identityHash: identity.identityHash,
      newKey,
      nonce,
      timestamp,
      signature,
    });
    const key1Id = registerRes.json.key.keyId as string;

    const revokeNonce = randomNonce();
    const revokeTimestamp = Date.now();
    const revokeSigned = { op: "keychain-revoke", namespace: identity.namespace, actingKeyId: key1Id, targetKeyId: key1Id, nonce: revokeNonce, timestamp: revokeTimestamp };
    const revokeSignature = await key1.sign(normalizeProofMessage(revokeSigned));
    const revokeRes = await post(origin, `/api/v1/keychain/keys/${key1Id}/revoke`, {
      namespace: identity.namespace,
      actingKeyId: key1Id,
      nonce: revokeNonce,
      timestamp: revokeTimestamp,
      signature: revokeSignature,
    });
    expect(revokeRes.status).toBe(409);
    expect(revokeRes.json.error).toBe("CANNOT_REVOKE_LAST_ADMIN");
  });

  it("recovers keychain control from the recoverable identity alone after every delegated key is lost", async () => {
    const identity = await claimTestIdentity(origin, "sasha", "sasha-secret");

    // Create the keychain and register a second, non-root admin key the
    // normal way -- standing in for "two delegated device keys now exist."
    const key1 = await generateDeviceKey();
    const key1Nonce = randomNonce();
    const key1Timestamp = Date.now();
    const key1NewKey = { publicKey: key1.publicKeyRaw, label: "Lost laptop" };
    const key1Signed = { op: "keychain-register", namespace: identity.namespace, newKey: key1NewKey, nonce: key1Nonce, timestamp: key1Timestamp, identityHash: identity.identityHash };
    const key1Signature = await identity.sign(normalizeProofMessage(key1Signed));
    const registerKey1 = await post(origin, "/api/v1/keychain/keys", {
      namespace: identity.namespace, identityHash: identity.identityHash, newKey: key1NewKey, nonce: key1Nonce, timestamp: key1Timestamp, signature: key1Signature,
    });
    const key1Id = registerKey1.json.key.keyId as string;

    const key2 = await generateDeviceKey();
    const key2Nonce = randomNonce();
    const key2Timestamp = Date.now();
    const key2NewKey = { publicKey: key2.publicKeyRaw, label: "Lost phone", admin: true };
    const key2Signed = { op: "keychain-register", namespace: identity.namespace, newKey: key2NewKey, nonce: key2Nonce, timestamp: key2Timestamp, actingKeyId: key1Id };
    const key2Signature = await key1.sign(normalizeProofMessage(key2Signed));
    const registerKey2 = await post(origin, "/api/v1/keychain/keys", {
      namespace: identity.namespace, actingKeyId: key1Id, newKey: key2NewKey, nonce: key2Nonce, timestamp: key2Timestamp, signature: key2Signature,
    });
    const key2Id = registerKey2.json.key.keyId as string;

    // Both key1's and key2's private halves are now presumed lost -- e.g.
    // both devices destroyed. Nothing in this test uses key1/key2 again.
    // The 12-word phrase (represented here by `identity`, the namespace's
    // claim) is all that is available. Bootstrap's own path is closed
    // (the keychain is no longer empty), so this must go through the
    // dedicated recovery operation.
    const bootstrapAttempt = await post(origin, "/api/v1/keychain/keys", {
      namespace: identity.namespace,
      identityHash: identity.identityHash,
      newKey: { publicKey: (await generateDeviceKey()).publicKeyRaw, label: "Should not work" },
      nonce: randomNonce(),
      timestamp: Date.now(),
      signature: "irrelevant-because-bootstrap-path-is-closed",
    });
    expect(bootstrapAttempt.status).toBe(400);
    expect(bootstrapAttempt.json.error).toBe("ACTING_KEY_REQUIRED");

    const recoveryKey = await generateDeviceKey();
    const recoveryNonce = randomNonce();
    const recoveryTimestamp = Date.now();
    const recoveryNewKey = { publicKey: recoveryKey.publicKeyRaw, label: "New device after recovery" };
    const recoverySigned = { op: "keychain-recovery", namespace: identity.namespace, identityHash: identity.identityHash, newKey: recoveryNewKey, nonce: recoveryNonce, timestamp: recoveryTimestamp };
    const recoverySignature = await identity.sign(normalizeProofMessage(recoverySigned));

    const recoverRes = await post(origin, "/api/v1/keychain/recover", {
      namespace: identity.namespace,
      identityHash: identity.identityHash,
      newKey: recoveryNewKey,
      nonce: recoveryNonce,
      timestamp: recoveryTimestamp,
      signature: recoverySignature,
    });
    expect(recoverRes.status).toBe(201);
    expect(recoverRes.json.key.authorization).toBe("active");
    expect(recoverRes.json.key.admin).toBe(true);
    const recoveredKeyId = recoverRes.json.key.keyId as string;

    // Recovery is a full reset: both previously-active keys are now
    // revoked, and exactly the new key is active.
    const listAfterRecovery = await get(origin, `/api/v1/keychain/keys?namespace=${identity.namespace}`);
    const byId = new Map(listAfterRecovery.json.keys.map((k: any) => [k.keyId, k]));
    expect((byId.get(key1Id) as any).authorization).toBe("revoked");
    expect((byId.get(key2Id) as any).authorization).toBe("revoked");
    expect((byId.get(recoveredKeyId) as any).authorization).toBe("active");

    // The keychain is fully operational again on the recovered key alone.
    const postRecoveryNonce = randomNonce();
    const postRecoveryTimestamp = Date.now();
    const postRecoverySignedFields = { op: "keychain-sign", namespace: identity.namespace, keyId: recoveredKeyId, payload: { op: "back-in-business" }, nonce: postRecoveryNonce, timestamp: postRecoveryTimestamp };
    const postRecoverySignature = await recoveryKey.sign(normalizeProofMessage(postRecoverySignedFields));
    const postRecoveryOp = await post(origin, `/api/v1/keychain/keys/${recoveredKeyId}/sign`, {
      namespace: identity.namespace,
      payload: { op: "back-in-business" },
      nonce: postRecoveryNonce,
      timestamp: postRecoveryTimestamp,
      signature: postRecoverySignature,
    });
    expect(postRecoveryOp.status).toBe(200);
  });

  it("refuses to let a generic namespace write touch keychain.* directly, even for the claim holder", async () => {
    const identity = await claimTestIdentity(origin, "toby", "toby-secret");

    // Try it via POST / (rootCommandHandler), signed exactly like any
    // other authorized write to this namespace.
    const forgedRecord = { keyId: "forged", label: "Forged admin", publicKey: "n/a", admin: true, authorization: "active", addedAt: Date.now(), addedBy: "forged" };
    const rootWriteBody = { expression: "keychain.keys.forged", value: forgedRecord };
    const rootWriteSignature = await identity.sign(normalizeProofMessage(rootWriteBody));
    const rootWriteRes = await post(origin, "/", { ...rootWriteBody, signature: rootWriteSignature });
    expect(rootWriteRes.status).toBe(403);
    expect(rootWriteRes.json.error).toBe("KEYCHAIN_PATH_REQUIRES_KEYCHAIN_API");

    // Try it via /api/v1/commit too.
    const events = [{ namespace: identity.namespace, path: "keychain.keys.forged", data: forgedRecord }];
    const signedFields = { events, identityHash: identity.identityHash, namespace: identity.namespace };
    const signature = await identity.sign(normalizeProofMessage(signedFields));
    const commitRes = await post(origin, "/api/v1/commit", { ...signedFields, signature });
    expect(commitRes.status).toBe(403);
    expect(commitRes.json.error).toBe("KEYCHAIN_PATH_REQUIRES_KEYCHAIN_API");

    // Confirm nothing landed either way.
    const list = await get(origin, `/api/v1/keychain/keys?namespace=${identity.namespace}`);
    expect(list.json.keys).toEqual([]);
  });
});
