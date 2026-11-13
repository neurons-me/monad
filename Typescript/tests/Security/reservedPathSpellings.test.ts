/**
 * reservedPathSpellings.test.ts -- generic writes cannot reach the monad's own registry, whatever the spelling.
 *
 * Found 2026-11-13 on a disposable monad: with the root namespace unclaimed (the production condition), an UNSIGNED
 * `POST /` with `path: "daemon.claims.<ns>"` created or replaced another namespace's claim record -- its key -- and the
 * kernel also reads bracket spellings (`daemon["claims"]`, `daemon[claims]`), a padded segment and the `expression`
 * field, which every reserved-path guard compared only in dot form. Now daemon.* is reserved outright, and the shared
 * canonicalization (replay.ts canonicalizeWritePath) folds brackets and per-segment spaces the way the kernel does, so
 * the keychain, gateway-authority, routing-record, telemetry and other-namespace guards see the same path the kernel
 * would write. Refusals change nothing; ordinary writes still work.
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
import { getClaim } from "../../src/claim/records";
import { canonicalizeWritePath, toStableJson } from "../../src/claim/replay";

const ROOT = "reserved-spellings.test";
const VICTIM = `victim.${ROOT}`;
const VKEY = "victim__reserved-spellings__test";
let server: Server;
let origin: string;
let dir: string;
let victimKey: { pub: string; sign: (m: string) => Promise<string> };

async function post(p: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${origin}${p}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}
const errorOf = (r: { json: any }) => r.json?.error ?? r.json?.target?.error;
const ownMemories = () => getKernelMemoryLog().filter((m: any) => !String(m.path).startsWith("surface."));
const head = async (ns: string) => (await (await fetch(`${origin}/api/v1/write-head?namespace=${ns}`)).json())?.expectedHeadHash;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-reserved-spellings-"));
  resetKernelStateForTests();
  delete process.env.MONAD_INTERNAL_TOKEN;
  const app = await createMonadApp({ cwd: dir, seed: "reserved-spellings-seed", namespace: ROOT, stateDir: path.join(dir, "s"), claimDir: path.join(dir, "c"), selfConfigPath: path.join(dir, "self.json") });
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { privateKey, publicKey } = await importEd25519SigningKey(await deriveBranchProofSeed("victim-secret", "victim"));
  victimKey = { pub: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64url"), sign: (m) => signEd25519Proof(privateKey, m) as Promise<string> };
  const message = normalizeProofMessage({ identityHash: "id-victim", expression: "victim", namespace: VICTIM, rootNamespace: ROOT, challenge: null, timestamp: Date.now() });
  const claimed = await post("/", { operation: "claim", namespace: VICTIM, identityHash: "id-victim", proof: { message, signature: await victimKey.sign(message), publicKey: victimKey.pub, timestamp: Date.now() } });
  assert.equal(claimed.status, 201, JSON.stringify(claimed.json));
  assert.equal(getClaim(ROOT), undefined, "the root stays unclaimed (the production condition)");
});

afterAll(async () => {
  await new Promise((r) => server.close(() => r(null)));
  resetKernelStateForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("canonicalizeWritePath folds what the kernel folds", () => {
  it("brackets, quotes, slashes and padded segments", () => {
    for (const [input, out] of [
      ['daemon["claims"]["x"]', "daemon.claims.x"], ["daemon['claims'].x", "daemon.claims.x"], ["daemon[claims][x]", "daemon.claims.x"],
      ["daemon/claims/x", "daemon.claims.x"], [" daemon .claims. x", "daemon.claims.x"], ['users["alice"].profile', "users.alice.profile"],
      ["profile.email", "profile.email"],
    ]) assert.equal(canonicalizeWritePath(input), out, input);
  });
});

describe("unsigned root writes cannot reach daemon.* or another namespace, in any spelling", () => {
  it("every spelling is refused and nothing changes", async () => {
    const claimBefore = JSON.stringify(getClaim(VICTIM));
    const memBefore = ownMemories().length;
    const victimHeadBefore = await head(VICTIM);
    const forged = { namespace: VICTIM, identityHash: "attacker", publicKey: "attacker-key", createdAt: 1, updatedAt: 1 };
    const attempts: Array<[string, Record<string, unknown>, string]> = [
      ["dots", { path: `daemon.claims.${VKEY}`, value: forged }, "DAEMON_PATH_RESERVED"],
      ["quoted brackets", { path: `daemon["claims"]["${VKEY}"]`, value: forged }, "DAEMON_PATH_RESERVED"],
      ["bare brackets", { path: `daemon[claims][${VKEY}]`, value: forged }, "DAEMON_PATH_RESERVED"],
      ["slashes", { path: `daemon/claims/${VKEY}/identityHash`, value: "attacker" }, "DAEMON_PATH_RESERVED"],
      ["padded segment", { path: ` daemon .claims.${VKEY}`, value: forged }, "DAEMON_PATH_RESERVED"],
      ["expression field", { expression: `daemon.claims.${VKEY}`, value: forged }, "DAEMON_PATH_RESERVED"],
      ["parent object", { path: "daemon.claims", value: { [VKEY]: forged } }, "DAEMON_PATH_RESERVED"],
      ["handle directory", { path: `daemon.users.${ROOT.replace(/\./g, "__")}.victim`, value: { __ptr: "elsewhere" } }, "DAEMON_PATH_RESERVED"],
      ["gateway authority, brackets", { path: 'daemon["gateways"]["gw"]', value: { owner: "attacker" } }, "GATEWAY_PATH_REQUIRES_GATEWAY_API"],
      ["root keychain, brackets", { path: 'keychain["keys"]["k"]', value: { authorization: "active", admin: true } }, "KEYCHAIN_PATH_REQUIRES_KEYCHAIN_API"],
      ["another namespace's storage, brackets", { path: 'users["victim"].profile.email', value: "attacker@example.com" }, "CANNOT_WRITE_ANOTHER_NAMESPACES_STORAGE"],
      ["routing records, brackets", { path: 'users["victim"]["domains"]["evil__DOT__test"]', value: { target: "http://evil" } }, ""],
    ];
    for (const [label, body, error] of attempts) {
      const r = await post("/", body, { "x-forwarded-host": ROOT });
      assert.equal(r.status, 403, `${label}: ${r.status} ${JSON.stringify(r.json)}`);
      if (error) assert.equal(errorOf(r), error, label);
    }
    assert.equal(JSON.stringify(getClaim(VICTIM)), claimBefore, "the victim's claim record is untouched");
    assert.equal(ownMemories().length, memBefore, "no memory written by any refusal");
    assert.equal(await head(VICTIM), victimHeadBefore, "the victim's write head is untouched");
  });

  it("a signed commit cannot carry daemon.* events either", async () => {
    const expectedHeadHash = await head(VICTIM);
    const fields = { events: [{ namespace: VICTIM, path: 'daemon["claims"].x', data: "x" }], identityHash: "id-victim", namespace: VICTIM, expectedHeadHash };
    const r = await post("/api/v1/commit", { ...fields, signature: await victimKey.sign(normalizeProofMessage(fields)) });
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.equal(errorOf(r), "DAEMON_PATH_RESERVED");
  });

  it("ordinary writes still work: an unclaimed root path, and the owner's signed write", async () => {
    assert.equal((await post("/", { path: "notes.hello", value: "world" }, { "x-forwarded-host": ROOT })).status, 200);
    const expectedHeadHash = await head(VICTIM);
    const fields = { path: "profile.email", value: "victim@example.com", namespace: VICTIM, expectedHeadHash };
    const canonical = toStableJson(fields);
    const r = await post("/", { ...fields, signedPayload: canonical, signature: await victimKey.sign(canonical) }, { "x-forwarded-host": VICTIM });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  });
});
