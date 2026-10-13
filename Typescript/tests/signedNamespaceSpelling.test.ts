/**
 * signedNamespaceSpelling.test.ts -- a client signs the namespace it HOLDS; the monad resolves identities by the
 * canonical form.
 *
 * `quinn.localhost` and `quinn.<this-machine>.local` are the same identity (a loopback host constant is an alias for
 * this machine's root: identity.ts canonicalizeNamespaceConstant). A client -- the GUI's keychainClient.ts, or any other --
 * puts the namespace it has into the payload it signs and into the request body. The server used to rebuild the signed
 * fields with the CANONICAL spelling, so the bytes it verified were not the bytes that were signed, and the first
 * keychain registration of any identity addressed as `<handle>.localhost` answered 403 PROOF_INVALID.
 *
 * The signature must be verified over the spelling that was sent, as long as it resolves to the same identity. A proof
 * made over one spelling is still not valid for another spelling, and a proof made for another namespace is refused.
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createMonadApp } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";
import { resetKeychainNonceCacheForTests } from "../src/claim/keychain";
import { normalizeNamespaceIdentity } from "../src/namespace/identity";
import {
  deriveBranchProofSeed,
  importEd25519SigningKey,
  normalizeProofMessage,
  signEd25519Proof,
// @ts-expect-error -- no .d.ts resolution across this relative path; the runtime import reaches the workspace build.
} from "../../../me/Typescript/dist/me.es.js";

// What the client calls the root ("localhost") and what this machine's monad is configured with (its canonical local
// root) are two spellings of the same root; a one-label root cannot be a configured space.
const ALIAS_ROOT = "localhost";
const ROOT = normalizeNamespaceIdentity(ALIAS_ROOT);

async function startServer(runtimeRoot: string) {
  const app = await createMonadApp({
    cwd: runtimeRoot,
    seed: "test-seed-signed-spelling",
    namespace: ROOT,
    stateDir: path.join(runtimeRoot, "me-state"),
    claimDir: path.join(runtimeRoot, "claims"),
    selfConfigPath: path.join(runtimeRoot, "self.json"),
  });
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function post(origin: string, urlPath: string, body: unknown) {
  const res = await fetch(`${origin}${urlPath}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

async function claim(origin: string, username: string, secret: string, spelling: string) {
  const branchSeed = await deriveBranchProofSeed(secret, username);
  const { privateKey, publicKey } = await importEd25519SigningKey(branchSeed);
  const publicKeyRaw = Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64url");
  const timestamp = Date.now();
  const message = normalizeProofMessage({ identityHash: username, expression: username, namespace: spelling, rootNamespace: ALIAS_ROOT, challenge: null, timestamp });
  const res = await post(origin, "/", {
    operation: "claim", namespace: spelling, secret, identityHash: username,
    proof: { message, signature: await signEd25519Proof(privateKey, message), publicKey: publicKeyRaw, timestamp },
  });
  if (res.status !== 201) throw new Error(`claim ${spelling}: ${res.status} ${JSON.stringify(res.json)}`);
  return { identityHash: username, sign: (m: string) => signEd25519Proof(privateKey, m) };
}

async function deviceKey() {
  const { privateKey, publicKey } = await importEd25519SigningKey(crypto.getRandomValues(new Uint8Array(32)));
  return {
    publicKeyRaw: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64url"),
    sign: (m: string) => signEd25519Proof(privateKey, m),
  };
}
const nonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");

/** First key, signed by the claim's own key over `signedNamespace`, sent as `sentNamespace`. */
async function registerFirst(origin: string, who: { identityHash: string; sign(m: string): Promise<string> }, key: { publicKeyRaw: string }, signedNamespace: string, sentNamespace: string) {
  const n = nonce(); const timestamp = Date.now();
  const newKey = { publicKey: key.publicKeyRaw, label: "laptop" };
  const signature = await who.sign(normalizeProofMessage({ op: "keychain-register", namespace: signedNamespace, newKey, nonce: n, timestamp, identityHash: who.identityHash }));
  return post(origin, "/api/v1/keychain/keys", { namespace: sentNamespace, identityHash: who.identityHash, newKey, nonce: n, timestamp, signature });
}

describe("a signed payload is verified over the namespace spelling that was sent", () => {
  let server: Server;
  let origin: string;
  let runtimeRoot: string;
  const alias = `quinn.${ALIAS_ROOT}`;
  const canonical = normalizeNamespaceIdentity(alias);

  beforeEach(async () => {
    resetKernelStateForTests();
    resetKeychainNonceCacheForTests();
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monad-signed-spelling-"));
    ({ server, origin } = await startServer(runtimeRoot));
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    resetKernelStateForTests();
    resetKeychainNonceCacheForTests();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it("the alias really is another spelling of the same identity", () => {
    expect(alias).not.toBe(canonical);
    expect(canonical.startsWith("quinn.")).toBe(true);
  });

  it("registers the first key, then another by it, signs and revokes -- all addressed as <handle>.localhost", async () => {
    const quinn = await claim(origin, "quinn", "quinn-secret", alias);
    const k1 = await deviceKey();
    const first = await registerFirst(origin, quinn, k1, alias, alias);
    expect(first.status).toBe(201);
    expect(first.json.key.admin).toBe(true);
    const k1Id = first.json.key.keyId as string;

    // post-bootstrap: an active admin key vouches for the next one (the acting-key path)
    const k2 = await deviceKey();
    const n2 = nonce(); const t2 = Date.now();
    const newKey2 = { publicKey: k2.publicKeyRaw, label: "phone", admin: false };
    const reg2 = await post(origin, "/api/v1/keychain/keys", {
      namespace: alias, actingKeyId: k1Id, newKey: newKey2, nonce: n2, timestamp: t2,
      signature: await k1.sign(normalizeProofMessage({ op: "keychain-register", namespace: alias, newKey: newKey2, nonce: n2, timestamp: t2, actingKeyId: k1Id })),
    });
    expect(reg2.status).toBe(201);
    const k2Id = reg2.json.key.keyId as string;

    // sign an operation with the second key
    const n3 = nonce(); const t3 = Date.now();
    const signRes = await post(origin, `/api/v1/keychain/keys/${k2Id}/sign`, {
      namespace: alias, payload: { op: "ping" }, nonce: n3, timestamp: t3,
      signature: await k2.sign(normalizeProofMessage({ op: "keychain-sign", namespace: alias, keyId: k2Id, payload: { op: "ping" }, nonce: n3, timestamp: t3 })),
    });
    expect(signRes.status).toBe(200);

    // revoke it with the first
    const n4 = nonce(); const t4 = Date.now();
    const revoke = await post(origin, `/api/v1/keychain/keys/${k2Id}/revoke`, {
      namespace: alias, actingKeyId: k1Id, nonce: n4, timestamp: t4,
      signature: await k1.sign(normalizeProofMessage({ op: "keychain-revoke", namespace: alias, actingKeyId: k1Id, targetKeyId: k2Id, nonce: n4, timestamp: t4 })),
    });
    expect(revoke.status).toBe(200);
  });

  it("a client that holds the canonical spelling keeps working", async () => {
    const quinn = await claim(origin, "quinn", "quinn-secret", alias);
    const res = await registerFirst(origin, quinn, await deviceKey(), canonical, canonical);
    expect(res.status).toBe(201);
  });

  it("a proof made over one spelling is not valid for another", async () => {
    const quinn = await claim(origin, "quinn", "quinn-secret", alias);
    const signedAlias = await registerFirst(origin, quinn, await deviceKey(), alias, canonical);
    expect(signedAlias.status).toBe(403);
    expect(signedAlias.json.error).toBe("PROOF_INVALID");
  });

  it("a proof made for another namespace is refused", async () => {
    const quinn = await claim(origin, "quinn", "quinn-secret", alias);
    const res = await registerFirst(origin, quinn, await deviceKey(), "quinn.other.me", alias);
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("PROOF_INVALID");
  });
});
