/**
 * namespaceCollisionAuthorization.test.ts — isolated proof (and, once
 * fixed, regression guard) for a real gap surfaced by reviewing
 * appAuthorization.ts's no-bootstrap model: namespaceToKernelPrefix()
 * (kernel/manager.ts) collapses to kernel-root storage ("") both for (a)
 * this monad's REAL configured root namespace, and (b) ANY OTHER bare
 * namespace string that doesn't match it at all (unparseable, or a
 * genuinely foreign root). That collapse is pre-existing behavior, but it
 * was never exercised against a namespace-claim-derived authorization gate
 * before now.
 *
 * THE ATTACK
 * appAuthorization.ts derives an app's owner from getClaim(event.namespace)
 * -- keyed by whatever STRING the caller put in the event, not by physical
 * storage location. Since claimNamespace() lets anyone claim ANY bare
 * string (first-claim-wins on the string itself), an attacker can:
 *   1. Claim an unrelated namespace string nobody else has claimed (e.g.
 *      "totally-unrelated-name.example") under their own identity.
 *   2. Commit an event with `namespace: "totally-unrelated-name.example"`,
 *      `path: "apps.gui.pages.home"`. checkAppAuthorization reads
 *      getClaim("totally-unrelated-name.example") -- the attacker's OWN
 *      claim -- sees they're the owner of THAT string, and authorizes it.
 *   3. But namespaceToKernelPrefix("totally-unrelated-name.example")
 *      ALSO resolves to "" (kernel root) -- the exact same physical
 *      location the real root namespace's apps.gui.* data lives at. The
 *      attacker's "authorized" write lands on and overwrites the real
 *      owner's data, despite never holding a claim on the real root at
 *      all.
 *
 * This proves the exploit against a real in-process monad, then (once
 * fixed) proves it's rejected.
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
  exportEd25519PublicKey,
  normalizeProofMessage,
  signEd25519Proof,
// @ts-expect-error -- see appAuthorization.test.ts's identical import for why.
} from "../../../me/Typescript/dist/me.es.js";

const ROOT_NAMESPACE = "namespace-collision-test.local";

function createTempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-ns-collision-"));
  return {
    root,
    stateDir: path.join(root, "me-state"),
    claimDir: path.join(root, "claims"),
    selfConfigPath: path.join(root, "self.json"),
  };
}

async function startServer() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monad-ns-collision-cwd-"));
  const runtime = createTempRuntime();
  const app = await createMonadApp({
    cwd: runtimeRoot,
    seed: "test-seed-ns-collision",
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

async function nrpRead(origin: string, dotPath: string) {
  const res = await fetch(`${origin}/${dotPath}`, { headers: { "x-forwarded-host": ROOT_NAMESPACE }, cache: "no-store" });
  const json = await res.json().catch(() => null);
  return json?.target?.value;
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

describe("cross-namespace kernel-root collision", () => {
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

  it("an identity that claims an unrelated namespace string cannot write into apps.* under the REAL root's kernel storage", async () => {
    // Alice claims the REAL configured root and writes the genuine page.
    const alice = await claimNamespaceAs(origin, ROOT_NAMESPACE, "alice", "alice-secret");
    const aliceWrite = await commit(origin, alice, [
      { namespace: ROOT_NAMESPACE, path: "apps.gui.pages.home", data: { type: "Typography", props: { children: "real content" } } },
    ]);
    expect(aliceWrite.status).toBe(201);

    // Mallory claims a namespace string that has NOTHING to do with the
    // real root -- her own, unrelated label. This is a legitimate claim
    // in its own right (first-claim-wins on an unclaimed string).
    const FOREIGN_NAMESPACE = "totally-unrelated-name.example";
    const mallory = await claimNamespaceAs(origin, FOREIGN_NAMESPACE, "mallory", "mallory-secret");

    // She commits under HER OWN claimed (foreign) namespace, targeting the
    // exact same apps.gui.pages.home path.
    const malloryWrite = await commit(origin, mallory, [
      { namespace: FOREIGN_NAMESPACE, path: "apps.gui.pages.home", data: { type: "Typography", props: { children: "PWNED" } } },
    ]);

    // This must be rejected -- a claim on an unrelated namespace string
    // must never authorize a write that physically lands in the real
    // root's kernel storage. Silently collapsing to root storage (the
    // namespaceToKernelPrefix fallback for any non-matching namespace) is
    // exactly the "silent fallback acquiring authority" the review called
    // out.
    expect(malloryWrite.status).toBe(403);
    expect(malloryWrite.json.error).toBe("FOREIGN_NAMESPACE_REJECTED");

    // And whatever happened, alice's real content must survive untouched.
    const stillReal = await nrpRead(origin, "apps.gui.pages.home");
    expect((stillReal as any)?.props?.children).toBe("real content");
  });

  it("POST / (rootCommandHandler) also cannot be used to write into the real root's kernel storage via an unresolved host", async () => {
    // Alice claims the REAL configured root and writes the genuine page,
    // same as above.
    const alice = await claimNamespaceAs(origin, ROOT_NAMESPACE, "alice", "alice-secret");
    const aliceWrite = await commit(origin, alice, [
      { namespace: ROOT_NAMESPACE, path: "apps.gui.pages.home", data: { type: "Typography", props: { children: "real content" } } },
    ]);
    expect(aliceWrite.status).toBe(201);

    // POST / (rootCommandHandler, distinct from /api/v1/commit) resolves
    // its OWN write-target namespace from the Host/X-Forwarded-Host header
    // (resolveNamespace -> resolveHostNamespace), not from a body field.
    // A header naming a host this monad doesn't recognize at all (not its
    // own root, not a known projectable space, not a .local/localhost
    // transport address) falls all the way through resolveHostNamespace's
    // own fallback chain to the literal string "unknown" -- which,
    // uncoincidentally, ALSO has no existing claim, so rootCommandHandler's
    // `if (claim) { ...verify signature... }` branch is skipped entirely:
    // this request needs no identity, no claim, no signature at all to
    // reach appendSemanticMemory(). If "unknown" (or any other such
    // fallback string) collapses onto the same kernel-root storage the
    // real root's apps.* data lives in, this is a fully anonymous write
    // primitive onto that data -- worse than the claimed-foreign-namespace
    // case above, since it requires no claim whatsoever.
    const anonymousWrite = await postRoot(
      origin,
      { "x-forwarded-host": "this-host-resolves-to-nothing-recognized.example" },
      { path: "apps.gui.pages.home", value: { type: "Typography", props: { children: "PWNED ANONYMOUSLY" } } },
    );

    // Must be rejected -- an unresolved/foreign host must never grant a
    // write onto real-root kernel storage, signed or not.
    expect(anonymousWrite.status).toBe(403);
    expect(anonymousWrite.json.error).toBe("FOREIGN_NAMESPACE_REJECTED");

    const stillReal = await nrpRead(origin, "apps.gui.pages.home");
    expect((stillReal as any)?.props?.children).toBe("real content");
  });

  it("registering a keychain key under a claimed foreign namespace cannot write into the real root's kernel storage either", async () => {
    // The most dangerous variant of this class: keychain.ts's
    // registerKeychainKey() -- like appAuthorization.ts -- authorizes by
    // getClaim(namespace), the CALLER-CHOSEN string, then writes the new
    // key record via appendSemanticMemory({namespace, path:
    // "keychain.keys.<keyId>", ...}). Before the shared fix in
    // appendSemanticMemory(), a namespace-string collision here would have
    // let an attacker register their OWN admin keychain key onto the REAL
    // root's keychain -- a full takeover primitive, worse than overwriting
    // a page.
    const FOREIGN_NAMESPACE = "another-unrelated-name.example";
    const mallory = await claimNamespaceAs(origin, FOREIGN_NAMESPACE, "mallory", "mallory-secret");

    const branchSeed = await deriveBranchProofSeed("mallory-key-secret", "mallory-keychain-key");
    const { publicKey } = await importEd25519SigningKey(branchSeed);
    const publicKeyRaw = await exportEd25519PublicKey(publicKey);

    const newKey = { publicKey: publicKeyRaw, label: "mallory's key", admin: true };
    const nonce = "test-nonce-1";
    const timestamp = Date.now();
    const signedFieldsBase = { op: "keychain-register", namespace: FOREIGN_NAMESPACE, newKey, nonce, timestamp };
    const signature = await mallory.sign(normalizeProofMessage(signedFieldsBase));

    const res = await post(origin, "/api/v1/keychain/keys", {
      ...signedFieldsBase,
      identityHash: mallory.identityHash,
      signature,
    });

    // Must be rejected before it ever reaches the real root's keychain
    // branch -- a claim on an unrelated namespace string must never let
    // its holder register a key that physically lands there.
    expect(res.status).not.toBe(201);

    // And the real root's keychain must remain genuinely empty -- nobody
    // (least of all mallory) snuck an admin key onto it.
    const keysRes = await fetch(`${origin}/api/v1/keychain/keys?namespace=${encodeURIComponent(ROOT_NAMESPACE)}`);
    const keysJson = await keysRes.json();
    expect(Array.isArray(keysJson.keys) ? keysJson.keys.length : -1).toBe(0);
  });
});
