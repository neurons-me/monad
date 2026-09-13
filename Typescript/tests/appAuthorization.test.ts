/**
 * appAuthorization.test.ts — real, signed proof that apps.<appId>.* is
 * governed by the namespace's own claimed owner, with NO separate app-level
 * claim/bootstrap step and NOT first-claim-wins.
 *
 * WHAT THIS PROTECTS AGAINST
 * Without appAuthorization.ts's extra gate, apps.<appId>.* would inherit
 * groupAuthorization.ts's canBootstrap-alone rule (whoever claims an
 * unowned key first wins) — meaning any visitor who notices an unclaimed
 * apps.<id> could squat on it. An app must instead be authorized by the
 * NAMESPACE it lives under (the same namespace-claim primitive
 * records.ts's claimNamespace already provides — including for a bare
 * root namespace with no prefix, confirmed real and unmodified for this
 * feature). This is the exact scenario the conversation that led to this
 * file called out: "primer claim tampoco autoriza a cualquier visitante
 * a apropiarse de una página sin dueño."
 *
 * A second, later correction removed the app's OWN claim step entirely:
 * an app is a representation of the .me graph it's mounted on, not an
 * independent claimable resource — "crear la página es una escritura
 * autorizada en el árbol, no necesariamente un nuevo claim." So the
 * namespace's real owner writes straight to apps.<appId>.* with no
 * apps.<appId>.owner bootstrap write required first; readAppRecord()
 * derives the app's owner from the namespace's own claim.
 *
 * Proves, against a real in-process monad (app.listen(0), real HTTP, real
 * Ed25519 signatures — never a mock), in order:
 *   1. a non-owner cannot write into an app under someone else's namespace
 *   2. the namespace's real claimed owner CAN write there directly, with
 *      no separate app-claim step
 *   3. the namespace owner can grant a scoped write to another identity
 *   4. that grantee can write within their granted scope
 *   5. an identity with NO grant is rejected via a DIRECT request (not
 *      just a hidden UI control)
 *   6. a grant on one app does NOT carry over to a different app in the
 *      same namespace (cross-app isolation)
 *   7. revoking a grant blocks that identity's SUBSEQUENT writes
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createMonadApp } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";
import {
  deriveBranchProofSeed,
  importEd25519SigningKey,
  normalizeProofMessage,
  signEd25519Proof,
// @ts-expect-error -- no .d.ts resolution across this relative path (monad's
// own package.json pins the published this.me@3.9.1, which predates these
// exports); the runtime import reaches the local workspace build directly,
// same as commitGate.test.ts.
} from "../../../me/Typescript/dist/me.es.js";

const ROOT_NAMESPACE = `app-auth-test.local`;

function createTempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-app-auth-"));
  return {
    root,
    stateDir: path.join(root, "me-state"),
    claimDir: path.join(root, "claims"),
    selfConfigPath: path.join(root, "self.json"),
  };
}

async function startServer() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monad-app-auth-cwd-"));
  const runtime = createTempRuntime();
  const app = await createMonadApp({
    cwd: runtimeRoot,
    seed: "test-seed-app-auth",
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

/** Claims an arbitrary namespace (prefixed OR bare-root) under a chosen identityHash. */
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

type Identity = Awaited<ReturnType<typeof claimNamespaceAs>>;

async function commit(origin: string, caller: Identity, events: Array<{ namespace: string; path: string; data: unknown }>) {
  const signedFields = { events, identityHash: caller.identityHash, namespace: caller.namespace };
  const signature = await caller.sign(normalizeProofMessage(signedFields));
  return post(origin, "/api/v1/commit", { ...signedFields, signature });
}

describe("apps.<appId>.* authorization", () => {
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

  it("end to end: namespace ownership gates app writes directly, scoped grants, cross-app isolation, and revocation", async () => {
    // Alice claims the bare ROOT namespace itself -- she becomes its owner.
    const aliceRoot = await claimNamespaceAs(origin, ROOT_NAMESPACE, "alice", "alice-root-secret");
    // Alice also claims her own prefixed identity -- the "caller" identity
    // her own commit writes get signed/verified against (isNamespaceWriteAuthorized
    // checks getClaim(caller.namespace), separate from the namespace-ownership check).
    const alice = await claimNamespaceAs(origin, `alice.${ROOT_NAMESPACE}`, "alice", "alice-secret");
    const bob = await claimNamespaceAs(origin, `bob.${ROOT_NAMESPACE}`, "bob", "bob-secret");
    const eve = await claimNamespaceAs(origin, `eve.${ROOT_NAMESPACE}`, "eve", "eve-secret");
    void aliceRoot;

    // 1. Bob (not the namespace owner) cannot write into an app here.
    const bobWriteDenied = await commit(origin, bob, [
      { namespace: ROOT_NAMESPACE, path: "apps.myapp.pages.home", data: { type: "Box", children: [] } },
    ]);
    expect(bobWriteDenied.status).toBe(403);
    expect(bobWriteDenied.json.error).toBe("APP_AUTHORIZATION_REQUIRED");
    expect(String(bobWriteDenied.json.detail)).toMatch(/namespace owner/);

    // 2. Alice (the real namespace owner) writes straight to apps.myapp.* --
    // no separate app-claim/bootstrap step required first.
    const aliceWrite = await commit(origin, alice, [
      { namespace: ROOT_NAMESPACE, path: "apps.myapp.pages.home", data: { type: "Box", children: [] } },
    ]);
    expect(aliceWrite.status).toBe(201);
    expect(aliceWrite.json.ok).toBe(true);

    // 2b. apps.<appId>.owner is dead -- rejected even for Alice herself,
    // the real namespace owner, not just for a non-owner. It must never
    // look like a settable field again.
    const aliceOwnerWrite = await commit(origin, alice, [
      { namespace: ROOT_NAMESPACE, path: "apps.myapp.owner", data: alice.identityHash },
    ]);
    expect(aliceOwnerWrite.status).toBe(403);
    expect(aliceOwnerWrite.json.error).toBe("APP_AUTHORIZATION_REQUIRED");
    expect(String(aliceOwnerWrite.json.detail)).toMatch(/no longer exists as a concept/);

    // 3. Alice (namespace owner) grants Bob a scoped write.
    const grantBob = await commit(origin, alice, [
      { namespace: ROOT_NAMESPACE, path: "apps.myapp.grants.bob", data: ["pages:write"] },
    ]);
    expect(grantBob.status).toBe(201);

    // 4. Bob writes within his granted scope -- succeeds.
    const bobWrite = await commit(origin, bob, [
      { namespace: ROOT_NAMESPACE, path: "apps.myapp.pages.home", data: { type: "Box", children: [{ type: "Typography" }] } },
    ]);
    expect(bobWrite.status).toBe(201);

    // 5. Eve has NO grant at all -- a direct write request is rejected,
    // not just hidden by a UI control.
    const eveWrite = await commit(origin, eve, [
      { namespace: ROOT_NAMESPACE, path: "apps.myapp.pages.hacked", data: { type: "Typography", props: { children: "pwned" } } },
    ]);
    expect(eveWrite.status).toBe(403);
    expect(eveWrite.json.error).toBe("APP_AUTHORIZATION_REQUIRED");

    // 6. A SEPARATE app in the SAME namespace: Bob's grant on myapp does
    // not carry over. Alice writes directly into otherapp; Bob's write to
    // it fails even though he already has a grant on myapp.
    const aliceWriteOther = await commit(origin, alice, [
      { namespace: ROOT_NAMESPACE, path: "apps.otherapp.pages.home", data: { type: "Box", children: [] } },
    ]);
    expect(aliceWriteOther.status).toBe(201);

    const bobWriteOtherApp = await commit(origin, bob, [
      { namespace: ROOT_NAMESPACE, path: "apps.otherapp.pages.home", data: { type: "Box", children: [] } },
    ]);
    expect(bobWriteOtherApp.status).toBe(403);
    expect(bobWriteOtherApp.json.error).toBe("APP_AUTHORIZATION_REQUIRED");

    // 7. Alice revokes Bob's grant on myapp -- his SUBSEQUENT write fails.
    const revokeBob = await commit(origin, alice, [
      { namespace: ROOT_NAMESPACE, path: "apps.myapp.grants.bob", data: [] },
    ]);
    expect(revokeBob.status).toBe(201);

    const bobWriteAfterRevoke = await commit(origin, bob, [
      { namespace: ROOT_NAMESPACE, path: "apps.myapp.pages.another", data: { type: "Box", children: [] } },
    ]);
    expect(bobWriteAfterRevoke.status).toBe(403);
    expect(bobWriteAfterRevoke.json.error).toBe("APP_AUTHORIZATION_REQUIRED");
  });

  it("rejects writing to an app under the real root when NOBODY has claimed it yet", async () => {
    const ghost = await claimNamespaceAs(origin, `ghost.${ROOT_NAMESPACE}`, "ghost", "ghost-secret");
    // ghost's OWN identity is claimed (so the commit's signature verifies),
    // and the write target IS this monad's real configured root -- just
    // nobody has claimed THAT yet. This must reach appAuthorization.ts's
    // own "has no owner yet" check (not the general foreign-namespace
    // guard in syncHandler.ts, which only fires for a namespace that isn't
    // this monad's real root at all -- see the next test for that case).
    const res = await commit(origin, ghost, [
      { namespace: ROOT_NAMESPACE, path: "apps.squat.pages.home", data: { type: "Box", children: [] } },
    ]);
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("APP_AUTHORIZATION_REQUIRED");
    expect(String(res.json.detail)).toMatch(/has no owner yet/);
  });

  it("rejects writing to an app under a namespace that isn't this monad's real root at all (foreign-namespace guard)", async () => {
    const ghost = await claimNamespaceAs(origin, `ghost.${ROOT_NAMESPACE}`, "ghost", "ghost-secret");
    // ghost's OWN identity is claimed, but the WRITE TARGET namespace here
    // is a completely different root, unrelated to this monad's real
    // configured root -- even if GHOST (or anyone) claimed that foreign
    // string, it must never authorize a write that physically collides
    // with this monad's own kernel-root storage. See
    // namespaceCollisionAuthorization.test.ts for the full exploit this
    // guards against.
    const foreignRoot = "nobody-owns-this.local";
    const res = await commit(origin, ghost, [
      { namespace: foreignRoot, path: "apps.squat.pages.home", data: { type: "Box", children: [] } },
    ]);
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("FOREIGN_NAMESPACE_REJECTED");
  });
});
