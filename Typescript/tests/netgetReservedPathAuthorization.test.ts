/**
 * netgetReservedPathAuthorization.test.ts — proves and then guards a real gap
 * in rootCommandHandler (handlers/commandHandler.ts): `const claim =
 * getClaim(namespace); if (claim) { ...verify signature... }` skips
 * authorization entirely for an unclaimed namespace, so before this guard
 * existed, anyone could write netget.delegates (or any other netget.* path)
 * for a never-claimed namespace completely unsigned -- and
 * meshAnnounce.ts's isNamespaceUsableByIdentity() would read the result as a
 * real delegation. See Surface-Identity-Claims.md §7.7 (cleaker repo
 * typedocs) for the full design this closes a prerequisite for.
 *
 * The test target namespace is a legitimate, resolvable SUB-namespace of the
 * server's own configured root (`newuser.<ROOT_NAMESPACE>`) that has never
 * been claimed -- not the generic "unknown" fallback host, which already
 * gets rejected by a different, pre-existing guard
 * (isForeignNamespaceCollapsingToRoot, exercised in
 * namespaceCollisionAuthorization.test.ts) regardless of path. Using
 * "unknown" here would not actually prove THIS guard does anything; a real
 * sub-namespace that resolves to its own genuine `users.<label>` kernel
 * storage, and simply happens to be unclaimed, is what previously slipped
 * through.
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

const ROOT_NAMESPACE = "netget-reserved-path-test.local";
const UNCLAIMED_SUB_NAMESPACE = `newuser.${ROOT_NAMESPACE}`;

function createTempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-netget-reserved-"));
  return {
    root,
    stateDir: path.join(root, "me-state"),
    claimDir: path.join(root, "claims"),
    selfConfigPath: path.join(root, "self.json"),
  };
}

async function startServer() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monad-netget-reserved-cwd-"));
  const runtime = createTempRuntime();
  const app = await createMonadApp({
    cwd: runtimeRoot,
    seed: "test-seed-netget-reserved",
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

async function nrpRead(origin: string, host: string, dotPath: string) {
  const res = await fetch(`${origin}/${dotPath}`, { headers: { "x-forwarded-host": host }, cache: "no-store" });
  const json = await res.json().catch(() => null);
  return json?.target?.value;
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

describe("netget.* reserved-path authorization on rootCommandHandler", () => {
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

  it("rejects an unsigned write to netget.delegates for a real, unclaimed sub-namespace", async () => {
    const write = await postRoot(
      origin,
      { "x-forwarded-host": UNCLAIMED_SUB_NAMESPACE },
      { path: "netget.delegates", value: { deadbeef: { publicKey: "attacker-key", scopes: ["serve"] } } },
    );

    expect(write.status).toBe(403);
    expect(write.json.error).toBe("NETGET_PATH_REQUIRES_CLAIM");
  });

  it("rejects an unsigned write to any netget.* path, not just delegates specifically", async () => {
    const write = await postRoot(
      origin,
      { "x-forwarded-host": UNCLAIMED_SUB_NAMESPACE },
      { path: "netget.domains", value: { "example.com": { type: "direct" } } },
    );

    expect(write.status).toBe(403);
    expect(write.json.error).toBe("NETGET_PATH_REQUIRES_CLAIM");
  });

  it("does not block ordinary (non-netget) unsigned writes for an unclaimed namespace -- this guard is scoped, not a blanket lockdown", async () => {
    const write = await postRoot(
      origin,
      { "x-forwarded-host": UNCLAIMED_SUB_NAMESPACE },
      { path: "profile.email", value: "someone@example.com" },
    );

    // Unclaimed namespaces are already open-write by design (first writer
    // establishes the data; claiming later is a separate step) -- this test
    // exists only to prove the new guard didn't accidentally widen its net
    // to every write, which would be a functional regression, not a fix.
    expect(write.status).not.toBe(403);
  });

  it("once the namespace is claimed, a correctly signed write to netget.delegates succeeds", async () => {
    const owner = await claimNamespaceAs(origin, UNCLAIMED_SUB_NAMESPACE, "owner-identity", "owner-secret");

    const signedFields = { path: "netget.delegates", value: { aabbcc: { publicKey: "delegate-key", scopes: ["serve"] } } };
    const canonicalBody = toStableJson(signedFields);
    const signature = await owner.sign(canonicalBody);

    const write = await postRoot(
      origin,
      { "x-forwarded-host": UNCLAIMED_SUB_NAMESPACE },
      { ...signedFields, signedPayload: canonicalBody, signature },
    );

    expect(write.status).toBe(200);
  });

  it("still rejects an UNSIGNED write to netget.delegates even once the namespace is claimed (claim existing is not the same as this write being authorized)", async () => {
    await claimNamespaceAs(origin, UNCLAIMED_SUB_NAMESPACE, "owner-identity", "owner-secret");

    const write = await postRoot(
      origin,
      { "x-forwarded-host": UNCLAIMED_SUB_NAMESPACE },
      { path: "netget.delegates", value: { aabbcc: { publicKey: "delegate-key", scopes: ["serve"] } } },
    );

    expect(write.status).toBe(403);
    expect(write.json.error).toBe("NAMESPACE_WRITE_FORBIDDEN");
  });
});

describe("reserved-path guards resolve the same write target the real writer does", () => {
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

  it("CONFIRMED real bypass, now fixed: a nested body.payload.path used to skip the guard while still writing to netget.delegates", async () => {
    const write = await postRoot(
      origin,
      { "x-forwarded-host": UNCLAIMED_SUB_NAMESPACE },
      { payload: { path: "netget.delegates", value: { attacker: { publicKey: "attacker-key", scopes: ["serve"] } } } },
    );

    expect(write.status).toBe(403);
    expect(write.json.error).toBe("NETGET_PATH_REQUIRES_CLAIM");
  });

  it("CONFIRMED real bypass, now fixed: a slash-separated path reaches the same kernel location as the dotted form", async () => {
    const write = await postRoot(
      origin,
      { "x-forwarded-host": UNCLAIMED_SUB_NAMESPACE },
      { path: "netget/delegates", value: { attacker: { publicKey: "attacker-key", scopes: ["serve"] } } },
    );

    expect(write.status).toBe(403);
    expect(write.json.error).toBe("NETGET_PATH_REQUIRES_CLAIM");
  });

  it("a leading-dot path (.netget.delegates) is also caught -- empty leading segment is dropped by normalization", async () => {
    const write = await postRoot(
      origin,
      { "x-forwarded-host": UNCLAIMED_SUB_NAMESPACE },
      { path: ".netget.delegates", value: { attacker: { publicKey: "attacker-key", scopes: ["serve"] } } },
    );

    expect(write.status).toBe(403);
    expect(write.json.error).toBe("NETGET_PATH_REQUIRES_CLAIM");
  });

  it("a body using `expression` instead of `path` is still resolved and caught", async () => {
    const write = await postRoot(
      origin,
      { "x-forwarded-host": UNCLAIMED_SUB_NAMESPACE },
      { expression: "netget.delegates", value: { attacker: { publicKey: "attacker-key", scopes: ["serve"] } } },
    );

    expect(write.status).toBe(403);
    expect(write.json.error).toBe("NETGET_PATH_REQUIRES_CLAIM");
  });

  it("a me:// URI stuffed into the path field does not match the guard, but also does not reach the real netget.delegates location", async () => {
    const write = await postRoot(
      origin,
      { "x-forwarded-host": UNCLAIMED_SUB_NAMESPACE },
      { path: "me://self:write/netget/delegates", value: { attacker: { publicKey: "attacker-key", scopes: ["serve"] } } },
    );

    // Whatever this write's status is, the real netget.delegates node for
    // this namespace must still read back empty -- proving this shape,
    // even though the guard doesn't recognize it as "netget.*", is not
    // actually a route to the protected location (it targets some other,
    // garbled path instead).
    const real = await nrpRead(origin, UNCLAIMED_SUB_NAMESPACE, "netget.delegates");
    expect(real).toBeUndefined();
    void write; // status not asserted -- see comment above for why
  });

  it("the same nested-payload bypass shape is also closed for keychain.* (shared fix, not netget-specific)", async () => {
    const write = await postRoot(
      origin,
      { "x-forwarded-host": UNCLAIMED_SUB_NAMESPACE },
      { payload: { path: "keychain.keys.attacker", value: { publicKey: "attacker-key", admin: true } } },
    );

    expect(write.status).toBe(403);
    expect(write.json.error).toBe("KEYCHAIN_PATH_REQUIRES_KEYCHAIN_API");
  });

  it("the same slash-form bypass shape is also closed for keychain.* (shared fix, not netget-specific)", async () => {
    const write = await postRoot(
      origin,
      { "x-forwarded-host": UNCLAIMED_SUB_NAMESPACE },
      { path: "keychain/keys/attacker", value: { publicKey: "attacker-key", admin: true } },
    );

    expect(write.status).toBe(403);
    expect(write.json.error).toBe("KEYCHAIN_PATH_REQUIRES_KEYCHAIN_API");
  });
});
