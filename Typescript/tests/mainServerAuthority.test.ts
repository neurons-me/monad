/**
 * mainServerAuthority.test.ts -- who may change netget.main.server.name, and
 * what the operator's starting value may and may not do once a gateway is
 * claimed. Real HTTP server, real Ed25519 signing, real claims and keychain
 * keys, same as gatewayAuthority.test.ts (whose helpers this repeats).
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createMonadApp, issueInstallationAuthorization } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";
import { resetKeychainNonceCacheForTests } from "../src/claim/keychain";
import { hasAnyGatewayOwner, resetGatewayAuthorityNonceCacheForTests } from "../src/claim/gatewayAuthority";
import { MAIN_SERVER_NAME_PATH, seedMainServerName } from "../src/claim/mainServer";
import {
  deriveBranchProofSeed,
  importEd25519SigningKey,
  normalizeProofMessage,
  signEd25519Proof,
// @ts-expect-error -- no .d.ts resolution across this relative path; see gatewayAuthority.test.ts.
} from "../../../me/Typescript/dist/me.es.js";

const ROOT_NAMESPACE = "cleaker.me";
const GATEWAY_ID = "main-server-authority.local";

function createTempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-msauth-"));
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
    seed: "test-seed-msauth",
    namespace: ROOT_NAMESPACE,
    stateDir: runtime.stateDir,
    claimDir: runtime.claimDir,
    selfConfigPath: runtime.selfConfigPath,
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { server, origin: `http://127.0.0.1:${port}`, stateDir: runtime.stateDir };
}

/** Stands in for netget's own setup-code ceremony (gatewaySetupSession.ts):
 *  the ONE step that's supposed to happen only through authorized local
 *  setup, establishing which identity/namespace gets to become this
 *  never-yet-bootstrapped gatewayId's first owner. Every test below that
 *  expects a bootstrap to actually succeed must call this first for the
 *  intended owner — plain namespace+key validity is deliberately no longer
 *  enough on its own (see installationAuthorization.ts). */
function authorizeInstallation(stateDir: string, gatewayId: string, identity: { namespace: string; identityHash: string }, ttlMs = 10 * 60 * 1000) {
  const result = issueInstallationAuthorization({
    stateDir,
    gatewayId,
    namespace: identity.namespace,
    identityHash: identity.identityHash,
    expiresAt: Date.now() + ttlMs,
  });
  if (!result.ok) throw new Error(`Test setup failed: issueInstallationAuthorization returned ${result.error}`);
  return result.value;
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

async function setMainServer(
  origin: string, acting: { namespace: string }, keyId: string, key: { sign(m: string): Promise<string> }, name: string,
  overrides: { nonce?: string; tamper?: boolean } = {},
) {
  const nonce = overrides.nonce ?? randomNonce();
  const timestamp = Date.now();
  const signedFields = { op: "gateway-set-main-server", gatewayId: GATEWAY_ID, namespace: acting.namespace, name, nonce, timestamp };
  const signature = await key.sign(normalizeProofMessage(signedFields));
  return post(origin, `/api/v1/gateway/${GATEWAY_ID}/main-server`, {
    namespace: acting.namespace, actingKeyId: keyId, name: overrides.tamper ? `${name}.evil` : name, nonce, timestamp, signature,
  });
}

async function readName(origin: string) {
  const res = await fetch(`${origin}/${MAIN_SERVER_NAME_PATH}`, { headers: { "x-forwarded-host": ROOT_NAMESPACE, accept: "application/json" } });
  const json = await res.json().catch(() => null);
  return json?.target?.value;
}

describe("netget.main.server.name: owner-signed change", () => {
  let server: Server;
  let origin: string;
  let runtimeRoot: string;
  let stateDir: string;

  beforeEach(async () => {
    resetKernelStateForTests();
    resetKeychainNonceCacheForTests();
    resetGatewayAuthorityNonceCacheForTests();
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monad-msauth-cwd-"));
    const started = await startServer(runtimeRoot);
    server = started.server;
    origin = started.origin;
    stateDir = started.stateDir;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    resetKernelStateForTests();
    resetKeychainNonceCacheForTests();
    resetGatewayAuthorityNonceCacheForTests();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  async function claimedGateway() {
    const alice = await claimTestIdentity(origin, "alice", "alice-secret");
    const aliceKey = await generateDeviceKey();
    const aliceKeyId = await registerFirstKeychainKey(origin, alice, aliceKey, "Alice's laptop");
    authorizeInstallation(stateDir, GATEWAY_ID, alice);
    const res = await bootstrapGateway(origin, GATEWAY_ID, alice, aliceKeyId, aliceKey);
    expect(res.status).toBe(201);
    return { alice, aliceKey, aliceKeyId };
  }

  it("the owner's signature changes it, and the change reads back from the tree", async () => {
    const { alice, aliceKey, aliceKeyId } = await claimedGateway();
    expect(await readName(origin)).toBeUndefined();

    const res = await setMainServer(origin, alice, aliceKeyId, aliceKey, "netget.site");
    expect(res.status).toBe(200);
    expect(res.json.name).toBe("netget.site");
    expect(await readName(origin)).toBe("netget.site");

    const again = await setMainServer(origin, alice, aliceKeyId, aliceKey, "admin.example.org");
    expect(again.status).toBe(200);
    expect(await readName(origin)).toBe("admin.example.org");
  });

  it("rejects an identity with a live key but no gateway authority, and an admin who is not the owner", async () => {
    const { alice, aliceKey, aliceKeyId } = await claimedGateway();
    await setMainServer(origin, alice, aliceKeyId, aliceKey, "netget.site");

    const mallory = await claimTestIdentity(origin, "mallory", "mallory-secret");
    const malloryKey = await generateDeviceKey();
    const malloryKeyId = await registerFirstKeychainKey(origin, mallory, malloryKey, "Mallory's laptop");
    const denied = await setMainServer(origin, mallory, malloryKeyId, malloryKey, "evil.example");
    expect(denied.status).toBe(403);
    expect(denied.json.error).toBe("PERMISSION_DENIED");

    // Bob is made an admin by the owner: administers the gateway, does not move where it is administered from.
    const bob = await claimTestIdentity(origin, "bob", "bob-secret");
    const bobKey = await generateDeviceKey();
    const bobKeyId = await registerFirstKeychainKey(origin, bob, bobKey, "Bob's laptop");
    const nonce = randomNonce();
    const timestamp = Date.now();
    const grantFields = {
      op: "gateway-grant-admin", gatewayId: GATEWAY_ID, namespace: alice.namespace,
      targetIdentityHash: bob.identityHash, targetNamespace: bob.namespace, targetPublicKey: null, targetUsername: null,
      scopes: [], nonce, timestamp,
    };
    const grant = await post(origin, `/api/v1/gateway/${GATEWAY_ID}/admins`, {
      namespace: alice.namespace, actingKeyId: aliceKeyId, targetIdentityHash: bob.identityHash, targetNamespace: bob.namespace,
      targetPublicKey: null, targetUsername: null, scopes: [], nonce, timestamp,
      signature: await aliceKey.sign(normalizeProofMessage(grantFields)),
    });
    expect(grant.status).toBe(200);
    const notOwner = await setMainServer(origin, bob, bobKeyId, bobKey, "evil.example");
    expect(notOwner.status).toBe(403);
    expect(notOwner.json.error).toBe("OWNER_ONLY");

    expect(await readName(origin)).toBe("netget.site");
  });

  it("rejects a replayed request, a body altered after signing, and a value that is not a host", async () => {
    const { alice, aliceKey, aliceKeyId } = await claimedGateway();
    const nonce = randomNonce();
    expect((await setMainServer(origin, alice, aliceKeyId, aliceKey, "netget.site", { nonce })).status).toBe(200);

    const replay = await setMainServer(origin, alice, aliceKeyId, aliceKey, "other.example", { nonce });
    expect(replay.status).toBe(403);
    expect(replay.json.error).toBe("REPLAY_REJECTED");

    const tampered = await setMainServer(origin, alice, aliceKeyId, aliceKey, "other.example", { tamper: true });
    expect(tampered.status).toBe(403);
    expect(tampered.json.error).toBe("PROOF_INVALID");

    const invalid = await setMainServer(origin, alice, aliceKeyId, aliceKey, "not a host");
    expect(invalid.status).toBe(400);
    expect(invalid.json.error).toBe("MAIN_SERVER_NAME_INVALID");

    expect(await readName(origin)).toBe("netget.site");
  });

  it("a signature over one gateway id does not change another", async () => {
    const { alice, aliceKey, aliceKeyId } = await claimedGateway();
    const nonce = randomNonce();
    const timestamp = Date.now();
    const signedFields = { op: "gateway-set-main-server", gatewayId: "some-other-gateway.local", namespace: alice.namespace, name: "evil.example", nonce, timestamp };
    const res = await post(origin, `/api/v1/gateway/${GATEWAY_ID}/main-server`, {
      namespace: alice.namespace, actingKeyId: aliceKeyId, name: "evil.example", nonce, timestamp,
      signature: await aliceKey.sign(normalizeProofMessage(signedFields)),
    });
    expect(res.status).toBe(403);
    expect(await readName(origin)).toBeUndefined();
  });

  it("the operator's starting value corrects itself while unclaimed, and is ignored once a gateway has an owner", async () => {
    expect(hasAnyGatewayOwner()).toBe(false);
    expect(seedMainServerName(ROOT_NAMESPACE, "first.example", { gatewayClaimed: hasAnyGatewayOwner() })).toBe("written");
    expect(seedMainServerName(ROOT_NAMESPACE, "typo-fixed.example", { gatewayClaimed: hasAnyGatewayOwner() })).toBe("written");
    expect(await readName(origin)).toBe("typo-fixed.example");

    await claimedGateway();
    expect(hasAnyGatewayOwner()).toBe(true);
    expect(seedMainServerName(ROOT_NAMESPACE, "env-wants-this.example", { gatewayClaimed: hasAnyGatewayOwner() })).toBe("kept");
    expect(await readName(origin)).toBe("typo-fixed.example");
  });
});
