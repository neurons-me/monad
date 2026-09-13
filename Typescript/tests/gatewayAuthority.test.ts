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
import { createMonadApp, issueInstallationAuthorization, readInstallationAuthorization } from "../src/index";
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

/** Claims an ARBITRARY, fully-specified namespace string — unlike
 *  claimTestIdentity() above, does not force the `<username>.ROOT_NAMESPACE`
 *  shape. Used to construct the "claimed a namespace with a foreign root"
 *  scenario: claimNamespace() itself enforces nothing about the namespace's
 *  relationship to this monad's own configured identity, only first-claim-
 *  wins on the raw string. */
async function claimArbitraryIdentity(origin: string, namespace: string, identityHash: string, secret: string, rootNamespace: string) {
  const branchSeed = await deriveBranchProofSeed(secret, namespace);
  const { privateKey, publicKey } = await importEd25519SigningKey(branchSeed);
  const publicKeyRaw = Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64url");
  const timestamp = Date.now();
  const proofPayload = { identityHash, expression: identityHash, namespace, rootNamespace, challenge: null, timestamp };
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
    throw new Error(`Test setup failed: arbitrary claim returned ${claimRes.status} ${JSON.stringify(claimRes.json)}`);
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
  let stateDir: string;

  beforeEach(async () => {
    resetKernelStateForTests();
    resetKeychainNonceCacheForTests();
    resetGatewayAuthorityNonceCacheForTests();
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monad-gwauth-cwd-"));
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

  it("runs the full bootstrap -> grant -> revoke -> transfer walkthrough, plus the negative cases", async () => {
    // ── bootstrap ──────────────────────────────────────────────────────
    const alice = await claimTestIdentity(origin, "alice", "alice-secret");
    const aliceKey = await generateDeviceKey();
    const aliceKeyId = await registerFirstKeychainKey(origin, alice, aliceKey, "Alice's laptop");

    // Stands in for netget's own setup-code ceremony authorizing Alice,
    // specifically, as this never-yet-bootstrapped gatewayId's intended
    // first owner -- without this, her otherwise perfectly valid namespace
    // claim + active key would no longer be enough on its own.
    authorizeInstallation(stateDir, GATEWAY_ID, alice);

    const bootstrapRes = await bootstrapGateway(origin, GATEWAY_ID, alice, aliceKeyId, aliceKey);
    expect(bootstrapRes.status).toBe(201);
    expect(bootstrapRes.json.record.owner).toBe(alice.identityHash);
    expect(bootstrapRes.json.record.admins[alice.identityHash]).toBe(true);
    expect(readInstallationAuthorization(stateDir, GATEWAY_ID)?.status).toBe("consumed");

    // Public read confirms the same state.
    const readAfterBootstrap = await get(origin, `/api/v1/gateway/${GATEWAY_ID}/authority`);
    expect(readAfterBootstrap.json.record.owner).toBe(alice.identityHash);

    // A second bootstrap attempt by a DIFFERENT identity must fail —
    // the installation is already durably bound to Alice, and even a
    // fresh, valid installation authorization for Mallory would not
    // override an already-bootstrapped owner (ALREADY_BOOTSTRAPPED is
    // checked before installation authorization is even consulted).
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

  it("rejects a bootstrap attempt whose namespace claims an unrelated (bare, foreign) root string on this same monad", async () => {
    // Confirms the fix for a real gap found in review: bootstrapGatewayAuthority
    // previously only checked "does SOME namespace claim + active key exist" —
    // with no relationship verified between that namespace and THIS
    // installation. Attempted end-to-end with a real claim: a BARE foreign
    // root namespace (no prefix) CAN be claimed here (claimNamespace() doesn't
    // gate on root relationship), but confirms the SEPARATE, pre-existing
    // finding from investigation -- registering an active keychain key
    // against that same bare foreign namespace is rejected (FOREIGN_NAMESPACE_REJECTED,
    // from appendSemanticMemory's existing guard) -- so this specific HTTP path
    // can't even reach bootstrap with an active key. That's WHY the direct unit
    // test below exists: the "real claim + real active key + genuinely foreign
    // namespace" precondition bootstrapGatewayAuthority's own check defends
    // against is not constructible through the standard claim+keychain flow
    // today, but the check is still real, explicit, local defense-in-depth per
    // isNamespaceLocalToThisInstallation()'s own doc comment.
    const foreignNamespace = "totally-different-root.example";
    const attacker = await claimArbitraryIdentity(
      origin,
      foreignNamespace,
      "attacker",
      "attacker-secret",
      foreignNamespace,
    );
    const attackerKey = await generateDeviceKey();
    const newKey = { publicKey: attackerKey.publicKeyRaw, label: "Attacker's laptop" };
    const nonce = randomNonce();
    const timestamp = Date.now();
    const signedFields = { op: "keychain-register", namespace: attacker.namespace, newKey, nonce, timestamp, identityHash: attacker.identityHash };
    const signature = await attacker.sign(normalizeProofMessage(signedFields));
    const keychainRes = await post(origin, "/api/v1/keychain/keys", {
      namespace: attacker.namespace, identityHash: attacker.identityHash, newKey, nonce, timestamp, signature,
    });
    // A genuinely valid signature, correctly bound (not a "sign A, send B"
    // mismatch) — rejected purely because the namespace is foreign to this
    // monad. Previously this uncaught FOREIGN_NAMESPACE_REJECTED throw inside
    // appendSemanticMemory surfaced as a bare 500 with no JSON body; keychain.ts
    // now catches it at every write call site and keychainHandler.ts maps it
    // to this clean, structured response -- same status/shape as
    // commandHandler.ts's and syncHandler.ts's existing handling of the exact
    // same rejection on their own write paths.
    expect(keychainRes.status).toBe(403);
    expect(keychainRes.json.ok).toBe(false);
    expect(keychainRes.json.error).toBe("FOREIGN_NAMESPACE_REJECTED");
    expect(typeof keychainRes.json.detail).toBe("string");
    expect(keychainRes.json.detail.length).toBeGreaterThan(0);
  });

  it("[direct unit test] isNamespaceLocalToThisInstallation rejects namespaces rooted elsewhere and accepts this monad's own root", async () => {
    // Direct import, no HTTP -- see the function's own doc comment and the
    // test immediately above for why an end-to-end HTTP repro of the
    // rejected case isn't constructible through the real claim+keychain
    // flow (a separate, pre-existing guard already blocks obtaining an
    // active key for a genuinely foreign namespace). This test instead
    // proves the guard function itself is correct in isolation, so
    // bootstrapGatewayAuthority's reliance on it is real, not vacuous.
    const { isNamespaceLocalToThisInstallation } = await import("../src/claim/gatewayAuthority.js");
    expect(isNamespaceLocalToThisInstallation(`someone.${ROOT_NAMESPACE}`)).toBe(true);
    expect(isNamespaceLocalToThisInstallation(ROOT_NAMESPACE)).toBe(true);
    expect(isNamespaceLocalToThisInstallation("someone.totally-different-root.example")).toBe(false);
    expect(isNamespaceLocalToThisInstallation("totally-different-root.example")).toBe(false);
  });

  it("lets only the installation-authorized identity win, even when raced concurrently against an unauthorized identity's own valid, signed attempt", async () => {
    // Replaces this test's old "first-write-wins, exactly one winner"
    // framing -- under the installation-authorization gate there is no
    // legitimate race to win at all: only whoever the local setup actually
    // authorized can EVER succeed, regardless of which concurrent request's
    // synchronous handler happens to run first. racerb here is exactly as
    // "valid" as racera (real claim, real active key, same root) -- the
    // only difference is that racera, and only racera, was authorized.
    const raceGatewayId = "race-condition-test.local";
    const racera = await claimTestIdentity(origin, "racera", "racera-secret");
    const raceraKey = await generateDeviceKey();
    const raceraKeyId = await registerFirstKeychainKey(origin, racera, raceraKey, "Racer A's laptop");

    const racerb = await claimTestIdentity(origin, "racerb", "racerb-secret");
    const racerbKey = await generateDeviceKey();
    const racerbKeyId = await registerFirstKeychainKey(origin, racerb, racerbKey, "Racer B's laptop");

    // Only racera is authorized -- issued before either request fires, so
    // the outcome can never depend on request ordering at the HTTP layer.
    authorizeInstallation(stateDir, raceGatewayId, racera);

    const [resA, resB] = await Promise.all([
      bootstrapGateway(origin, raceGatewayId, racera, raceraKeyId, raceraKey),
      bootstrapGateway(origin, raceGatewayId, racerb, racerbKeyId, racerbKey),
    ]);

    const outcomes = [resA, resB];
    const winners = outcomes.filter((r) => r.status === 201);
    const losers = outcomes.filter((r) => r.status !== 201);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(winners[0]).toBe(resA);
    // Depending on which request's synchronous handler runs first, racerb
    // is rejected while the authorization is still "pending" (name
    // mismatch), after racera has already consumed it (CONSUMED), or after
    // racera's durable owner is already recorded (ALREADY_BOOTSTRAPPED,
    // checked even earlier than installation authorization) -- all three
    // are a correct rejection; none of them ever let racerb through.
    expect([
      "INSTALLATION_AUTHORIZATION_MISMATCH",
      "INSTALLATION_AUTHORIZATION_CONSUMED",
      "ALREADY_BOOTSTRAPPED",
    ]).toContain(losers[0]!.json.error);

    // The persisted record must show EXACTLY the authorized winner as
    // owner — never a torn/mixed state from two near-simultaneous writes —
    // and the authorization itself must end up cleanly consumed, not stuck
    // "in-flight" or double-applied.
    const read = await get(origin, `/api/v1/gateway/${raceGatewayId}/authority`);
    expect(read.json.record.owner).toBe(racera.identityHash);
    expect(Object.keys(read.json.record.admins)).toEqual([racera.identityHash]);
    const finalAuth = readInstallationAuthorization(stateDir, raceGatewayId);
    expect(finalAuth?.status).toBe("consumed");
    expect(finalAuth?.identityHash).toBe(racera.identityHash);
  });

  it("rejects a bootstrap attempt with no installation authorization at all, even for a genuinely valid same-root identity and key (regression: this used to first-write-win)", async () => {
    // This is the exact gap this session's own investigation found and
    // this whole mechanism closes: a never-yet-bootstrapped gatewayId with
    // NO installation authorization issued for it must reject EVERY
    // attempt, not just foreign-namespace ones -- there is no first-user-
    // wins fallback left anywhere in this path.
    const freshGatewayId = "gwauth-first-bootstrap-investigation.local";

    const before = await get(origin, `/api/v1/gateway/${freshGatewayId}/authority`);
    expect(before.json.record).toBeNull();
    expect(readInstallationAuthorization(stateDir, freshGatewayId)).toBeNull();

    const eve = await claimTestIdentity(origin, "eve-investigator", "eve-investigator-secret");
    const eveKey = await generateDeviceKey();
    const eveKeyId = await registerFirstKeychainKey(origin, eve, eveKey, "Eve's laptop");
    expect(eve.namespace.endsWith(`.${ROOT_NAMESPACE}`)).toBe(true);

    const eveBootstrap = await bootstrapGateway(origin, freshGatewayId, eve, eveKeyId, eveKey);
    expect(eveBootstrap.status).toBe(403);
    expect(eveBootstrap.json.error).toBe("INSTALLATION_AUTHORIZATION_REQUIRED");

    const after = await get(origin, `/api/v1/gateway/${freshGatewayId}/authority`);
    expect(after.json.record).toBeNull();

    // The legitimate operator can still complete setup afterwards, using
    // the exact same identity/key, once actually authorized.
    authorizeInstallation(stateDir, freshGatewayId, eve);
    const authorizedBootstrap = await bootstrapGateway(origin, freshGatewayId, eve, eveKeyId, eveKey);
    expect(authorizedBootstrap.status).toBe(201);
    expect(authorizedBootstrap.json.record.owner).toBe(eve.identityHash);
  });

  it("rejects a same-root, non-owner identity's direct bootstrap attempt against an ALREADY-bootstrapped installation, for lack of installation authority", async () => {
    // This is a DIFFERENT guarantee from the two tests above, and must not be
    // inferred from either of them:
    //   - The "foreign namespace" test proves a namespace that doesn't
    //     belong to THIS installation's own root gets rejected. It says
    //     nothing about someone who DOES share this installation's root.
    //   - The concurrent-race test proves bootstrap is atomic — exactly one
    //     winner from two simultaneous attempts on an EMPTY gatewayId. That
    //     is a property of the race itself, not of authorization: it never
    //     establishes that the winner was entitled to win, nor that a LATER
    //     same-root claimant is rejected for anything other than losing a
    //     timing race.
    // What this test isolates: belonging to the same root namespace is not
    // the same as administering this specific installation. Eve has a
    // completely valid identity claim and a completely valid, currently
    // active keychain key -- both rooted in the exact same ROOT_NAMESPACE
    // as the already-bootstrapped owner. She calls the Monad's bootstrap
    // endpoint DIRECTLY (bootstrapGateway() posts straight to
    // /api/v1/gateway/:id/bootstrap; there is no netget setup-session,
    // challenge, or authorization step anywhere in this test -- these tests
    // never invoke netget at all). She must still be rejected, specifically
    // because she has no authority over THIS installation (ALREADY_BOOTSTRAPPED,
    // not PROOF_INVALID, IDENTITY_MISMATCH, or NAMESPACE_NOT_LOCAL_TO_THIS_INSTALLATION
    // -- this is authorization failing, not proof or namespace-locality failing).
    const ownerGatewayId = "gwauth-installation-authority-test.local";

    const owner = await claimTestIdentity(origin, "owner-of-record", "owner-of-record-secret");
    const ownerKey = await generateDeviceKey();
    const ownerKeyId = await registerFirstKeychainKey(origin, owner, ownerKey, "Owner's laptop");
    authorizeInstallation(stateDir, ownerGatewayId, owner);
    const ownerBootstrap = await bootstrapGateway(origin, ownerGatewayId, owner, ownerKeyId, ownerKey);
    expect(ownerBootstrap.status).toBe(201);
    expect(ownerBootstrap.json.record.owner).toBe(owner.identityHash);

    // Eve: same ROOT_NAMESPACE as owner-of-record (both resolve to
    // <username>.cleaker.me via claimTestIdentity), genuinely her own
    // identity and her own currently-active key -- nothing forged, nothing
    // borrowed, nothing foreign about her namespace.
    const eve = await claimTestIdentity(origin, "eve", "eve-secret");
    const eveKey = await generateDeviceKey();
    const eveKeyId = await registerFirstKeychainKey(origin, eve, eveKey, "Eve's laptop");
    expect(eve.namespace.endsWith(`.${ROOT_NAMESPACE}`)).toBe(true);
    expect(eve.namespace).not.toBe(owner.namespace);

    const eveBootstrap = await bootstrapGateway(origin, ownerGatewayId, eve, eveKeyId, eveKey);
    expect(eveBootstrap.status).toBe(409);
    expect(eveBootstrap.json.error).toBe("ALREADY_BOOTSTRAPPED");
    // Specifically NOT rejected on any of the other axes a valid-signature,
    // same-root claimant could otherwise be confused with:
    expect(eveBootstrap.json.error).not.toBe("NAMESPACE_NOT_LOCAL_TO_THIS_INSTALLATION");
    expect(eveBootstrap.json.error).not.toBe("PROOF_INVALID");
    expect(eveBootstrap.json.error).not.toBe("IDENTITY_MISMATCH");

    // The installation's real owner is untouched by eve's rejected attempt.
    const read = await get(origin, `/api/v1/gateway/${ownerGatewayId}/authority`);
    expect(read.json.record.owner).toBe(owner.identityHash);
    expect(Object.keys(read.json.record.admins)).toEqual([owner.identityHash]);
  });

  it("recovers cleanly when the durable persist fails AFTER the installation authorization was consumed but BEFORE the owner reached disk", async () => {
    // A REAL filesystem failure (the kernel state dir made unwritable),
    // not a mock — forces saveSnapshotOrThrow() to genuinely throw exactly
    // where a crash between "in-flight" and "durably persisted" would.
    // Per the review's own ordering requirement: the authorization must go
    // back to "pending" (safe retry), and the in-memory phantom write
    // kernelSet already made must never be mistaken for a durable owner.
    const crashGatewayId = "gwauth-crash-before-persist.local";
    const carol = await claimTestIdentity(origin, "carol-crash", "carol-crash-secret");
    const carolKey = await generateDeviceKey();
    const carolKeyId = await registerFirstKeychainKey(origin, carol, carolKey, "Carol's laptop");
    authorizeInstallation(stateDir, crashGatewayId, carol);

    fs.chmodSync(stateDir, 0o500); // read+execute only — writeFileSync must fail
    try {
      const failedBootstrap = await bootstrapGateway(origin, crashGatewayId, carol, carolKeyId, carolKey);
      expect(failedBootstrap.status).toBe(500);
      expect(failedBootstrap.json.error).toBe("INSTALLATION_AUTHORIZATION_PERSIST_FAILED");
    } finally {
      fs.chmodSync(stateDir, 0o700); // restore before any further read/write in this test
    }

    // Never durably persisted -- the phantom in-memory kernelSet must not
    // be visible through the durable-verified read the next attempt relies on.
    const afterFailure = await get(origin, `/api/v1/gateway/${crashGatewayId}/authority`);
    expect(afterFailure.json.record).toBeNull();
    expect(readInstallationAuthorization(stateDir, crashGatewayId)?.status).toBe("pending");

    // A genuine retry (fresh challenge/signature — the failed attempt's
    // nonce is already spent, same as any other rejected attempt) by the
    // SAME authorized identity succeeds normally.
    const retryBootstrap = await bootstrapGateway(origin, crashGatewayId, carol, carolKeyId, carolKey);
    expect(retryBootstrap.status).toBe(201);
    expect(retryBootstrap.json.record.owner).toBe(carol.identityHash);
    expect(readInstallationAuthorization(stateDir, crashGatewayId)?.status).toBe("consumed");
  });

  it("[direct unit test] beginInstallationAuthorizationConsumption reclaims an in-flight record against durable truth, never against elapsed time", async () => {
    // bootstrapGatewayAuthority() itself never reaches this branch in
    // practice: it already checks readDurableGatewayAuthority() BEFORE
    // ever calling beginInstallationAuthorizationConsumption, so a durable
    // owner short-circuits to ALREADY_BOOTSTRAPPED/idempotent-success
    // earlier, without touching the authorization file at all. This test
    // exercises installationAuthorization.ts's own reclaim logic directly
    // (as this file's own established "[direct unit test]" convention
    // does elsewhere), so it stays correct on its own terms for any other
    // caller — not because today's one caller happens to need it.
    const { beginInstallationAuthorizationConsumption, finalizeInstallationAuthorization } =
      await import("../src/claim/installationAuthorization.js");

    const dana = await claimTestIdentity(origin, "dana-reclaim", "dana-reclaim-secret");
    const reclaimGatewayId = "gwauth-reclaim-after-durable-write.local";
    authorizeInstallation(stateDir, reclaimGatewayId, dana);

    // Hand-roll exactly the state a crash between a confirmed durable write
    // and finalizeInstallationAuthorization("consumed") would leave behind:
    // the file still says "in-flight", nothing has marked it done.
    const authPath = path.join(stateDir, "installation-authorizations.json");
    const authFile = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const key = reclaimGatewayId.replace(/\./g, "__");
    authFile[key].status = "in-flight";
    fs.writeFileSync(authPath, JSON.stringify(authFile, null, 2));

    // Durable truth says Dana already owns it (isDurablyBootstrapped: true)
    // -- reclaim must finalize to "consumed", not "pending", and must not
    // depend on how much time has passed since it was marked in-flight.
    const result = beginInstallationAuthorizationConsumption({
      stateDir,
      gatewayId: reclaimGatewayId,
      namespace: dana.namespace,
      identityHash: dana.identityHash,
      isDurablyBootstrapped: () => true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("INSTALLATION_AUTHORIZATION_CONSUMED");
    expect(readInstallationAuthorization(stateDir, reclaimGatewayId)?.status).toBe("consumed");

    // The opposite case: durable truth says NOT yet bootstrapped (the
    // interrupted attempt never actually landed) -- reclaim must go back
    // to "pending", letting a genuine retry proceed.
    finalizeInstallationAuthorization(stateDir, reclaimGatewayId, "pending");
    const authFile2 = JSON.parse(fs.readFileSync(authPath, "utf8"));
    authFile2[key].status = "in-flight";
    fs.writeFileSync(authPath, JSON.stringify(authFile2, null, 2));

    const reclaimToPending = beginInstallationAuthorizationConsumption({
      stateDir,
      gatewayId: reclaimGatewayId,
      namespace: dana.namespace,
      identityHash: dana.identityHash,
      isDurablyBootstrapped: () => false,
    });
    expect(reclaimToPending.ok).toBe(true);
    expect(readInstallationAuthorization(stateDir, reclaimGatewayId)?.status).toBe("in-flight"); // begin() re-marks in-flight on success
  });

  it("never authorizes grant/revoke/transfer off an owner from a bootstrap attempt that failed to persist durably", async () => {
    // Same real filesystem failure as the crash-before-persist test,
    // checked against a DIFFERENT surface this time: can grant/revoke/
    // transfer (resolveActingIdentity) be reached using the identity/key
    // from a bootstrap that just failed to durably persist?
    //
    // Investigated empirically (not assumed) what kernelSet()/
    // saveSnapshotOrThrow() actually do on this specific failure: kernelSet()
    // itself throws before any in-memory mutation becomes visible when the
    // whole state directory is unwritable (this.me's own set path touches
    // disk too, not only the explicit saveSnapshotOrThrow() call after it)
    // -- so THIS exact scenario never actually leaves an in-memory phantom
    // to exploit. That atomicity is a property of this one failure mode,
    // not a guarantee resolveActingIdentity's own correctness should lean
    // on -- a different failure (saveSnapshotOrThrow specifically failing
    // after a kernelSet that itself succeeded) could still leave one.
    // resolveActingIdentity() was switched from the in-memory
    // readGatewayAuthority() to the same durable-verified read
    // bootstrapGatewayAuthority()'s own first-bootstrap gate already uses,
    // as defense-in-depth for that case -- this test is the end-to-end
    // regression guard for the reachable failure, not proof of the
    // unreachable one.
    const eve = await claimTestIdentity(origin, "eve-phantom", "eve-phantom-secret");
    const eveKey = await generateDeviceKey();
    const eveKeyId = await registerFirstKeychainKey(origin, eve, eveKey, "Eve's laptop");
    const phantomGatewayId = "gwauth-phantom-owner-test.local";
    authorizeInstallation(stateDir, phantomGatewayId, eve);

    fs.chmodSync(stateDir, 0o500);
    try {
      const failedBootstrap = await bootstrapGateway(origin, phantomGatewayId, eve, eveKeyId, eveKey);
      expect(failedBootstrap.status).toBe(500);
      expect(failedBootstrap.json.error).toBe("INSTALLATION_AUTHORIZATION_PERSIST_FAILED");

      // Still inside the read-only window: attempt a grant using the SAME
      // identity/key that just failed to durably bootstrap. If the phantom
      // in-memory owner/admin write were trusted, this would succeed.
      const mallory = await claimTestIdentity(origin, "mallory-phantom", "mallory-phantom-secret");
      const grantAttempt = await grantAdmin(
        origin, phantomGatewayId, eve.namespace, eveKeyId, eveKey,
        { identityHash: mallory.identityHash, namespace: mallory.namespace }, ["read"],
      );
      expect(grantAttempt.status).not.toBe(200);
      expect(grantAttempt.json.error).toBe("GATEWAY_NOT_BOOTSTRAPPED");
    } finally {
      fs.chmodSync(stateDir, 0o700);
    }

    // Confirms the installation is genuinely still unclaimed afterward —
    // not silently granted to anyone.
    const read = await get(origin, `/api/v1/gateway/${phantomGatewayId}/authority`);
    expect(read.json.record).toBeNull();
  });
});
