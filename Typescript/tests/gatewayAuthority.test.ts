/**
 * gatewayAuthority.test.ts — the real walkthrough for the E+A signed
 * gateway-admin-authority mechanism (claim/gatewayAuthority.ts): bootstrap
 * -> grant -> a validly-signed-but-unauthorized identity is rejected ->
 * revoke -> transfer (owner-only) -> replay rejection -> the reserved-path
 * guard blocking a generic write into daemon.gateways.*.
 *
 * Mirrors keychainMinimalWalkthrough.test.ts's own pattern exactly: a real
 * HTTP server, real Ed25519 signing via this.me's own primitives, real
 * claims and real keychain keys — no mocks for anything security-relevant.
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createMonadApp } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";
import { resetKeychainNonceCacheForTests } from "../src/claim/keychain";
import { resetGatewayAuthorityNonceCacheForTests } from "../src/claim/gatewayAuthority";
import {
  deriveBranchProofSeed,
  importEd25519SigningKey,
  normalizeProofMessage,
  signEd25519Proof,
// @ts-expect-error -- no .d.ts resolution across this relative path; see
// keychainMinimalWalkthrough.test.ts's identical note.
} from "../../../me/Typescript/dist/me.es.js";

const ROOT_NAMESPACE = "cleaker.me";
const GATEWAY_ID = "gwauth-test.local";

function createTempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-gwauth-"));
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
    seed: "test-seed-gwauth",
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

function randomNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
}

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
  return { namespace, identityHash, sign: (message: string) => signEd25519Proof(privateKey, message) };
}

async function generateDeviceKey() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const { privateKey, publicKey } = await importEd25519SigningKey(seed);
  const publicKeyRaw = Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64url");
  return { publicKeyRaw, sign: (message: string) => signEd25519Proof(privateKey, message) };
}

type TestIdentity = Awaited<ReturnType<typeof claimTestIdentity>>;
type DeviceKey = Awaited<ReturnType<typeof generateDeviceKey>>;

/** Registers the FIRST (bootstrap, always-admin-of-its-own-keychain) key
 *  for a freshly claimed identity — matches keychainMinimalWalkthrough's
 *  own bootstrap path. This is "vigencia" material only — being able to
 *  administer one's OWN keychain says nothing about gateway authority. */
async function registerFirstKeychainKey(origin: string, identity: TestIdentity, key: DeviceKey, label: string) {
  const nonce = randomNonce();
  const timestamp = Date.now();
  const newKey = { publicKey: key.publicKeyRaw, label };
  const signedFields = { op: "keychain-register", namespace: identity.namespace, newKey, nonce, timestamp, identityHash: identity.identityHash };
  const signature = await identity.sign(normalizeProofMessage(signedFields));
  const res = await post(origin, "/api/v1/keychain/keys", {
    namespace: identity.namespace, identityHash: identity.identityHash, newKey, nonce, timestamp, signature,
  });
  if (res.status !== 201) throw new Error(`Test setup failed: keychain register returned ${res.status} ${JSON.stringify(res.json)}`);
  return res.json.key.keyId as string;
}

async function bootstrapGateway(origin: string, gatewayId: string, identity: TestIdentity, keyId: string, key: DeviceKey) {
  const challenge = randomNonce();
  const timestamp = Date.now();
  const signedFields = { op: "netget-claim-gateway", gatewayId, namespace: identity.namespace, identityHash: identity.identityHash, keyId, challenge, timestamp };
  const signature = await key.sign(normalizeProofMessage(signedFields));
  return post(origin, `/api/v1/gateway/${gatewayId}/bootstrap`, {
    namespace: identity.namespace, identityHash: identity.identityHash, keyId, challenge, timestamp, signature,
  });
}

async function grantAdmin(
  origin: string, gatewayId: string, actingNamespace: string, actingKeyId: string, actingKey: { sign(m: string): Promise<string> },
  target: { identityHash: string; namespace: string; publicKey?: string; username?: string }, scopes: string[],
) {
  const nonce = randomNonce();
  const timestamp = Date.now();
  const signedFields = {
    op: "gateway-grant-admin", gatewayId, namespace: actingNamespace,
    targetIdentityHash: target.identityHash, targetNamespace: target.namespace,
    targetPublicKey: target.publicKey ?? null, targetUsername: target.username ?? null,
    scopes, nonce, timestamp,
  };
  const signature = await actingKey.sign(normalizeProofMessage(signedFields));
  return post(origin, `/api/v1/gateway/${gatewayId}/admins`, {
    namespace: actingNamespace, actingKeyId,
    targetIdentityHash: target.identityHash, targetNamespace: target.namespace,
    targetPublicKey: target.publicKey ?? null, targetUsername: target.username ?? null,
    scopes, nonce, timestamp, signature,
  });
}

async function revokeAdmin(
  origin: string, gatewayId: string, actingNamespace: string, actingKeyId: string, actingKey: { sign(m: string): Promise<string> }, targetIdentityHash: string,
) {
  const nonce = randomNonce();
  const timestamp = Date.now();
  const signedFields = { op: "gateway-revoke-admin", gatewayId, namespace: actingNamespace, targetIdentityHash, nonce, timestamp };
  const signature = await actingKey.sign(normalizeProofMessage(signedFields));
  return post(origin, `/api/v1/gateway/${gatewayId}/admins/${targetIdentityHash}/revoke`, {
    namespace: actingNamespace, actingKeyId, nonce, timestamp, signature,
  });
}

async function transferOwner(
  origin: string, gatewayId: string, actingNamespace: string, actingKeyId: string, actingKey: { sign(m: string): Promise<string> }, targetIdentityHash: string,
) {
  const nonce = randomNonce();
  const timestamp = Date.now();
  const signedFields = { op: "gateway-transfer-owner", gatewayId, namespace: actingNamespace, targetIdentityHash, nonce, timestamp };
  const signature = await actingKey.sign(normalizeProofMessage(signedFields));
  return post(origin, `/api/v1/gateway/${gatewayId}/transfer`, {
    namespace: actingNamespace, actingKeyId, targetIdentityHash, nonce, timestamp, signature,
  });
}

describe("gatewayAuthority: signed bootstrap/grant/revoke/transfer", () => {
  let server: Server;
  let origin: string;
  let runtimeRoot: string;

  beforeEach(async () => {
    resetKernelStateForTests();
    resetKeychainNonceCacheForTests();
    resetGatewayAuthorityNonceCacheForTests();
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monad-gwauth-cwd-"));
    const started = await startServer(runtimeRoot);
    server = started.server;
    origin = started.origin;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    resetKernelStateForTests();
    resetKeychainNonceCacheForTests();
    resetGatewayAuthorityNonceCacheForTests();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it("runs the full bootstrap -> grant -> revoke -> transfer walkthrough, plus the negative cases", async () => {
    // ── bootstrap ──────────────────────────────────────────────────────
    const alice = await claimTestIdentity(origin, "alice", "alice-secret");
    const aliceKey = await generateDeviceKey();
    const aliceKeyId = await registerFirstKeychainKey(origin, alice, aliceKey, "Alice's laptop");

    const bootstrapRes = await bootstrapGateway(origin, GATEWAY_ID, alice, aliceKeyId, aliceKey);
    expect(bootstrapRes.status).toBe(201);
    expect(bootstrapRes.json.record.owner).toBe(alice.identityHash);
    expect(bootstrapRes.json.record.admins[alice.identityHash]).toBe(true);

    // Public read confirms the same state.
    const readAfterBootstrap = await get(origin, `/api/v1/gateway/${GATEWAY_ID}/authority`);
    expect(readAfterBootstrap.json.record.owner).toBe(alice.identityHash);

    // A second bootstrap attempt by a DIFFERENT identity must fail —
    // first-write-wins, matching materializeFromNamespaceClaim's own invariant.
    const mallory = await claimTestIdentity(origin, "mallory", "mallory-secret");
    const malloryKey = await generateDeviceKey();
    const malloryKeyId = await registerFirstKeychainKey(origin, mallory, malloryKey, "Mallory's laptop");
    const secondBootstrap = await bootstrapGateway(origin, GATEWAY_ID, mallory, malloryKeyId, malloryKey);
    expect(secondBootstrap.status).toBe(409);
    expect(secondBootstrap.json.error).toBe("ALREADY_BOOTSTRAPPED");

    // Re-bootstrapping with the SAME owner identity is a safe no-op
    // (this is the migration path for an already-namespace-derived install).
    const rebootstrap = await bootstrapGateway(origin, GATEWAY_ID, alice, aliceKeyId, aliceKey);
    expect(rebootstrap.status).toBe(201);
    expect(rebootstrap.json.record.owner).toBe(alice.identityHash);

    // ── the exact "vigencia ≠ autorización" case ─────────────────────────
    // Mallory has a perfectly live, active keychain key (registered above)
    // but holds NO gateway authority. A validly-signed grant from her must
    // still be rejected.
    const bob = await claimTestIdentity(origin, "bob", "bob-secret");
    const unauthorizedGrant = await grantAdmin(
      origin, GATEWAY_ID, mallory.namespace, malloryKeyId, malloryKey,
      { identityHash: bob.identityHash, namespace: bob.namespace }, ["apps:read"],
    );
    expect(unauthorizedGrant.status).toBe(403);
    expect(unauthorizedGrant.json.error).toBe("PERMISSION_DENIED");

    // ── grant, by the real owner ─────────────────────────────────────────
    const grantRes = await grantAdmin(
      origin, GATEWAY_ID, alice.namespace, aliceKeyId, aliceKey,
      { identityHash: bob.identityHash, namespace: bob.namespace, username: "bob" }, ["apps:read"],
    );
    expect(grantRes.status).toBe(200);
    expect(grantRes.json.record.admins[bob.identityHash]).toBe(true);
    expect(grantRes.json.record.grants[bob.identityHash]).toEqual(["apps:read"]);
    expect(grantRes.json.record.usernames[bob.identityHash]).toBe("bob");

    // Replay of the exact same grant request must be rejected — same
    // nonce, even though the underlying action already succeeded once.
    // (grantAdmin() above already consumed its own nonce; re-derive the
    // exact same signed body here to prove replay is actually enforced.)
    {
      const nonce = randomNonce();
      const timestamp = Date.now();
      const signedFields = { op: "gateway-grant-admin", gatewayId: GATEWAY_ID, namespace: alice.namespace, targetIdentityHash: bob.identityHash, targetNamespace: bob.namespace, targetPublicKey: null, targetUsername: null, scopes: ["apps:read"], nonce, timestamp };
      const signature = await aliceKey.sign(normalizeProofMessage(signedFields));
      const body = { namespace: alice.namespace, actingKeyId: aliceKeyId, targetIdentityHash: bob.identityHash, targetNamespace: bob.namespace, targetPublicKey: null, targetUsername: null, scopes: ["apps:read"], nonce, timestamp, signature };
      const first = await post(origin, `/api/v1/gateway/${GATEWAY_ID}/admins`, body);
      expect(first.status).toBe(200);
      const replay = await post(origin, `/api/v1/gateway/${GATEWAY_ID}/admins`, body);
      expect(replay.status).toBe(403);
      expect(replay.json.error).toBe("REPLAY_REJECTED");
    }

    // Bob (now a real gateway admin) can grant a third identity himself.
    const bobKey = await generateDeviceKey();
    const bobKeyId = await registerFirstKeychainKey(origin, bob, bobKey, "Bob's laptop");
    const carol = await claimTestIdentity(origin, "carol", "carol-secret");
    const bobGrant = await grantAdmin(
      origin, GATEWAY_ID, bob.namespace, bobKeyId, bobKey,
      { identityHash: carol.identityHash, namespace: carol.namespace }, ["domains:read"],
    );
    expect(bobGrant.status).toBe(200);
    expect(bobGrant.json.record.admins[carol.identityHash]).toBe(true);

    // ── revoke ────────────────────────────────────────────────────────
    // The owner cannot be revoked.
    const revokeOwnerAttempt = await revokeAdmin(origin, GATEWAY_ID, bob.namespace, bobKeyId, bobKey, alice.identityHash);
    expect(revokeOwnerAttempt.status).toBe(409);
    expect(revokeOwnerAttempt.json.error).toBe("CANNOT_REVOKE_OWNER");

    // Alice revokes Carol.
    const revokeCarol = await revokeAdmin(origin, GATEWAY_ID, alice.namespace, aliceKeyId, aliceKey, carol.identityHash);
    expect(revokeCarol.status).toBe(200);
    expect(revokeCarol.json.record.admins[carol.identityHash]).toBeUndefined();

    // ── transfer: owner-only ──────────────────────────────────────────
    // Bob (an admin, not the owner) cannot transfer ownership.
    const nonOwnerTransfer = await transferOwner(origin, GATEWAY_ID, bob.namespace, bobKeyId, bobKey, bob.identityHash);
    expect(nonOwnerTransfer.status).toBe(403);
    expect(nonOwnerTransfer.json.error).toBe("OWNER_ONLY");

    // Transferring to a non-admin is rejected.
    const nonAdminTransfer = await transferOwner(origin, GATEWAY_ID, alice.namespace, aliceKeyId, aliceKey, carol.identityHash);
    expect(nonAdminTransfer.status).toBe(400);
    expect(nonAdminTransfer.json.error).toBe("TARGET_NOT_ADMIN");

    // Alice (the real owner) transfers to Bob (a real admin).
    const transferRes = await transferOwner(origin, GATEWAY_ID, alice.namespace, aliceKeyId, aliceKey, bob.identityHash);
    expect(transferRes.status).toBe(200);
    expect(transferRes.json.record.owner).toBe(bob.identityHash);

    // Alice, no longer owner, can no longer transfer.
    const aliceTransferAfter = await transferOwner(origin, GATEWAY_ID, alice.namespace, aliceKeyId, aliceKey, alice.identityHash);
    expect(aliceTransferAfter.status).toBe(403);
    expect(aliceTransferAfter.json.error).toBe("OWNER_ONLY");
  });

  it("refuses to let a generic namespace write touch daemon.gateways.* directly, even for a real claim holder", async () => {
    const alice = await claimTestIdentity(origin, "dana", "dana-secret");

    const forgedRecord = { gatewayId: GATEWAY_ID, owner: "dana", admins: { dana: true }, grants: {}, pubkeys: {}, usernames: {}, namespaces: {}, updatedAt: Date.now() };
    const rootWriteBody = { expression: `daemon.gateways.${GATEWAY_ID}`, value: forgedRecord };
    const rootWriteSignature = await alice.sign(normalizeProofMessage(rootWriteBody));
    const rootWriteRes = await post(origin, "/", { ...rootWriteBody, signature: rootWriteSignature });
    expect(rootWriteRes.status).toBe(403);
    expect(rootWriteRes.json.error).toBe("GATEWAY_PATH_REQUIRES_GATEWAY_API");

    const events = [{ namespace: alice.namespace, path: `daemon.gateways.${GATEWAY_ID}`, data: forgedRecord }];
    const signedFields = { events, identityHash: alice.identityHash, namespace: alice.namespace };
    const signature = await alice.sign(normalizeProofMessage(signedFields));
    const commitRes = await post(origin, "/api/v1/commit", { ...signedFields, signature });
    expect(commitRes.status).toBe(403);
    expect(commitRes.json.error).toBe("GATEWAY_PATH_REQUIRES_GATEWAY_API");

    const read = await get(origin, `/api/v1/gateway/${GATEWAY_ID}/authority`);
    expect(read.json.record).toBeNull();
  });
});
