/**
 * rootWriteDirectionCheck.test.ts — proves a real, live-confirmed
 * vulnerability, then guards it.
 *
 * The root namespace collapses to an EMPTY kernel prefix
 * (namespaceToKernelPrefix returns "" for the monad's own configured root),
 * so a write's `path` field is used completely unprefixed. A user's own
 * namespace (alice.<root>) writes under `users.alice.*`
 * (namespaceToKernelPrefix returns "users.alice"). Before
 * isForeignUsersPrefixWrite() existed, a root-claim-signed write with
 * `path: "users.alice.profile.email"` landed at the EXACT SAME kernel
 * location Alice's own signed write to `profile.email` would -- confirmed
 * live (real claim, real signature, real HTTP round trip, real re-read)
 * before this guard existed: the root's own valid signature overwrote
 * Alice's real value with a forged one, no signature from Alice involved at
 * all. Now rejected with CANNOT_WRITE_ANOTHER_NAMESPACES_STORAGE.
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

const ROOT_NAMESPACE = "root-write-direction-test.local";
const ALICE_NAMESPACE = `alice.${ROOT_NAMESPACE}`;

function createTempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-root-write-dir-"));
  return {
    root,
    stateDir: path.join(root, "me-state"),
    claimDir: path.join(root, "claims"),
    selfConfigPath: path.join(root, "self.json"),
  };
}

async function startServer() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monad-root-write-dir-cwd-"));
  const runtime = createTempRuntime();
  const app = await createMonadApp({
    cwd: runtimeRoot,
    seed: "test-seed-root-write-dir",
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

async function claimNamespaceAs(origin: string, namespace: string, identityHash: string, secret: string) {
  const branchSeed = await deriveBranchProofSeed(secret, namespace);
  const { privateKey, publicKey } = await importEd25519SigningKey(branchSeed);
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

describe("root claim's own signature cannot reach into users.<other>.* kernel storage", () => {
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

  it("rejects a root-claim-signed write with path users.alice.profile.email, and alice's real value survives", async () => {
    // Alice claims her own namespace and writes her own real value first.
    const alice = await claimNamespaceAs(origin, ALICE_NAMESPACE, "alice-identity", "alice-secret");
    const aliceHead = await fetchWriteHead(origin, ALICE_NAMESPACE);
    const aliceFields = { path: "profile.email", value: "alice@real.example", namespace: ALICE_NAMESPACE, expectedHeadHash: aliceHead };
    const aliceBody = toStableJson(aliceFields);
    const aliceWrite = await postRoot(origin, { "x-forwarded-host": ALICE_NAMESPACE }, { ...aliceFields, signedPayload: aliceBody, signature: await alice.sign(aliceBody) });
    expect(aliceWrite.status).toBe(200);

    // Root claims itself, then signs a write whose `path` reaches directly
    // into alice's own kernel storage prefix.
    const root = await claimNamespaceAs(origin, ROOT_NAMESPACE, "root-identity", "root-secret");
    const rootHead = await fetchWriteHead(origin, ROOT_NAMESPACE);
    const forgedFields = {
      path: "users.alice.profile.email",
      value: "forged-by-root@evil.example",
      namespace: ROOT_NAMESPACE,
      expectedHeadHash: rootHead,
    };
    const forgedBody = toStableJson(forgedFields);
    const forgedWrite = await postRoot(
      origin,
      { "x-forwarded-host": ROOT_NAMESPACE },
      { ...forgedFields, signedPayload: forgedBody, signature: await root.sign(forgedBody) },
    );

    expect(forgedWrite.status).toBe(403);
    expect(forgedWrite.json.error).toBe("CANNOT_WRITE_ANOTHER_NAMESPACES_STORAGE");

    const aliceReread = await fetch(`${origin}/profile.email`, { headers: { "x-forwarded-host": ALICE_NAMESPACE }, cache: "no-store" });
    const aliceRereadJson = await aliceReread.json();
    expect(aliceRereadJson?.target?.value).toBe("alice@real.example");
  });

  it("rejects the same shape via POST /api/v1/commit (commitHandler), per-event", async () => {
    const alice = await claimNamespaceAs(origin, ALICE_NAMESPACE, "alice-identity", "alice-secret");
    const aliceHead = await fetchWriteHead(origin, ALICE_NAMESPACE);
    const aliceFields = { path: "profile.email", value: "alice@real.example", namespace: ALICE_NAMESPACE, expectedHeadHash: aliceHead };
    const aliceBody = toStableJson(aliceFields);
    await postRoot(origin, { "x-forwarded-host": ALICE_NAMESPACE }, { ...aliceFields, signedPayload: aliceBody, signature: await alice.sign(aliceBody) });

    const root = await claimNamespaceAs(origin, ROOT_NAMESPACE, "root-identity", "root-secret");
    const events = [{ namespace: ROOT_NAMESPACE, path: "users.alice.profile.email", data: "forged-via-commit@evil.example" }];
    const signedFields = { events, identityHash: root.identityHash, namespace: ROOT_NAMESPACE };
    const signature = await root.sign(normalizeProofMessage(signedFields));
    const res = await post(origin, "/api/v1/commit", { ...signedFields, signature });

    expect(res.status).toBe(403);
    expect(res.json.error).toBe("CANNOT_WRITE_ANOTHER_NAMESPACES_STORAGE");

    const aliceReread = await fetch(`${origin}/profile.email`, { headers: { "x-forwarded-host": ALICE_NAMESPACE }, cache: "no-store" });
    const aliceRereadJson = await aliceReread.json();
    expect(aliceRereadJson?.target?.value).toBe("alice@real.example");
  });
});

describe("reading through the root namespace cannot reach users.<other>.* content either", () => {
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

  it("GET users.alice.profile.email via the root host does not return alice's real value", async () => {
    const alice = await claimNamespaceAs(origin, ALICE_NAMESPACE, "alice-identity", "alice-secret");
    const aliceHead = await fetchWriteHead(origin, ALICE_NAMESPACE);
    const aliceFields = { path: "profile.email", value: "alice-secret-email@real.example", namespace: ALICE_NAMESPACE, expectedHeadHash: aliceHead };
    const aliceBody = toStableJson(aliceFields);
    await postRoot(origin, { "x-forwarded-host": ALICE_NAMESPACE }, { ...aliceFields, signedPayload: aliceBody, signature: await alice.sign(aliceBody) });

    // No claim needed to read -- just ask the ROOT host for alice's deep path.
    const leakAttempt = await fetch(`${origin}/users.alice.profile.email`, { headers: { "x-forwarded-host": ROOT_NAMESPACE }, cache: "no-store" });
    const leakJson = await leakAttempt.json().catch(() => null);
    expect(leakAttempt.status).toBe(404);
    expect(leakJson?.target?.value).toBeUndefined();

    // Alice's own read, through her own namespace, still works normally.
    const legit = await fetch(`${origin}/profile.email`, { headers: { "x-forwarded-host": ALICE_NAMESPACE }, cache: "no-store" });
    const legitJson = await legit.json();
    expect(legitJson?.target?.value).toBe("alice-secret-email@real.example");
  });
});

describe("malformed write paths are rejected outright, before any other guard", () => {
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

  const MALFORMED_PATHS = [
    "me://self:write/profile.email",
    "profile..email",
    "profile//email",
    ".profile.email",
    "profile.email.",
    "profile.%2e%2e.email",
  ];

  for (const badPath of MALFORMED_PATHS) {
    it(`rejects path ${JSON.stringify(badPath)} with 400 MALFORMED_WRITE_PATH`, async () => {
      const write = await postRoot(
        origin,
        { "x-forwarded-host": ROOT_NAMESPACE },
        { path: badPath, value: "irrelevant" },
      );
      expect(write.status).toBe(400);
      expect(write.json.error).toBe("MALFORMED_WRITE_PATH");
    });
  }

  it("rejects the same shapes via POST /api/v1/commit (commitHandler), per-event", async () => {
    const root = await claimNamespaceAs(origin, ROOT_NAMESPACE, "root-identity", "root-secret");
    const events = [{ namespace: ROOT_NAMESPACE, path: "profile..email", data: "irrelevant" }];
    const signedFields = { events, identityHash: root.identityHash, namespace: ROOT_NAMESPACE };
    const signature = await root.sign(normalizeProofMessage(signedFields));
    const res = await post(origin, "/api/v1/commit", { ...signedFields, signature });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("MALFORMED_WRITE_PATH");
  });

  it("a normal, well-formed path is not rejected by the malformed-path check", async () => {
    const alice = await claimNamespaceAs(origin, ALICE_NAMESPACE, "alice-identity", "alice-secret");
    const aliceHead = await fetchWriteHead(origin, ALICE_NAMESPACE);
    const fields = { path: "profile.email", value: "alice@real.example", namespace: ALICE_NAMESPACE, expectedHeadHash: aliceHead };
    const body = toStableJson(fields);
    const write = await postRoot(origin, { "x-forwarded-host": ALICE_NAMESPACE }, { ...fields, signedPayload: body, signature: await alice.sign(body) });
    expect(write.status).toBe(200);
  });
});
