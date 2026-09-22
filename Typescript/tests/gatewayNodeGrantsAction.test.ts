/**
 * gatewayNodeGrantsAction.test.ts — the connected operation gatewayNodeGrants.test.ts's own guard was
 * still missing (review correction, 2026-09-22): `POST /.../node-grants/act` only ever returned a
 * verdict. This proves the first REAL, mutating operation behind that same guard --
 * `POST /api/v1/gateway/:gatewayId/node-grants/admins/:targetIdentityHash/revoke` -- actually changes
 * gateway-authority state, not just an "ok", and that:
 *   - the server decides the required capability (REVOKE_ADMIN_CAPABILITY), never the caller;
 *   - the executor's signature covers the exact mutation parameters, so it cannot be replayed against a
 *     different target;
 *   - checking and applying happen in the one call, off the one signed request -- no separate "spend the
 *     verdict elsewhere" step exists to skip;
 *   - the PRE-EXISTING identity-signed revoke route is untouched and still enforces its own check exactly
 *     as before -- this new route is additive, not a bypass.
 *
 * Real HTTP throughout, real Ed25519 signing, real gateway-authority state read back after every mutation
 * (or attempted one) to confirm what actually happened on disk, not just the HTTP status code.
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
import { resetKeychainNonceCacheForTests } from "../src/claim/keychain";
import { resetGatewayAuthorityNonceCacheForTests, readGatewayAuthority } from "../src/claim/gatewayAuthority";
import { grantNodeAccess, resetNodeGrantNonceCacheForTests } from "../src/claim/nodeGrants";
import { REVOKE_ADMIN_CAPABILITY } from "../src/claim/gatewayNodeGrants";
import {
  deriveBranchProofSeed,
  importEd25519SigningKey,
  normalizeProofMessage,
  signEd25519Proof,
// @ts-expect-error -- no .d.ts resolution across this relative path; see gatewayAuthority.test.ts's identical note.
} from "../../../me/Typescript/dist/me.es.js";

const ROOT_NAMESPACE = "cleaker.me";
const GATEWAY_ID = "gwnodegrants-action-test.local";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-gwnodegrants-action-"));
  const app = await createMonadApp({
    cwd: root, seed: "test-seed-gwnodegrants-action", namespace: ROOT_NAMESPACE,
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
async function revokeGatewayAdminDirect(origin: string, actingNamespace: string, actingKeyId: string, actingKey: { sign(m: string): Promise<string> }, targetIdentityHash: string) {
  const nonce = randomNonce();
  const timestamp = Date.now();
  const signedFields = { op: "gateway-revoke-admin", gatewayId: GATEWAY_ID, namespace: actingNamespace, targetIdentityHash, nonce, timestamp };
  const signature = await actingKey.sign(normalizeProofMessage(signedFields));
  return post(origin, `/api/v1/gateway/${GATEWAY_ID}/admins/${targetIdentityHash}/revoke`, { namespace: actingNamespace, actingKeyId, nonce, timestamp, signature });
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
    appLabel: "Test Admin-Managing App", grantingKeyId: granterKeyId, nonce, timestamp, signature,
  });
}
/** Signs the exact node-grant-act payload the delegated revoke-admin action verifies against --
 *  operation is ALWAYS REVOKE_ADMIN_CAPABILITY (the server's own fixed requirement, never client-chosen),
 *  target is always the gateway's own control coordinate, and `targetIdentityHash` is the real mutation
 *  parameter, inside `params`, exactly as gatewayNodeGrants.ts's revokeGatewayAdminViaNodeGrant builds it. */
async function signRevokeAdminAct(executor: Awaited<ReturnType<typeof freshKeypair>>, delegatingNamespace: string, grantId: string, targetIdentityHash: string) {
  const nonce = randomNonce();
  const timestamp = Date.now();
  const nodePath = `daemon.gateways.${GATEWAY_ID}`;
  const signedFields = { op: "node-grant-act", grantId, namespace: delegatingNamespace, nodePath, operation: REVOKE_ADMIN_CAPABILITY, target: nodePath, params: { targetIdentityHash }, nonce, timestamp };
  const signature = await executor.sign(normalizeProofMessage(signedFields));
  return { grantId, nonce, timestamp, signature };
}
async function postRevokeAdminAction(origin: string, delegatingNamespace: string, targetIdentityHash: string, signed: { grantId: string; nonce: string; timestamp: number; signature: string }) {
  return post(origin, `/api/v1/gateway/${GATEWAY_ID}/node-grants/admins/${targetIdentityHash}/revoke`, { namespace: delegatingNamespace, ...signed });
}

describe("connected operation: delegated revoke-admin actually mutates gateway-authority state", () => {
  it("check AND apply in one call: a real, unrelated admin is genuinely removed from the record -- not just an HTTP 200", async () => {
    const { origin, stateDir } = await start();
    const owner = await claimIdentity(origin, "acowner1", "acowner-secret-1");
    authorizeInstallation(stateDir, GATEWAY_ID, owner);
    const ownerKey = await freshKeypair();
    const ownerKeyId = await registerKey(origin, owner, ownerKey, "owner device");
    await bootstrapGateway(origin, owner, ownerKeyId, ownerKey);

    // The delegating admin holds EXACTLY the capability this action requires.
    const admin = await claimIdentity(origin, "acadmin1", "acadmin-secret-1");
    await grantGatewayAdmin(origin, owner.namespace, ownerKeyId, ownerKey, admin, [REVOKE_ADMIN_CAPABILITY]);
    const adminKey = await freshKeypair();
    const adminKeyId = await registerKey(origin, admin, adminKey, "admin device");

    // A third, unrelated admin -- the actual TARGET of the delegated revoke.
    const victim = await claimIdentity(origin, "acvictim1", "acvictim-secret-1");
    await grantGatewayAdmin(origin, owner.namespace, ownerKeyId, ownerKey, victim, ["logs:read"]);
    expect(readGatewayAuthority(GATEWAY_ID)?.admins[victim.identityHash]).toBe(true);

    const executor = await freshKeypair();
    const grantId = crypto.randomUUID();
    const granted = await grantNode(admin, adminKey, adminKeyId, grantId, `daemon.gateways.${GATEWAY_ID}`, [REVOKE_ADMIN_CAPABILITY], executor.publicKeyRaw);
    expect(granted.ok).toBe(true);

    const signed = await signRevokeAdminAct(executor, admin.namespace, grantId, victim.identityHash);
    const res = await postRevokeAdminAction(origin, admin.namespace, victim.identityHash, signed);
    expect(res.status, JSON.stringify(res.json)).toBe(200);

    // The REAL effect: victim is genuinely gone from every field revokeGatewayAdmin itself clears.
    const record = readGatewayAuthority(GATEWAY_ID)!;
    expect(record.admins[victim.identityHash]).toBeUndefined();
    expect(record.grants[victim.identityHash]).toBeUndefined();
    // And the delegating admin's OWN standing is untouched -- this action only ever affects the target.
    expect(record.admins[admin.identityHash]).toBe(true);
  });

  it("the signature covers the exact mutation parameter -- cannot be replayed against a DIFFERENT target by only changing the URL", async () => {
    const { origin, stateDir } = await start();
    const owner = await claimIdentity(origin, "acowner2", "acowner-secret-2");
    authorizeInstallation(stateDir, GATEWAY_ID, owner);
    const ownerKey = await freshKeypair();
    const ownerKeyId = await registerKey(origin, owner, ownerKey, "owner device");
    await bootstrapGateway(origin, owner, ownerKeyId, ownerKey);
    const admin = await claimIdentity(origin, "acadmin2", "acadmin-secret-2");
    await grantGatewayAdmin(origin, owner.namespace, ownerKeyId, ownerKey, admin, [REVOKE_ADMIN_CAPABILITY]);
    const adminKey = await freshKeypair();
    const adminKeyId = await registerKey(origin, admin, adminKey, "admin device");

    const victimA = await claimIdentity(origin, "acvictima2", "acvictima-secret-2");
    const victimB = await claimIdentity(origin, "acvictimb2", "acvictimb-secret-2");
    await grantGatewayAdmin(origin, owner.namespace, ownerKeyId, ownerKey, victimA, ["logs:read"]);
    await grantGatewayAdmin(origin, owner.namespace, ownerKeyId, ownerKey, victimB, ["logs:read"]);

    const executor = await freshKeypair();
    const grantId = crypto.randomUUID();
    await grantNode(admin, adminKey, adminKeyId, grantId, `daemon.gateways.${GATEWAY_ID}`, [REVOKE_ADMIN_CAPABILITY], executor.publicKeyRaw);

    // Sign for victimA, submit the request against victimB's URL -- must fail, and victimB must be untouched.
    const signedForA = await signRevokeAdminAct(executor, admin.namespace, grantId, victimA.identityHash);
    const res = await postRevokeAdminAction(origin, admin.namespace, victimB.identityHash, signedForA);
    expect(res.status).toBe(403);
    expect(res.json?.error).toBe("PROOF_INVALID");

    const record = readGatewayAuthority(GATEWAY_ID)!;
    expect(record.admins[victimA.identityHash]).toBe(true); // untouched -- the signed request never matched this URL either
    expect(record.admins[victimB.identityHash]).toBe(true); // untouched -- the one it WAS aimed at was rejected

    // The genuine request, signed and submitted for the SAME target, works.
    const genuineSigned = await signRevokeAdminAct(executor, admin.namespace, grantId, victimA.identityHash);
    const genuineRes = await postRevokeAdminAction(origin, admin.namespace, victimA.identityHash, genuineSigned);
    expect(genuineRes.status, JSON.stringify(genuineRes.json)).toBe(200);
    expect(readGatewayAuthority(GATEWAY_ID)!.admins[victimA.identityHash]).toBeUndefined();
  });

  it("no reusable verdict: the exact same signed request cannot be replayed to revoke twice, and a stale check is never trusted separately from applying it", async () => {
    const { origin, stateDir } = await start();
    const owner = await claimIdentity(origin, "acowner3", "acowner-secret-3");
    authorizeInstallation(stateDir, GATEWAY_ID, owner);
    const ownerKey = await freshKeypair();
    const ownerKeyId = await registerKey(origin, owner, ownerKey, "owner device");
    await bootstrapGateway(origin, owner, ownerKeyId, ownerKey);
    const admin = await claimIdentity(origin, "acadmin3", "acadmin-secret-3");
    await grantGatewayAdmin(origin, owner.namespace, ownerKeyId, ownerKey, admin, [REVOKE_ADMIN_CAPABILITY]);
    const adminKey = await freshKeypair();
    const adminKeyId = await registerKey(origin, admin, adminKey, "admin device");
    const victim = await claimIdentity(origin, "acvictim3", "acvictim-secret-3");
    await grantGatewayAdmin(origin, owner.namespace, ownerKeyId, ownerKey, victim, ["logs:read"]);

    const executor = await freshKeypair();
    const grantId = crypto.randomUUID();
    await grantNode(admin, adminKey, adminKeyId, grantId, `daemon.gateways.${GATEWAY_ID}`, [REVOKE_ADMIN_CAPABILITY], executor.publicKeyRaw);

    const signed = await signRevokeAdminAct(executor, admin.namespace, grantId, victim.identityHash);
    const first = await postRevokeAdminAction(origin, admin.namespace, victim.identityHash, signed);
    expect(first.status, JSON.stringify(first.json)).toBe(200);

    // Replaying the EXACT same request -- same nonce, same signature -- a second time.
    const second = await postRevokeAdminAction(origin, admin.namespace, victim.identityHash, signed);
    expect(second.status).toBe(409);
    expect(second.json?.error).toBe("REPLAY_REJECTED");
  });

  it("the identity's capability is checked fresh on THIS action too: revoke the admin's own standing, and its delegated revoke-admin action stops working -- on a DIFFERENT target it never touched before", async () => {
    const { origin, stateDir } = await start();
    const owner = await claimIdentity(origin, "acowner4", "acowner-secret-4");
    authorizeInstallation(stateDir, GATEWAY_ID, owner);
    const ownerKey = await freshKeypair();
    const ownerKeyId = await registerKey(origin, owner, ownerKey, "owner device");
    await bootstrapGateway(origin, owner, ownerKeyId, ownerKey);
    const admin = await claimIdentity(origin, "acadmin4", "acadmin-secret-4");
    await grantGatewayAdmin(origin, owner.namespace, ownerKeyId, ownerKey, admin, [REVOKE_ADMIN_CAPABILITY]);
    const adminKey = await freshKeypair();
    const adminKeyId = await registerKey(origin, admin, adminKey, "admin device");
    const victim = await claimIdentity(origin, "acvictim4", "acvictim-secret-4");
    await grantGatewayAdmin(origin, owner.namespace, ownerKeyId, ownerKey, victim, ["logs:read"]);

    const executor = await freshKeypair();
    const grantId = crypto.randomUUID();
    await grantNode(admin, adminKey, adminKeyId, grantId, `daemon.gateways.${GATEWAY_ID}`, [REVOKE_ADMIN_CAPABILITY], executor.publicKeyRaw);

    // The owner revokes the DELEGATING admin's own gateway-admin status.
    const ownerRevoke = await revokeGatewayAdminDirect(origin, owner.namespace, ownerKeyId, ownerKey, admin.identityHash);
    expect(ownerRevoke.status, JSON.stringify(ownerRevoke.json)).toBe(200);

    // The executor's node grant is still perfectly intact -- attempt the SAME kind of real action, fresh
    // signature, against `victim`, who was never touched before.
    const signed = await signRevokeAdminAct(executor, admin.namespace, grantId, victim.identityHash);
    const res = await postRevokeAdminAction(origin, admin.namespace, victim.identityHash, signed);
    expect(res.status).toBe(403);
    expect(res.json?.error).toBe("IDENTITY_CAPABILITY_MISSING");

    // And victim's real state is untouched -- no partial mutation happened before the check failed.
    expect(readGatewayAuthority(GATEWAY_ID)!.admins[victim.identityHash]).toBe(true);
  });

  it("cannot revoke the owner through the delegated path either", async () => {
    const { origin, stateDir } = await start();
    const owner = await claimIdentity(origin, "acowner5", "acowner-secret-5");
    authorizeInstallation(stateDir, GATEWAY_ID, owner);
    const ownerKey = await freshKeypair();
    const ownerKeyId = await registerKey(origin, owner, ownerKey, "owner device");
    await bootstrapGateway(origin, owner, ownerKeyId, ownerKey);

    // The owner delegates its OWN 'all' standing to an executor.
    const executor = await freshKeypair();
    const grantId = crypto.randomUUID();
    await grantNode(owner, ownerKey, ownerKeyId, grantId, `daemon.gateways.${GATEWAY_ID}`, [REVOKE_ADMIN_CAPABILITY], executor.publicKeyRaw);

    const signed = await signRevokeAdminAct(executor, owner.namespace, grantId, owner.identityHash);
    const res = await postRevokeAdminAction(origin, owner.namespace, owner.identityHash, signed);
    expect(res.status).toBe(403);
    expect(res.json?.error).toBe("CANNOT_REVOKE_OWNER");
    expect(readGatewayAuthority(GATEWAY_ID)!.owner).toBe(owner.identityHash);
  });

  it("the PRE-EXISTING identity-signed revoke route is untouched -- an executor's own signature is not accepted there, no bypass was introduced", async () => {
    const { origin, stateDir } = await start();
    const owner = await claimIdentity(origin, "acowner6", "acowner-secret-6");
    authorizeInstallation(stateDir, GATEWAY_ID, owner);
    const ownerKey = await freshKeypair();
    const ownerKeyId = await registerKey(origin, owner, ownerKey, "owner device");
    await bootstrapGateway(origin, owner, ownerKeyId, ownerKey);
    const admin = await claimIdentity(origin, "acadmin6", "acadmin-secret-6");
    await grantGatewayAdmin(origin, owner.namespace, ownerKeyId, ownerKey, admin, [REVOKE_ADMIN_CAPABILITY]);
    const adminKey = await freshKeypair();
    const adminKeyId = await registerKey(origin, admin, adminKey, "admin device");
    const victim = await claimIdentity(origin, "acvictim6", "acvictim-secret-6");
    await grantGatewayAdmin(origin, owner.namespace, ownerKeyId, ownerKey, victim, ["logs:read"]);

    const executor = await freshKeypair();
    const grantId = crypto.randomUUID();
    await grantNode(admin, adminKey, adminKeyId, grantId, `daemon.gateways.${GATEWAY_ID}`, [REVOKE_ADMIN_CAPABILITY], executor.publicKeyRaw);

    // The OLD route (POST /api/v1/gateway/:gatewayId/admins/:id/revoke) still requires actingKeyId +
    // a keychain-key signature. Present the executor's own node-grant-style signature there instead --
    // it must be rejected exactly as it always would be for any unrecognized/missing acting key, and
    // victim must remain untouched.
    const nonce = randomNonce();
    const timestamp = Date.now();
    const forgedSignedFields = { op: "gateway-revoke-admin", gatewayId: GATEWAY_ID, namespace: admin.namespace, targetIdentityHash: victim.identityHash, nonce, timestamp };
    const forgedSignature = await executor.sign(normalizeProofMessage(forgedSignedFields));
    const res = await post(origin, `/api/v1/gateway/${GATEWAY_ID}/admins/${victim.identityHash}/revoke`, {
      namespace: admin.namespace, actingKeyId: grantId, // an executor has no keychain key -- the closest
      // thing it could try passing off as one is its own grantId, which getKeychainKey will simply not find
      nonce, timestamp, signature: forgedSignature,
    });
    expect(res.status).not.toBe(200);
    expect(readGatewayAuthority(GATEWAY_ID)!.admins[victim.identityHash]).toBe(true);
  });

  it("no lost update under REAL concurrent requests -- two different targets revoked at the same time both land", async () => {
    const { origin, stateDir } = await start();
    const owner = await claimIdentity(origin, "acowner7", "acowner-secret-7");
    authorizeInstallation(stateDir, GATEWAY_ID, owner);
    const ownerKey = await freshKeypair();
    const ownerKeyId = await registerKey(origin, owner, ownerKey, "owner device");
    await bootstrapGateway(origin, owner, ownerKeyId, ownerKey);
    const admin = await claimIdentity(origin, "acadmin7", "acadmin-secret-7");
    await grantGatewayAdmin(origin, owner.namespace, ownerKeyId, ownerKey, admin, [REVOKE_ADMIN_CAPABILITY]);
    const adminKey = await freshKeypair();
    const adminKeyId = await registerKey(origin, admin, adminKey, "admin device");

    const victimA = await claimIdentity(origin, "acvictima7", "acvictima-secret-7");
    const victimB = await claimIdentity(origin, "acvictimb7", "acvictimb-secret-7");
    await grantGatewayAdmin(origin, owner.namespace, ownerKeyId, ownerKey, victimA, ["logs:read"]);
    await grantGatewayAdmin(origin, owner.namespace, ownerKeyId, ownerKey, victimB, ["logs:read"]);
    expect(readGatewayAuthority(GATEWAY_ID)!.admins[victimA.identityHash]).toBe(true);
    expect(readGatewayAuthority(GATEWAY_ID)!.admins[victimB.identityHash]).toBe(true);

    const executor = await freshKeypair();
    const grantId = crypto.randomUUID();
    await grantNode(admin, adminKey, adminKeyId, grantId, `daemon.gateways.${GATEWAY_ID}`, [REVOKE_ADMIN_CAPABILITY], executor.publicKeyRaw);

    // Two DIFFERENT mutating requests, dispatched together (Promise.all -- both fetch() calls in flight
    // at the same time, not one awaited before the other starts), against the SAME grant, SAME record.
    // If checking and applying were not effectively atomic per request (e.g. a naive
    // read-modify-write over two independently-held copies of the record), one revoke could silently
    // overwrite/lose the other's mutation. Node's single-threaded event loop plus the fact that neither
    // this handler nor anything it calls ever awaits (grepped: zero `await` in the whole check->persist
    // chain) means each request's JS execution runs to completion before the next one starts -- this
    // test exercises that guarantee against the real HTTP server, not just asserts it from reading the
    // source.
    const [signedA, signedB] = await Promise.all([
      signRevokeAdminAct(executor, admin.namespace, grantId, victimA.identityHash),
      signRevokeAdminAct(executor, admin.namespace, grantId, victimB.identityHash),
    ]);
    const [resA, resB] = await Promise.all([
      postRevokeAdminAction(origin, admin.namespace, victimA.identityHash, signedA),
      postRevokeAdminAction(origin, admin.namespace, victimB.identityHash, signedB),
    ]);
    expect(resA.status, JSON.stringify(resA.json)).toBe(200);
    expect(resB.status, JSON.stringify(resB.json)).toBe(200);

    // BOTH mutations landed -- neither request's write was lost to the other's.
    const record = readGatewayAuthority(GATEWAY_ID)!;
    expect(record.admins[victimA.identityHash]).toBeUndefined();
    expect(record.admins[victimB.identityHash]).toBeUndefined();
  });
});
