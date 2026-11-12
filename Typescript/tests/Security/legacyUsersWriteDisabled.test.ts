/**
 * legacyUsersWriteDisabled.test.ts -- POST /users stays closed (http/legacy.ts).
 *
 * It wrote users.<username>.* in the root namespace with no proof; a dotted name reached inside any namespace,
 * claimed ones included (investigation 2026-11-12: a claimed namespace's data changed and its write head moved, an
 * active keychain key was replaced and answered ACTING_KEY_REVOKED, the gateway's domain records were written past the
 * internal-caller guard). Every shape of the old request is refused, and refusing changes nothing: no memory, no
 * write head, no key. A name is still registered by claiming its namespace.
 */
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, describe, it } from "vitest";
import { deriveBranchProofSeed, importEd25519SigningKey, normalizeProofMessage, signEd25519Proof } from "this.me";
import { createMonadApp } from "../../src/index";
import { getKernelMemoryLog, resetKernelStateForTests } from "../../src/kernel/manager";
import { resetKeychainNonceCacheForTests } from "../../src/claim/keychain";

const ROOT = "legacy-users-closed.test";
let server: Server;
let origin: string;
let dir: string;

async function req(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${origin}${p}`, {
    method,
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}
const nonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
async function keyPair(seed?: Uint8Array) {
  const { privateKey, publicKey } = await importEd25519SigningKey(seed ?? crypto.getRandomValues(new Uint8Array(32)));
  return {
    pub: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64url"),
    sign: (m: string) => signEd25519Proof(privateKey, m) as Promise<string>,
  };
}
async function claim(username: string, secret: string) {
  const namespace = `${username}.${ROOT}`;
  const k = await keyPair(await deriveBranchProofSeed(secret, username));
  const message = normalizeProofMessage({ identityHash: username, expression: username, namespace, rootNamespace: ROOT, challenge: null, timestamp: Date.now() });
  const out = await req("POST", "/", { operation: "claim", namespace, identityHash: username, proof: { message, signature: await k.sign(message), publicKey: k.pub, timestamp: Date.now() } });
  return { out, namespace, identityHash: username, key: k };
}
const ownMemories = () => getKernelMemoryLog().filter((m: any) => !String(m.path).startsWith("surface.")); // per-request telemetry excluded
const head = async (ns: string) => { const r = await req("GET", `/api/v1/write-head?namespace=${ns}`); return r.json?.expectedHeadHash ?? r.json?.target?.expectedHeadHash; };

let quinn: Awaited<ReturnType<typeof claim>>;
let device: Awaited<ReturnType<typeof keyPair>>;
let keyId: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-legacy-users-closed-"));
  resetKernelStateForTests(); resetKeychainNonceCacheForTests();
  delete process.env.MONAD_INTERNAL_TOKEN;
  const app = await createMonadApp({ cwd: dir, seed: "legacy-users-closed-seed", namespace: ROOT, stateDir: path.join(dir, "me-state"), claimDir: path.join(dir, "claims"), selfConfigPath: path.join(dir, "self.json") });
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  quinn = await claim("quinn", "quinn-test-secret");
  assert.equal(quinn.out.status, 201, JSON.stringify(quinn.out.json));
  device = await keyPair();
  const fields = { op: "keychain-register", namespace: quinn.namespace, newKey: { publicKey: device.pub, label: "test device" }, nonce: nonce(), timestamp: Date.now(), identityHash: quinn.identityHash };
  const reg = await req("POST", "/api/v1/keychain/keys", { namespace: quinn.namespace, identityHash: quinn.identityHash, newKey: fields.newKey, nonce: fields.nonce, timestamp: fields.timestamp, signature: await quinn.key.sign(normalizeProofMessage(fields)) });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  keyId = reg.json.key.keyId;
});

afterAll(async () => {
  await new Promise((r) => server.close(() => r(null)));
  resetKernelStateForTests(); resetKeychainNonceCacheForTests();
  delete process.env.MONAD_INTERNAL_TOKEN;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("POST /users is closed", () => {
  it("every shape of the old request is refused, and nothing changes: memories, write head, keys", async () => {
    const memBefore = ownMemories().length;
    const headBefore = await head(quinn.namespace);
    const keyBefore = (await req("GET", `/api/v1/keychain/keys/${keyId}?namespace=${quinn.namespace}`)).json?.key;
    assert.equal(keyBefore?.authorization, "active");

    const attacker = await keyPair();
    const names = [
      "ghost", "quinn", "QUINN", "quinn.profile", `quinn.keychain.keys.${keyId}`, "netget.domains.evil__dot__test",
      "netget.domainindex.x", "quinn.auth", "users.quinn", "",
    ];
    for (const username of names) {
      for (const p of ["/users", "/users/", "/USERS"]) {
        const out = await req("POST", p, { username, identityHash: "injected-hash", publicKey: attacker.pub });
        assert.ok(out.status >= 400, `${p} ${username}: ${out.status}`);
        assert.notEqual(out.json?.ok, true, `${p} ${username}`);
      }
      for (const host of [ROOT, quinn.namespace]) {
        const out = await req("POST", "/users", { username, identityHash: "injected-hash", publicKey: attacker.pub }, { "x-forwarded-host": host });
        assert.equal(out.status, 410, `${host} ${username}`);
      }
    }
    const plain = await req("POST", "/users", { username: "ghost", identityHash: "h", publicKey: "p" });
    assert.equal(plain.status, 410);
    assert.equal(plain.json?.error ?? plain.json?.target?.error, "LEGACY_USERS_WRITE_DISABLED");

    assert.equal(ownMemories().length, memBefore, "no memory appended");
    assert.equal(await head(quinn.namespace), headBefore, "write head unchanged");
    const keyAfter = (await req("GET", `/api/v1/keychain/keys/${keyId}?namespace=${quinn.namespace}`)).json?.key;
    assert.deepEqual(keyAfter, keyBefore, "key record unchanged");
    assert.equal((await req("GET", "/users/ghost")).status, 404, "no directory entry was created");

    // The key still works for its owner, and the attacker's key still does not.
    const op = async (k: { sign: (m: string) => Promise<string> }) => {
      const f = { op: "keychain-sign", namespace: quinn.namespace, keyId, payload: { op: "ping" }, nonce: nonce(), timestamp: Date.now() };
      return req("POST", `/api/v1/keychain/keys/${keyId}/sign`, { namespace: quinn.namespace, payload: f.payload, nonce: f.nonce, timestamp: f.timestamp, signature: await k.sign(normalizeProofMessage(f)) });
    };
    assert.equal((await op(device)).status, 200);
    assert.equal((await op(attacker)).status, 403);
  });

  it("registering a name by claiming its namespace still works, and the directory shows it", async () => {
    const out = await claim("newcomer", "newcomer-test-secret");
    assert.equal(out.out.status, 201, JSON.stringify(out.out.json));
    const row = await req("GET", "/users/newcomer");
    assert.equal(row.status, 200);
    assert.equal(row.json?.user?.identityHash, "newcomer");
    const message = normalizeProofMessage({ identityHash: "newcomer", expression: "newcomer", namespace: out.namespace, rootNamespace: ROOT, challenge: `open:${nonce()}`, timestamp: Date.now() });
    const open = await req("POST", "/claims/signIn", { namespace: out.namespace, proof: { message, signature: await out.key.sign(message), publicKey: out.key.pub, timestamp: Date.now() } });
    assert.equal(open.status, 200, JSON.stringify(open.json));
  });
});
