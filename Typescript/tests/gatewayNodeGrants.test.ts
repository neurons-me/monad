/**
 * gatewayNodeGrants.test.ts — the exact case flagged in review, live-verified: an admin grants an app a
 * gateway operation, is then revoked as admin, and the app must lose that access too -- even though its
 * node grant is still unexpired/unrevoked, and even though the admin's own keychain key is still active.
 * "Vigencia de la llave" alone is not enough; this proves the identity's CURRENT gateway standing is
 * what actually gates the action, re-read fresh on every single call, not cached from grant time.
 *
 * Real HTTP throughout: identity claims, keychain keys, gateway bootstrap/grant-admin/revoke-admin (the
 * exact harness gatewayCapabilities.test.ts already established), and the new guard route itself
 * (POST /api/v1/gateway/:gatewayId/node-grants/act). grantNodeAccess/revokeNodeAccess are still called
 * in-process (no HTTP surface for granting/revoking a node grant exists yet, unchanged from
 * nodeGrants.test.ts). No mocks for anything security-relevant.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "node:crypto";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createMonadApp, issueInstallationAuthorization } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";
import { resetKeychainNonceCacheForTests, getKeychainKey } from "../src/claim/keychain";
import { resetGatewayAuthorityNonceCacheForTests } from "../src/claim/gatewayAuthority";
import { grantNodeAccess, verifyExecutorAction, resetNodeGrantNonceCacheForTests } from "../src/claim/nodeGrants";
import { verifyExecutorGatewayAction } from "../src/claim/gatewayNodeGrants";
import {
  deriveBranchProofSeed,
  importEd25519SigningKey,
  normalizeProofMessage,
  signEd25519Proof,
// @ts-expect-error -- no .d.ts resolution across this relative path; see gatewayAuthority.test.ts's identical note.
} from "../../../me/Typescript/dist/me.es.js";

const ROOT_NAMESPACE = "cleaker.me";
const GATEWAY_ID = "gwnodegrants-test.local";

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = null;
  resetKernelStateForTests();
  resetKeychainNonceCacheForTests();
  resetGatewayAuthorityNonceCacheForTests();
  resetNodeGrantNonceCacheForTests();
});

async function start() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-gwnodegrants-"));
  const app = await createMonadApp({
    cwd: root, seed: "test-seed-gwnodegrants", namespace: ROOT_NAMESPACE,
    stateDir: path.join(root, "me-state"), claimDir: path.join(root, "claims"), selfConfigPath: path.join(root, "self.json"),
  });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = (server.address() as AddressInfo).port;
  return { origin: `http://127.0.0.1:${port}`, stateDir: path.join(root, "me-state") };
}

function randomNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
}
async function post(origin: string, urlPath: string, body: unknown) {
  const res = await fetch(`${origin}${urlPath}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
function authorizeInstallation(stateDir: string, gatewayId: string, identity: { namespace: string; identityHash: string }) {
  const result = issueInstallationAuthorization({ stateDir, gatewayId, namespace: identity.namespace, identityHash: identity.identityHash, expiresAt: Date.now() + 600_000 });
  if (!result.ok) throw new Error(`authorizeInstallation failed: ${result.error}`);
}
async function claimIdentity(origin: string, username: string, secret: string) {
  const namespace = `${username}.${ROOT_NAMESPACE}`;
  const identityHash = username;
  const branchSeed = await deriveBranchProofSeed(secret, username);
  const { privateKey, publicKey } = await importEd25519SigningKey(branchSeed);
  const publicKeyRaw = Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64url");
  const timestamp = Date.now();
  const proofPayload = { identityHash, expression: username, namespace, rootNamespace: ROOT_NAMESPACE, challenge: null, timestamp };
  const proofMessage = normalizeProofMessage(proofPayload);
  const proofSignature = await signEd25519Proof(privateKey, proofMessage);
  const res = await post(origin, "/", { operation: "claim", namespace, secret, identityHash, proof: { message: proofMessage, signature: proofSignature, publicKey: publicKeyRaw, timestamp } });
  if (res.status !== 201) throw new Error(`claim failed: ${res.status} ${JSON.stringify(res.json)}`);
  return { namespace, identityHash, sign: (m: string) => signEd25519Proof(privateKey, m) };
}
async function freshKeypair() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const { privateKey, publicKey } = await importEd25519SigningKey(seed);
  const publicKeyRaw = Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64url");
  return { publicKeyRaw, sign: (m: string) => signEd25519Proof(privateKey, m) };
}
async function registerKey(origin: string, identity: Awaited<ReturnType<typeof claimIdentity>>, key: Awaited<ReturnType<typeof freshKeypair>>, label: string) {
  const nonce = randomNonce();
  const timestamp = Date.now();
  const newKey = { publicKey: key.publicKeyRaw, label };
  const signedFields = { op: "keychain-register", namespace: identity.namespace, newKey, nonce, timestamp, identityHash: identity.identityHash };
  const signature = await identity.sign(normalizeProofMessage(signedFields));
  const res = await post(origin, "/api/v1/keychain/keys", { namespace: identity.namespace, identityHash: identity.identityHash, newKey, nonce, timestamp, signature });
  if (res.status !== 201) throw new Error(`registerKey failed: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json.key.keyId as string;
}
async function bootstrapGateway(origin: string, owner: Awaited<ReturnType<typeof claimIdentity>>, keyId: string, key: Awaited<ReturnType<typeof freshKeypair>>) {
  const challenge = randomNonce();
  const timestamp = Date.now();
  const signedFields = { op: "netget-claim-gateway", gatewayId: GATEWAY_ID, namespace: owner.namespace, identityHash: owner.identityHash, keyId, challenge, timestamp };
  const signature = await key.sign(normalizeProofMessage(signedFields));
  const res = await post(origin, `/api/v1/gateway/${GATEWAY_ID}/bootstrap`, { namespace: owner.namespace, identityHash: owner.identityHash, keyId, challenge, timestamp, signature });
  if (res.status !== 201) throw new Error(`bootstrapGateway failed: ${res.status} ${JSON.stringify(res.json)}`);
}
async function grantGatewayAdmin(origin: string, actingNamespace: string, actingKeyId: string, actingKey: { sign(m: string): Promise<string> }, target: { identityHash: string; namespace: string }, scopes: string[]) {
  const nonce = randomNonce();
  const timestamp = Date.now();
  const signedFields = { op: "gateway-grant-admin", gatewayId: GATEWAY_ID, namespace: actingNamespace, targetIdentityHash: target.identityHash, targetNamespace: target.namespace, targetPublicKey: null, targetUsername: null, scopes, nonce, timestamp };
  const signature = await actingKey.sign(normalizeProofMessage(signedFields));
  const res = await post(origin, `/api/v1/gateway/${GATEWAY_ID}/admins`, { namespace: actingNamespace, actingKeyId, targetIdentityHash: target.identityHash, targetNamespace: target.namespace, targetPublicKey: null, targetUsername: null, scopes, nonce, timestamp, signature });
  if (res.status !== 200) throw new Error(`grantGatewayAdmin failed: ${res.status} ${JSON.stringify(res.json)}`);
}
async function revokeGatewayAdmin(origin: string, actingNamespace: string, actingKeyId: string, actingKey: { sign(m: string): Promise<string> }, targetIdentityHash: string) {
  const nonce = randomNonce();
  const timestamp = Date.now();
  const signedFields = { op: "gateway-revoke-admin", gatewayId: GATEWAY_ID, namespace: actingNamespace, targetIdentityHash, nonce, timestamp };
  const signature = await actingKey.sign(normalizeProofMessage(signedFields));
  const res = await post(origin, `/api/v1/gateway/${GATEWAY_ID}/admins/${targetIdentityHash}/revoke`, { namespace: actingNamespace, actingKeyId, nonce, timestamp, signature });
  if (res.status !== 200) throw new Error(`revokeGatewayAdmin failed: ${res.status} ${JSON.stringify(res.json)}`);
}
async function grantNode(
  granter: Awaited<ReturnType<typeof claimIdentity>>,
  granterKey: Awaited<ReturnType<typeof freshKeypair>>,
  granterKeyId: string,
  grantId: string,
  nodePath: string,
  operations: string[],
  executorPublicKeyRaw: string,
) {
  const nonce = randomNonce();
  const timestamp = Date.now();
  const signedFields = { op: "node-grant", namespace: granter.namespace, nodePath, operations, executorPublicKey: executorPublicKeyRaw, grantId, nonce, timestamp };
  const signature = await granterKey.sign(normalizeProofMessage(signedFields));
  return grantNodeAccess({
    grantId, namespace: granter.namespace, nodePath, operations, executorPublicKey: executorPublicKeyRaw,
    appLabel: "Test Gateway App", grantingKeyId: granterKeyId, nonce, timestamp, signature,
  });
}
async function signExecutorAct(executor: Awaited<ReturnType<typeof freshKeypair>>, namespace: string, nodePath: string, grantId: string, operation: string, target: string) {
  const nonce = randomNonce();
  const timestamp = Date.now();
  const signedFields = { op: "node-grant-act", grantId, namespace, nodePath, operation, target, params: null, nonce, timestamp };
  const signature = await executor.sign(normalizeProofMessage(signedFields));
  return { grantId, operation, target, nonce, timestamp, signature };
}

describe("gateway node-grant guard: identity capability AND live node grant, both required", () => {
  it("THE CASE: an admin grants an app a gateway operation, the admin is then revoked -- the app loses access too, even though its node grant is untouched and the admin's keychain key is still active", async () => {
    const { origin, stateDir } = await start();

    const owner = await claimIdentity(origin, "gwowner1", "gwowner-secret-1");
    authorizeInstallation(stateDir, GATEWAY_ID, owner);
    const ownerKey = await freshKeypair();
    const ownerKeyId = await registerKey(origin, owner, ownerKey, "owner device");
    await bootstrapGateway(origin, owner, ownerKeyId, ownerKey);

    const admin = await claimIdentity(origin, "gwadmin1", "gwadmin-secret-1");
    await grantGatewayAdmin(origin, owner.namespace, ownerKeyId, ownerKey, admin, ["domains:write"]);
    const adminKey = await freshKeypair();
    const adminKeyId = await registerKey(origin, admin, adminKey, "admin device");

    // The admin (not the owner) delegates the ONE capability it holds to an app's executor, scoped to
    // this gateway's own control coordinate.
    const executor = await freshKeypair();
    const grantId = crypto.randomUUID();
    const nodePath = `daemon.gateways.${GATEWAY_ID}`;
    const granted = await grantNode(admin, adminKey, adminKeyId, grantId, nodePath, ["domains:write"], executor.publicKeyRaw);
    expect(granted.ok, JSON.stringify(granted)).toBe(true);

    // Before revocation: the guard allows it, over real HTTP.
    const act1 = await signExecutorAct(executor, admin.namespace, nodePath, grantId, "domains:write", nodePath);
    const before = await post(origin, `/api/v1/gateway/${GATEWAY_ID}/node-grants/act`, { namespace: admin.namespace, ...act1 });
    expect(before.status, JSON.stringify(before.json)).toBe(200);
    expect(before.json).toEqual({ ok: true, gatewayId: GATEWAY_ID, operation: "domains:write" });

    // The owner revokes the admin's gateway-admin status. The admin's own keychain key is untouched.
    await revokeGatewayAdmin(origin, owner.namespace, ownerKeyId, ownerKey, admin.identityHash);
    const adminKeychainKey = getKeychainKey(admin.namespace, adminKeyId);
    expect(adminKeychainKey?.authorization).toBe("active"); // vigencia alone says nothing here

    // The SAME app, presenting a fresh, genuinely valid signature over its still-unexpired, still-
    // unrevoked node grant, is now refused -- because the GRANTER no longer holds the capability.
    const act2 = await signExecutorAct(executor, admin.namespace, nodePath, grantId, "domains:write", nodePath);
    const after = await post(origin, `/api/v1/gateway/${GATEWAY_ID}/node-grants/act`, { namespace: admin.namespace, ...act2 });
    expect(after.status, JSON.stringify(after.json)).toBe(403);
    expect(after.json?.error).toBe("IDENTITY_CAPABILITY_MISSING");

    // Contrast, proving WHERE the failure comes from: the node grant alone, checked in isolation
    // (verifyExecutorAction, no gateway-capability check at all), still succeeds -- the grant record
    // itself was never touched. The combined guard is what closes this, not nodeGrants.ts on its own.
    const act3 = await signExecutorAct(executor, admin.namespace, nodePath, grantId, "domains:write", nodePath);
    const nodeGrantAlone = verifyExecutorAction(admin.namespace, act3);
    expect(nodeGrantAlone.ok, JSON.stringify(nodeGrantAlone)).toBe(true);
  });

  it("AND, never OR: the identity's capability alone is not enough if the app's own grant doesn't include the operation", async () => {
    const { origin, stateDir } = await start();
    const owner = await claimIdentity(origin, "gwowner2", "gwowner-secret-2");
    authorizeInstallation(stateDir, GATEWAY_ID, owner);
    const ownerKey = await freshKeypair();
    const ownerKeyId = await registerKey(origin, owner, ownerKey, "owner device");
    await bootstrapGateway(origin, owner, ownerKeyId, ownerKey);
    // Owner holds 'all' -- but the executor's own grant only ever names 'logs:read'.
    const executor = await freshKeypair();
    const grantId = crypto.randomUUID();
    const nodePath = `daemon.gateways.${GATEWAY_ID}`;
    const granted = await grantNode(owner, ownerKey, ownerKeyId, grantId, nodePath, ["logs:read"], executor.publicKeyRaw);
    expect(granted.ok).toBe(true);

    const act = await signExecutorAct(executor, owner.namespace, nodePath, grantId, "domains:write", nodePath);
    const res = await post(origin, `/api/v1/gateway/${GATEWAY_ID}/node-grants/act`, { namespace: owner.namespace, ...act });
    expect(res.status).toBe(403);
    expect(res.json?.error).toBe("NOT_GRANTED");
  });

  it("a plain-node grant cannot satisfy a gateway check just because its opaque operations string collides with a real capability name", async () => {
    const { origin, stateDir } = await start();
    const owner = await claimIdentity(origin, "gwowner3", "gwowner-secret-3");
    authorizeInstallation(stateDir, GATEWAY_ID, owner);
    const ownerKey = await freshKeypair();
    const ownerKeyId = await registerKey(origin, owner, ownerKey, "owner device");
    await bootstrapGateway(origin, owner, ownerKeyId, ownerKey);

    // A grant over an ordinary namespace node, whose operations array HAPPENS to contain the same string
    // as a real gateway capability -- must not be usable as a gateway grant, because its nodePath is not
    // under daemon.gateways.<gatewayId> at all.
    const executor = await freshKeypair();
    const grantId = crypto.randomUUID();
    const granted = await grantNode(owner, ownerKey, ownerKeyId, grantId, "dashboard.status", ["domains:write"], executor.publicKeyRaw);
    expect(granted.ok).toBe(true);

    const act = await signExecutorAct(executor, owner.namespace, "dashboard.status", grantId, "domains:write", "dashboard.status");
    const res = await post(origin, `/api/v1/gateway/${GATEWAY_ID}/node-grants/act`, { namespace: owner.namespace, ...act, target: "dashboard.status" });
    expect(res.status).toBe(403);
    expect(res.json?.error).toBe("NOT_GRANTED");
  });

  it("the owner's own 'all' standing still works through a node grant the owner itself issued", async () => {
    const { origin, stateDir } = await start();
    const owner = await claimIdentity(origin, "gwowner4", "gwowner-secret-4");
    authorizeInstallation(stateDir, GATEWAY_ID, owner);
    const ownerKey = await freshKeypair();
    const ownerKeyId = await registerKey(origin, owner, ownerKey, "owner device");
    await bootstrapGateway(origin, owner, ownerKeyId, ownerKey);

    const executor = await freshKeypair();
    const grantId = crypto.randomUUID();
    const nodePath = `daemon.gateways.${GATEWAY_ID}.domains`; // a narrower sub-path -- still covered
    const granted = await grantNode(owner, ownerKey, ownerKeyId, grantId, nodePath, ["domains:write"], executor.publicKeyRaw);
    expect(granted.ok).toBe(true);

    const act = await signExecutorAct(executor, owner.namespace, nodePath, grantId, "domains:write", nodePath);
    const res = await post(origin, `/api/v1/gateway/${GATEWAY_ID}/node-grants/act`, { namespace: owner.namespace, ...act });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({ ok: true, gatewayId: GATEWAY_ID, operation: "domains:write" });
  });

  it("an unbootstrapped/unknown gateway grants nothing, regardless of the node grant's own validity", async () => {
    const { origin } = await start();
    const owner = await claimIdentity(origin, "gwowner5", "gwowner-secret-5");
    const ownerKey = await freshKeypair();
    const ownerKeyId = await registerKey(origin, owner, ownerKey, "owner device");
    // No bootstrap at all -- readGatewayAuthority returns null for this gatewayId.
    const executor = await freshKeypair();
    const grantId = crypto.randomUUID();
    const nodePath = "daemon.gateways.never-bootstrapped.local";
    const granted = await grantNode(owner, ownerKey, ownerKeyId, grantId, nodePath, ["domains:write"], executor.publicKeyRaw);
    expect(granted.ok).toBe(true);

    const act = await signExecutorAct(executor, owner.namespace, nodePath, grantId, "domains:write", nodePath);
    const res = await post(origin, `/api/v1/gateway/never-bootstrapped.local/node-grants/act`, { namespace: owner.namespace, ...act });
    expect(res.status).toBe(403);
    expect(res.json?.error).toBe("IDENTITY_CAPABILITY_MISSING");
  });
});
