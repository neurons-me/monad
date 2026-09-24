/**
 * chainHeadWriteAuthorization.test.ts — the anti-replay half of
 * Surface-Identity-Claims.md §7.7's two prerequisites (the reserved-path
 * guard is netgetReservedPathAuthorization.test.ts). isNamespaceWriteAuthorized()
 * only ever proved "the claim holder signed exactly this body" -- nothing
 * bound WHICH namespace or WHEN, so a previously-valid signed body could be
 * replayed at any later time (including to silently un-revoke a delegate),
 * and a key holding claims on two namespaces had no signed binding stopping
 * a write meant for one from being replayed against the other.
 *
 * rootCommandHandler now requires the signed body to include `namespace`
 * and `expectedHeadHash` (the target namespace's current chain head, read
 * via GET /api/v1/write-head or the previous write's own response), and
 * rejects a mismatch with 409 STALE_HEAD. This file proves the four
 * scenarios that mechanism exists to close.
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createMonadApp } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";
import { toStableJson } from "../src/claim/replay";
import {
  deriveBranchProofSeed,
  importEd25519SigningKey,
  normalizeProofMessage,
  signEd25519Proof,
// @ts-expect-error -- see appAuthorization.test.ts's identical import for why.
} from "../../../me/Typescript/dist/me.es.js";

const ROOT_NAMESPACE = "chain-head-test.local";
const NAMESPACE_A = `alice.${ROOT_NAMESPACE}`;
const NAMESPACE_B = `bob.${ROOT_NAMESPACE}`;

function createTempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-chain-head-"));
  return {
    root,
    stateDir: path.join(root, "me-state"),
    claimDir: path.join(root, "claims"),
    selfConfigPath: path.join(root, "self.json"),
  };
}

async function startServer() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monad-chain-head-cwd-"));
  const runtime = createTempRuntime();
  const app = await createMonadApp({
    cwd: runtimeRoot,
    seed: "test-seed-chain-head",
    namespace: ROOT_NAMESPACE,
    stateDir: runtime.stateDir,
    claimDir: runtime.claimDir,
    selfConfigPath: runtime.selfConfigPath,
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { server, origin: `http://127.0.0.1:${port}`, runtimeRoot };
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

async function postRoot(origin: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(`${origin}/`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function fetchWriteHead(origin: string, namespace: string): Promise<string> {
  const res = await fetch(`${origin}/api/v1/write-head?namespace=${encodeURIComponent(namespace)}`);
  const json = await res.json();
  return json.expectedHeadHash;
}

// `sharedKey`, when given, signs the claim proof with THAT keypair instead of
// deriving a fresh namespace-scoped one -- letting a test put the SAME
// underlying key in control of two different namespaces' claims, which the
// normal per-namespace derivation below would never produce on its own.
async function claimNamespaceAs(
  origin: string,
  namespace: string,
  identityHash: string,
  secret: string,
  sharedKey?: { privateKey: CryptoKey; publicKey: CryptoKey },
) {
  const { privateKey, publicKey } = sharedKey ?? await importEd25519SigningKey(await deriveBranchProofSeed(secret, namespace));
  const publicKeyRaw = Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64url");

  const timestamp = Date.now();
  const proofPayload = { identityHash, expression: identityHash, namespace, rootNamespace: ROOT_NAMESPACE, challenge: null, timestamp };
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
    throw new Error(`Test setup failed: claiming "${namespace}" returned ${claimRes.status} ${JSON.stringify(claimRes.json)}`);
  }

  return {
    namespace,
    identityHash,
    sign: (message: string) => signEd25519Proof(privateKey, message),
  };
}

type Identity = Awaited<ReturnType<typeof claimNamespaceAs>>;

// Signs { path, value, namespace, expectedHeadHash } against the namespace's
// CURRENT head (read fresh, right before signing) and posts it.
async function signAndWrite(origin: string, identity: Identity, extra: Record<string, unknown> = {}) {
  const expectedHeadHash = await fetchWriteHead(origin, identity.namespace);
  const signedFields = { path: "profile.email", value: "someone@example.com", namespace: identity.namespace, expectedHeadHash, ...extra };
  const canonicalBody = toStableJson(signedFields);
  const signature = await identity.sign(canonicalBody);
  const body = { ...signedFields, signedPayload: canonicalBody, signature };
  const result = await postRoot(origin, { "x-forwarded-host": identity.namespace }, body);
  return { result, body };
}

describe("chain-head-bound write authorization (anti-replay)", () => {
  let server: Server;
  let origin: string;
  let runtimeRoot: string;

  beforeEach(async () => {
    resetKernelStateForTests();
    const started = await startServer();
    server = started.server;
    origin = started.origin;
    runtimeRoot = started.runtimeRoot;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    resetKernelStateForTests();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it("resending the exact same signed body fails", async () => {
    const alice = await claimNamespaceAs(origin, NAMESPACE_A, "alice-identity", "alice-secret");
    const { result: first, body } = await signAndWrite(origin, alice);
    expect(first.status).toBe(200);

    // Replay the IDENTICAL body (same signature, same claimed head) -- the
    // head has moved (this write itself advanced it), so this must fail.
    const replay = await postRoot(origin, { "x-forwarded-host": NAMESPACE_A }, body);
    expect(replay.status).toBe(409);
    expect(replay.json.error).toBe("STALE_HEAD");
  });

  it("resending an old grant after a later write (simulating a revoke) fails -- it cannot silently undo the later state", async () => {
    const alice = await claimNamespaceAs(origin, NAMESPACE_A, "alice-identity", "alice-secret");

    // "grant": add a delegate.
    const grant = await signAndWrite(origin, alice, {
      path: "netget.delegates",
      value: { aabbcc: { publicKey: "delegate-key", scopes: ["serve"] } },
    });
    expect(grant.result.status).toBe(200);

    // "revoke": a later, distinct write that advances the head again.
    const revoke = await signAndWrite(origin, alice, {
      path: "netget.delegates",
      value: {},
    });
    expect(revoke.result.status).toBe(200);

    // Replaying the ORIGINAL grant's signed body (still bound to the head
    // from before the revoke) must fail -- it cannot silently restore the
    // revoked delegate.
    const replayedGrant = await postRoot(origin, { "x-forwarded-host": NAMESPACE_A }, grant.body);
    expect(replayedGrant.status).toBe(409);
    expect(replayedGrant.json.error).toBe("STALE_HEAD");

    const current = await fetch(`${origin}/netget.delegates`, { headers: { "x-forwarded-host": NAMESPACE_A }, cache: "no-store" });
    const currentJson = await current.json();
    expect(currentJson?.target?.value).toEqual({});
  });

  it("a signed write for one namespace does not work when replayed against a different namespace, even one the same key holds a claim on", async () => {
    const sharedKey = await importEd25519SigningKey(await deriveBranchProofSeed("shared-secret", "shared-key-material"));
    const alice = await claimNamespaceAs(origin, NAMESPACE_A, "alice-identity", "unused", sharedKey);
    // The exact same underlying keypair also claims namespace B -- this is
    // the scenario the reviewer's original critique named specifically:
    // "si la misma clave controla más de un namespace, una escritura
    // firmada para uno podría aplicarse al otro". Without the namespace
    // binding, this signature WOULD verify fine against B's claim too,
    // since it is, genuinely, the same key.
    await claimNamespaceAs(origin, NAMESPACE_B, "alice-identity-on-b", "unused", sharedKey);

    const { body } = await signAndWrite(origin, alice);

    // Replay A's signed body against B's door -- the signed `namespace`
    // field still says NAMESPACE_A, which must not match B's resolved
    // namespace, regardless of what head B happens to be at.
    const crossReplay = await postRoot(origin, { "x-forwarded-host": NAMESPACE_B }, body);
    expect(crossReplay.status).toBe(409);
    expect(crossReplay.json.error).toBe("STALE_HEAD");
  });

  it("of two concurrent writes signed against the same head, only one succeeds", async () => {
    const alice = await claimNamespaceAs(origin, NAMESPACE_A, "alice-identity", "alice-secret");
    const expectedHeadHash = await fetchWriteHead(origin, NAMESPACE_A);

    const fieldsX = { path: "profile.email", value: "x@example.com", namespace: NAMESPACE_A, expectedHeadHash };
    const fieldsY = { path: "profile.email", value: "y@example.com", namespace: NAMESPACE_A, expectedHeadHash };
    const bodyX = { ...fieldsX, signedPayload: toStableJson(fieldsX), signature: await alice.sign(toStableJson(fieldsX)) };
    const bodyY = { ...fieldsY, signedPayload: toStableJson(fieldsY), signature: await alice.sign(toStableJson(fieldsY)) };

    const [resX, resY] = await Promise.all([
      postRoot(origin, { "x-forwarded-host": NAMESPACE_A }, bodyX),
      postRoot(origin, { "x-forwarded-host": NAMESPACE_A }, bodyY),
    ]);

    const statuses = [resX.status, resY.status].sort();
    // Exactly one 200 and one 409 -- never both succeeding (the second
    // would silently overwrite the first with no record either lost), and
    // never both failing (the mechanism must not be so strict it blocks a
    // genuine first writer).
    expect(statuses).toEqual([200, 409]);
  });
});
