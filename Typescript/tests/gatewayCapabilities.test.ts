/**
 * gatewayCapabilities.test.ts -- capabilitiesOf/hasGatewayCapability (claim/gatewayCapabilities.ts)
 * against a REAL GatewayAuthorityRecord, produced by the real bootstrap/grant/revoke HTTP surface with
 * real Ed25519 signing (same harness pattern as gatewayAuthority.test.ts), not a hand-typed fixture.
 *
 * This is the first piece of the access guard GatewayAccessContract.md §1/§4 calls for: a capability
 * question answered from tree state, never a hardcoded list. Not yet wired into adminGate.mjs (that
 * needs every route reclassified onto a named capability, a separate, larger change) and not yet
 * reachable from netget.site's Lua side at all (still a loopback-only decision, a second, unrelated
 * rulebook -- see docs/GatewayAccessContract.md §5, §9). It is also, on its own, only NECESSARY, not
 * SUFFICIENT: this answers what an IDENTITY holds, never what a given CALLER acting as that identity
 * was itself granted -- see claim/gatewayCapabilities.ts's own header for why "owner: 'all'" describes
 * the owner's own standing, not a blanket license for every page claiming to act on the owner's behalf.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "node:crypto";
import type { AddressInfo } from "net";
import type { Server } from "http";
import {
  createMonadApp,
  issueInstallationAuthorization,
  readGatewayAuthority,
  capabilitiesOf,
  hasGatewayCapability,
} from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";
import { resetKeychainNonceCacheForTests } from "../src/claim/keychain";
import { resetGatewayAuthorityNonceCacheForTests } from "../src/claim/gatewayAuthority";
import {
  deriveBranchProofSeed,
  importEd25519SigningKey,
  normalizeProofMessage,
  signEd25519Proof,
// @ts-expect-error -- no .d.ts resolution across this relative path; see gatewayAuthority.test.ts's identical note.
} from "../../../me/Typescript/dist/me.es.js";

const ROOT_NAMESPACE = "cleaker.me";
const GATEWAY_ID = "gwcaps-test.local";

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = null;
  resetKernelStateForTests();
  resetKeychainNonceCacheForTests();
  resetGatewayAuthorityNonceCacheForTests();
});

async function start() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-gwcaps-"));
  const app = await createMonadApp({
    cwd: root, seed: "test-seed-gwcaps", namespace: ROOT_NAMESPACE,
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
async function deviceKey() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const { privateKey, publicKey } = await importEd25519SigningKey(seed);
  const publicKeyRaw = Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64url");
  return { publicKeyRaw, sign: (m: string) => signEd25519Proof(privateKey, m) };
}
async function registerKey(origin: string, identity: Awaited<ReturnType<typeof claimIdentity>>, key: Awaited<ReturnType<typeof deviceKey>>, label: string) {
  const nonce = randomNonce();
  const timestamp = Date.now();
  const newKey = { publicKey: key.publicKeyRaw, label };
  const signedFields = { op: "keychain-register", namespace: identity.namespace, newKey, nonce, timestamp, identityHash: identity.identityHash };
  const signature = await identity.sign(normalizeProofMessage(signedFields));
  const res = await post(origin, "/api/v1/keychain/keys", { namespace: identity.namespace, identityHash: identity.identityHash, newKey, nonce, timestamp, signature });
  if (res.status !== 201) throw new Error(`registerKey failed: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json.key.keyId as string;
}
async function bootstrap(origin: string, identity: Awaited<ReturnType<typeof claimIdentity>>, keyId: string, key: Awaited<ReturnType<typeof deviceKey>>) {
  const challenge = randomNonce();
  const timestamp = Date.now();
  const signedFields = { op: "netget-claim-gateway", gatewayId: GATEWAY_ID, namespace: identity.namespace, identityHash: identity.identityHash, keyId, challenge, timestamp };
  const signature = await key.sign(normalizeProofMessage(signedFields));
  return post(origin, `/api/v1/gateway/${GATEWAY_ID}/bootstrap`, { namespace: identity.namespace, identityHash: identity.identityHash, keyId, challenge, timestamp, signature });
}
async function grant(origin: string, actingNamespace: string, actingKeyId: string, actingKey: { sign(m: string): Promise<string> }, target: { identityHash: string; namespace: string }, scopes: string[]) {
  const nonce = randomNonce();
  const timestamp = Date.now();
  const signedFields = { op: "gateway-grant-admin", gatewayId: GATEWAY_ID, namespace: actingNamespace, targetIdentityHash: target.identityHash, targetNamespace: target.namespace, targetPublicKey: null, targetUsername: null, scopes, nonce, timestamp };
  const signature = await actingKey.sign(normalizeProofMessage(signedFields));
  return post(origin, `/api/v1/gateway/${GATEWAY_ID}/admins`, { namespace: actingNamespace, actingKeyId, targetIdentityHash: target.identityHash, targetNamespace: target.namespace, targetPublicKey: null, targetUsername: null, scopes, nonce, timestamp, signature });
}
async function revoke(origin: string, actingNamespace: string, actingKeyId: string, actingKey: { sign(m: string): Promise<string> }, targetIdentityHash: string) {
  const nonce = randomNonce();
  const timestamp = Date.now();
  const signedFields = { op: "gateway-revoke-admin", gatewayId: GATEWAY_ID, namespace: actingNamespace, targetIdentityHash, nonce, timestamp };
  const signature = await actingKey.sign(normalizeProofMessage(signedFields));
  return post(origin, `/api/v1/gateway/${GATEWAY_ID}/admins/${targetIdentityHash}/revoke`, { namespace: actingNamespace, actingKeyId, nonce, timestamp, signature });
}

describe("gateway capabilities read from the real, signed authority record", () => {
  it("owner: 'all', regardless of grants (bootstrap leaves the owner's own grants empty)", async () => {
    const { origin, stateDir } = await start();
    const owner = await claimIdentity(origin, "owner1", "owner-secret-0001");
    authorizeInstallation(stateDir, GATEWAY_ID, owner);
    const ownerKey = await deviceKey();
    const ownerKeyId = await registerKey(origin, owner, ownerKey, "owner device");
    const boot = await bootstrap(origin, owner, ownerKeyId, ownerKey);
    expect(boot.status, JSON.stringify(boot.json)).toBe(201);

    const record = readGatewayAuthority(GATEWAY_ID);
    expect(record?.grants[owner.identityHash]).toEqual([]); // real, confirmed: empty, not implicit-full
    expect(capabilitiesOf(record, owner.identityHash)).toBe("all");
    expect(hasGatewayCapability(record, owner.identityHash, "anything-not-explicitly-granted")).toBe(true);
  });

  it("a granted admin has EXACTLY the named scopes granted -- not more, not the owner's 'all'", async () => {
    const { origin, stateDir } = await start();
    const owner = await claimIdentity(origin, "owner2", "owner-secret-0002");
    authorizeInstallation(stateDir, GATEWAY_ID, owner);
    const ownerKey = await deviceKey();
    const ownerKeyId = await registerKey(origin, owner, ownerKey, "owner device");
    await bootstrap(origin, owner, ownerKeyId, ownerKey);

    const admin = await claimIdentity(origin, "admin2", "admin-secret-0002");
    const g = await grant(origin, owner.namespace, ownerKeyId, ownerKey, admin, ["domains:write"]);
    expect(g.status, JSON.stringify(g.json)).toBe(200);

    const record = readGatewayAuthority(GATEWAY_ID);
    const caps = capabilitiesOf(record, admin.identityHash);
    expect(caps).not.toBe("all");
    expect(caps).toEqual(new Set(["domains:write"]));
    expect(hasGatewayCapability(record, admin.identityHash, "domains:write")).toBe(true);
    expect(hasGatewayCapability(record, admin.identityHash, "openresty:control")).toBe(false);
    expect(hasGatewayCapability(record, owner.identityHash, "openresty:control")).toBe(true); // owner still 'all'
  });

  it("a revoked admin has none -- not stale scopes, not a fallback to some other capability", async () => {
    const { origin, stateDir } = await start();
    const owner = await claimIdentity(origin, "owner3", "owner-secret-0003");
    authorizeInstallation(stateDir, GATEWAY_ID, owner);
    const ownerKey = await deviceKey();
    const ownerKeyId = await registerKey(origin, owner, ownerKey, "owner device");
    await bootstrap(origin, owner, ownerKeyId, ownerKey);

    const admin = await claimIdentity(origin, "admin3", "admin-secret-0003");
    await grant(origin, owner.namespace, ownerKeyId, ownerKey, admin, ["logs:read", "openresty:control"]);
    expect(hasGatewayCapability(readGatewayAuthority(GATEWAY_ID), admin.identityHash, "logs:read")).toBe(true);

    const r = await revoke(origin, owner.namespace, ownerKeyId, ownerKey, admin.identityHash);
    expect(r.status, JSON.stringify(r.json)).toBe(200);

    const record = readGatewayAuthority(GATEWAY_ID);
    expect(capabilitiesOf(record, admin.identityHash)).toEqual(new Set());
    expect(hasGatewayCapability(record, admin.identityHash, "logs:read")).toBe(false);
    expect(hasGatewayCapability(record, admin.identityHash, "openresty:control")).toBe(false);
  });

  it("an identity with no relationship to this gateway at all has nothing, and neither does an unbootstrapped gateway", async () => {
    const { origin, stateDir } = await start();
    const owner = await claimIdentity(origin, "owner4", "owner-secret-0004");
    authorizeInstallation(stateDir, GATEWAY_ID, owner);
    const ownerKey = await deviceKey();
    const ownerKeyId = await registerKey(origin, owner, ownerKey, "owner device");
    await bootstrap(origin, owner, ownerKeyId, ownerKey);

    const stranger = await claimIdentity(origin, "stranger4", "stranger-secret-0004");
    const record = readGatewayAuthority(GATEWAY_ID);
    expect(capabilitiesOf(record, stranger.identityHash)).toEqual(new Set());
    expect(hasGatewayCapability(record, stranger.identityHash, "anything")).toBe(false);

    // a gateway nobody ever bootstrapped: readGatewayAuthority itself returns null, and the
    // capability check must fail closed, not throw
    expect(readGatewayAuthority("never-bootstrapped.local")).toBeNull();
    expect(capabilitiesOf(null, owner.identityHash)).toEqual(new Set());
    expect(hasGatewayCapability(null, owner.identityHash, "anything")).toBe(false);
  });

  it("an empty identityHash never matches anything, even against a record that has an empty-string key somehow", async () => {
    const record = { gatewayId: "x", owner: "", admins: { "": true }, grants: { "": ["whatever"] }, pubkeys: {}, usernames: {}, namespaces: {}, updatedAt: 0 } as any;
    expect(capabilitiesOf(record, "")).toEqual(new Set());
    expect(hasGatewayCapability(record, "", "whatever")).toBe(false);
  });
});
