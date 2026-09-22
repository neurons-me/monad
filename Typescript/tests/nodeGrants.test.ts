/**
 * nodeGrants.test.ts — the minimal walkthrough page-grants-design.md §8 asks for BEFORE connecting
 * anything to the gateway guard: a real identity grants a real executor `read` over one real node, the
 * executor reads it, cannot write it, cannot read a different node, the identity revokes the grant, and
 * the same read that worked before is refused immediately afterwards.
 *
 * Real HTTP server (for the identity claim + keychain key, which are HTTP-only operations already), real
 * Ed25519 signing for both the granting identity and the executor (its own, separately generated keypair --
 * proving app/executor are two different credentials, design doc §2.3), real semantic-memory reads/writes.
 * nodeGrants.ts's own functions are called directly (no HTTP surface for them exists yet -- this proves the
 * authorization mechanism itself, not a wire format nothing has reviewed). Same rigor as
 * gatewayAuthority.test.ts/gatewayCapabilities.test.ts: no mocks for anything security-relevant.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "node:crypto";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createMonadApp } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";
import { resetKeychainNonceCacheForTests } from "../src/claim/keychain";
import {
  grantNodeAccess,
  revokeNodeAccess,
  readNodeGrant,
  nodeGrantAllows,
  nodePathCovers,
  verifyExecutorAction,
  resetNodeGrantNonceCacheForTests,
} from "../src/claim/nodeGrants";
import { appendSemanticMemory, readSemanticValueForNamespace } from "../src/claim/memoryStore";
import {
  deriveBranchProofSeed,
  importEd25519SigningKey,
  normalizeProofMessage,
  signEd25519Proof,
// @ts-expect-error -- no .d.ts resolution across this relative path; see gatewayAuthority.test.ts's identical note.
} from "../../../me/Typescript/dist/me.es.js";

const ROOT_NAMESPACE = "cleaker.me";

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = null;
  resetKernelStateForTests();
  resetKeychainNonceCacheForTests();
  resetNodeGrantNonceCacheForTests();
});

async function start() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-nodegrants-"));
  const app = await createMonadApp({
    cwd: root, seed: "test-seed-nodegrants", namespace: ROOT_NAMESPACE,
    stateDir: path.join(root, "me-state"), claimDir: path.join(root, "claims"), selfConfigPath: path.join(root, "self.json"),
  });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

function randomNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
}
async function post(origin: string, urlPath: string, body: unknown) {
  const res = await fetch(`${origin}${urlPath}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
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

async function grant(
  owner: Awaited<ReturnType<typeof claimIdentity>>,
  ownerKey: Awaited<ReturnType<typeof freshKeypair>>,
  ownerKeyId: string,
  grantId: string,
  nodePath: string,
  operations: string[],
  executorPublicKeyRaw: string,
) {
  const nonce = randomNonce();
  const timestamp = Date.now();
  const signedFields = { op: "node-grant", namespace: owner.namespace, nodePath, operations, executorPublicKey: executorPublicKeyRaw, grantId, nonce, timestamp };
  const signature = await ownerKey.sign(normalizeProofMessage(signedFields));
  return grantNodeAccess({
    grantId, namespace: owner.namespace, nodePath, operations, executorPublicKey: executorPublicKeyRaw,
    appLabel: "Test App", grantingKeyId: ownerKeyId, nonce, timestamp, signature,
  });
}
async function revoke(owner: Awaited<ReturnType<typeof claimIdentity>>, ownerKey: Awaited<ReturnType<typeof freshKeypair>>, ownerKeyId: string, grantId: string) {
  const nonce = randomNonce();
  const timestamp = Date.now();
  const signedFields = { op: "node-grant-revoke", namespace: owner.namespace, grantId, nonce, timestamp };
  const signature = await ownerKey.sign(normalizeProofMessage(signedFields));
  return revokeNodeAccess({ namespace: owner.namespace, grantId, grantingKeyId: ownerKeyId, nonce, timestamp, signature });
}
async function act(
  owner: Awaited<ReturnType<typeof claimIdentity>>,
  executor: Awaited<ReturnType<typeof freshKeypair>>,
  grantId: string,
  operation: string,
  target: string,
  params: unknown = null,
) {
  const nonce = randomNonce();
  const timestamp = Date.now();
  const signedFields = { op: "node-grant-act", grantId, namespace: owner.namespace, nodePath: undefined, operation, target, params, nonce, timestamp };
  // nodePath is filled in server-side from the stored record, not signed by the executor (it doesn't
  // necessarily know it in advance if it were only told "grantId") -- but verifyExecutorAction's own
  // signedFields DOES include it (read from the record). Sign exactly what the server will check against:
  const record = readNodeGrant(owner.namespace, grantId)!;
  const realSignedFields = { op: "node-grant-act", grantId, namespace: owner.namespace, nodePath: record.nodePath, operation, target, params: params ?? null, nonce, timestamp };
  const signature = await executor.sign(normalizeProofMessage(realSignedFields));
  return verifyExecutorAction(owner.namespace, { grantId, operation, target, params, nonce, timestamp, signature });
}

describe("nodeGrants: the minimal walkthrough (design doc §8)", () => {
  it("nodePathCovers: prefix-safe, the same shape semanticBranchReader.test.ts already requires", () => {
    expect(nodePathCovers("dashboard", "dashboard")).toBe(true);
    expect(nodePathCovers("dashboard", "dashboard.status")).toBe(true);
    expect(nodePathCovers("dashboard", "dashboardX")).toBe(false); // the exact bug class that test guards against
    expect(nodePathCovers("dashboard", "other")).toBe(false);
    expect(nodePathCovers("", "anything.at.all")).toBe(true); // '' denotes the whole tree
  });

  it("grant read -> read succeeds -> write refused -> a DIFFERENT node refused -> revoke -> the same read is refused immediately", async () => {
    const origin = await start();
    const owner = await claimIdentity(origin, "owner1", "owner-secret-nodegrants-1");
    const ownerKey = await freshKeypair();
    const ownerKeyId = await registerKey(origin, owner, ownerKey, "owner device");

    // Real data at two DIFFERENT nodes of the owner's own namespace.
    appendSemanticMemory({ namespace: owner.namespace, path: "dashboard.status", data: "ALL SYSTEMS OK" });
    appendSemanticMemory({ namespace: owner.namespace, path: "other.thing", data: "SOMETHING ELSE" });

    // The executor is its OWN keypair -- a different credential from the owner's device key (design §2.3):
    // possessing it proves "the same running instance", nothing about which app it claims to be.
    const executor = await freshKeypair();
    const grantId = crypto.randomUUID();

    const granted = await grant(owner, ownerKey, ownerKeyId, grantId, "dashboard.status", ["read"], executor.publicKeyRaw);
    expect(granted.ok, JSON.stringify(granted)).toBe(true);
    if (!granted.ok) return;
    expect(granted.value.operations).toEqual(["read"]);
    expect(granted.value.revokedAt).toBeNull();

    // 1. The executor reads the granted node -- allowed.
    const readOk = await act(owner, executor, grantId, "read", "dashboard.status");
    expect(readOk.ok, JSON.stringify(readOk)).toBe(true);
    if (readOk.ok) {
      const value = readSemanticValueForNamespace(owner.namespace, "dashboard.status");
      expect(value).toBe("ALL SYSTEMS OK");
    }

    // 2. The SAME executor, SAME grant, attempts to WRITE the same node -- refused: 'write' was never granted.
    const writeRefused = await act(owner, executor, grantId, "write", "dashboard.status", { data: "TAMPERED" });
    expect(writeRefused.ok).toBe(false);
    if (!writeRefused.ok) expect(writeRefused.error).toBe("NOT_GRANTED");
    // and the data really is untouched -- this isn't just a status-code check
    expect(readSemanticValueForNamespace(owner.namespace, "dashboard.status")).toBe("ALL SYSTEMS OK");

    // 3. The SAME executor attempts to read a DIFFERENT node -- refused: outside nodePath.
    const crossNodeRefused = await act(owner, executor, grantId, "read", "other.thing");
    expect(crossNodeRefused.ok).toBe(false);
    if (!crossNodeRefused.ok) expect(crossNodeRefused.error).toBe("NOT_GRANTED");

    // 4. The identity revokes the grant.
    const revoked = await revoke(owner, ownerKey, ownerKeyId, grantId);
    expect(revoked.ok, JSON.stringify(revoked)).toBe(true);
    if (revoked.ok) expect(revoked.value.revokedAt).not.toBeNull();

    // 5. The EXACT SAME read that succeeded in step 1 is now refused, immediately -- no separate
    // invalidation step, the live record is what verifyExecutorAction always reads.
    const readAfterRevoke = await act(owner, executor, grantId, "read", "dashboard.status");
    expect(readAfterRevoke.ok).toBe(false);

    // A second revoke of the same grant is rejected (kept, not deleted -- design doc §3/§6).
    const doubleRevoke = await revoke(owner, ownerKey, ownerKeyId, grantId);
    expect(doubleRevoke.ok).toBe(false);
    if (!doubleRevoke.ok) expect(doubleRevoke.error).toBe("ALREADY_REVOKED");
  });

  it("an executor cannot grant itself anything -- only a currently-active keychain key's signature can", async () => {
    const origin = await start();
    const owner = await claimIdentity(origin, "owner2", "owner-secret-nodegrants-2");
    const ownerKey = await freshKeypair();
    const ownerKeyId = await registerKey(origin, owner, ownerKey, "owner device");
    const executor = await freshKeypair();
    const grantId = crypto.randomUUID();

    // The executor tries to sign its OWN grant request, using its own key instead of the owner's --
    // grantNodeAccess only ever verifies against the resolved keychain key for grantingKeyId, so this
    // must fail no matter what the executor signs.
    const nonce = randomNonce();
    const timestamp = Date.now();
    const signedFields = { op: "node-grant", namespace: owner.namespace, nodePath: "dashboard.status", operations: ["read", "write"], executorPublicKey: executor.publicKeyRaw, grantId, nonce, timestamp };
    const forgedSignature = await executor.sign(normalizeProofMessage(signedFields));
    const result = grantNodeAccess({
      grantId, namespace: owner.namespace, nodePath: "dashboard.status", operations: ["read", "write"],
      executorPublicKey: executor.publicKeyRaw, appLabel: "Self-granting app", grantingKeyId: ownerKeyId,
      nonce, timestamp, signature: forgedSignature,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("PROOF_INVALID");
    expect(readNodeGrant(owner.namespace, grantId)).toBeNull();
  });

  it("a signature for one action cannot be replayed as a different one (design doc §5)", async () => {
    const origin = await start();
    const owner = await claimIdentity(origin, "owner3", "owner-secret-nodegrants-3");
    const ownerKey = await freshKeypair();
    const ownerKeyId = await registerKey(origin, owner, ownerKey, "owner device");
    appendSemanticMemory({ namespace: owner.namespace, path: "dashboard.status", data: "OK" });
    const executor = await freshKeypair();
    const grantId = crypto.randomUUID();
    const granted = await grant(owner, ownerKey, ownerKeyId, grantId, "dashboard.status", ["read", "write"], executor.publicKeyRaw);
    expect(granted.ok).toBe(true);

    // Sign a legitimate READ, then hand-craft a request that reuses that exact nonce/signature but
    // claims to be a WRITE -- verifyExecutorAction must reject it (the signature was over 'read', not
    // 'write', so the canonicalized body no longer matches what was signed).
    const nonce = randomNonce();
    const timestamp = Date.now();
    const readPayload = { op: "node-grant-act", grantId, namespace: owner.namespace, nodePath: "dashboard.status", operation: "read", target: "dashboard.status", params: null, nonce, timestamp };
    const readSignature = await executor.sign(normalizeProofMessage(readPayload));

    const replayedAsWrite = verifyExecutorAction(owner.namespace, {
      grantId, operation: "write", target: "dashboard.status", params: { data: "HACKED" }, nonce, timestamp, signature: readSignature,
    });
    expect(replayedAsWrite.ok).toBe(false);
    if (!replayedAsWrite.ok) expect(replayedAsWrite.error).toBe("PROOF_INVALID");
    expect(readSemanticValueForNamespace(owner.namespace, "dashboard.status")).toBe("OK");

    // The genuine read, with its own real signature, still works.
    const genuineRead = verifyExecutorAction(owner.namespace, { grantId, operation: "read", target: "dashboard.status", params: null, nonce, timestamp, signature: readSignature });
    expect(genuineRead.ok).toBe(true);
  });
});
