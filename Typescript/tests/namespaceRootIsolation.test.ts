/**
 * namespaceRootIsolation.test.ts -- an address that is not the root does not receive the root's directory.
 *
 * GET / used to answer, for ANY host, the directory of users of the namespace's projection root (usernames and identity
 * hashes of everyone under it) next to that address's own blocks: `alice.localhost` and a name nobody ever created both
 * showed the root's users. That is content of another context. The root's own address still answers its directory; an
 * address that is a user under it answers that user's own row and nothing else; a name that is nobody's answers none.
 */
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
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

const ALIAS_ROOT = "localhost";
const ROOT = normalizeNamespaceIdentity(ALIAS_ROOT);   // this machine's canonical root

async function startServer(runtimeRoot: string) {
  const app = await createMonadApp({
    cwd: runtimeRoot, seed: "test-seed-root-isolation", namespace: ROOT,
    stateDir: path.join(runtimeRoot, "me-state"), claimDir: path.join(runtimeRoot, "claims"), selfConfigPath: path.join(runtimeRoot, "self.json"),
  });
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function claim(origin: string, username: string) {
  const namespace = `${username}.${ALIAS_ROOT}`;
  const { privateKey, publicKey } = await importEd25519SigningKey(await deriveBranchProofSeed(`${username}-secret`, username));
  const publicKeyRaw = Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64url");
  const timestamp = Date.now();
  const message = normalizeProofMessage({ identityHash: username, expression: username, namespace, rootNamespace: ALIAS_ROOT, challenge: null, timestamp });
  const res = await fetch(`${origin}/`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "claim", namespace, secret: `${username}-secret`, identityHash: username,
      proof: { message, signature: await signEd25519Proof(privateKey, message), publicKey: publicKeyRaw, timestamp } }),
  });
  if (res.status !== 201) throw new Error(`claim ${username}: ${res.status} ${await res.text()}`);
}

const readRoot = (origin: string, host: string) => new Promise<{ status: number; text: string; json: any }>((resolve, reject) => {
  const u = new URL(origin);
  const req = http.request({ host: u.hostname, port: u.port, path: "/", method: "GET", headers: { Host: host, Accept: "application/json" } }, (res) => {
    let text = ""; res.on("data", (c) => (text += c));
    res.on("end", () => { let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, text, json }); });
  });
  req.on("error", reject); req.end();
});
const request = (origin: string, host: string, method: string, urlPath: string, body?: unknown) => new Promise<{ status: number; text: string; json: any }>((resolve, reject) => {
  const u = new URL(origin);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = http.request({ host: u.hostname, port: u.port, path: urlPath, method, headers: { Host: host, Accept: "application/json", ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) } }, (res) => {
    let text = ""; res.on("data", (c) => (text += c));
    res.on("end", () => { let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, text, json }); });
  });
  req.on("error", reject); if (payload) req.write(payload); req.end();
});
const names = (r: { json: any }) => (r.json?.users ?? []).map((u: any) => u.username).sort();

describe("an address that is not the root does not receive the root's directory", () => {
  let server: Server; let origin: string; let runtimeRoot: string;
  beforeEach(async () => {
    resetKernelStateForTests(); resetKeychainNonceCacheForTests();
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monad-root-isolation-"));
    ({ server, origin } = await startServer(runtimeRoot));
    await claim(origin, "alice");
    await claim(origin, "bob");
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    resetKernelStateForTests(); resetKeychainNonceCacheForTests();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it("the root's own address answers the directory (unchanged)", async () => {
    for (const host of [ALIAS_ROOT, ROOT]) {
      const r = await readRoot(origin, host);
      expect(r.status).toBe(200);
      expect(names(r)).toEqual(["alice", "bob"]);
    }
  });

  it("an address that is a user under the root never answers the directory, and never another user", async () => {
    // What the resolver makes of `alice.localhost` depends on the `me` build (a one-label root is known to 4.2.0+; before, the
    // host is "unknown"): the contract holds either way -- at most the user's own row, never someone else's.
    for (const host of [`alice.${ALIAS_ROOT}`, `alice.${ROOT}`]) {
      const r = await readRoot(origin, host);
      expect(r.status).toBe(200);
      expect(names(r).filter((n: string) => n !== "alice")).toEqual([]);
      expect(r.text).not.toContain("bob");
    }
  });

  it("a name nobody created answers no users at all, and none of the root's", async () => {
    for (const host of [`whatever.${ALIAS_ROOT}`, `whatever.${ROOT}`, `a.b.${ALIAS_ROOT}`, "not-a-known-space.example"]) {
      const r = await readRoot(origin, host);
      expect(names(r)).toEqual([]);
      expect(r.text).not.toContain("alice");
      expect(r.text).not.toContain("bob");
    }
  });

  it("a read by IP is the root's, as before (what the directory consumers use)", async () => {
    const r = await readRoot(origin, new URL(origin).host);
    expect(names(r)).toEqual(["alice", "bob"]);
  });
});

describe("nothing of the root is delivered to a name that is not the root -- the WHOLE response, and a datum read by path", () => {
  let server: Server; let origin: string; let runtimeRoot: string;
  const MARKER = "root-only-datum-7f3a91c2";
  beforeEach(async () => {
    resetKernelStateForTests(); resetKeychainNonceCacheForTests();
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monad-root-isolation-"));
    ({ server, origin } = await startServer(runtimeRoot));
    await claim(origin, "alice");
    await claim(origin, "bob");
    // a datum that belongs to the root, written at the root's own address
    const w = await request(origin, ROOT, "POST", "/", { path: "profile.motto", value: MARKER, operation: "write" });
    if (w.status >= 300) throw new Error(`could not write the root datum: ${w.status} ${w.text}`);
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    resetKernelStateForTests(); resetKeychainNonceCacheForTests();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  const OTHERS = [`whatever.${ALIAS_ROOT}`, `whatever.${ROOT}`, `a.b.${ALIAS_ROOT}`, "not-a-known-space.example", `alice.${ALIAS_ROOT}`];

  it("control: the datum is readable at the root's own address", async () => {
    const r = await request(origin, ROOT, "GET", "/profile/motto");
    expect(r.status).toBe(200);
    expect(r.text).toContain(MARKER);
  });

  it("a read of that path from any other name never returns the datum, in any part of the response", async () => {
    for (const host of OTHERS) {
      for (const p of ["/profile/motto", "/profile.motto", "/@root/profile/motto"]) {
        const r = await request(origin, host, "GET", p);
        if (r.text.includes(MARKER)) console.log("LEAK", host, p, r.status, r.text.slice(0, 400));
        expect({ host, p, leaked: r.text.includes(MARKER) }).toEqual({ host, p, leaked: false });
      }
    }
  });

  it("the whole of GET / for any other name carries none of the root's data (users, blocks, datum, other users)", async () => {
    for (const host of OTHERS) {
      const r = await request(origin, host, "GET", "/");
      expect(r.status).toBe(200);
      expect({ host, leaked: r.text.includes(MARKER) }).toEqual({ host, leaked: false });
      expect({ host, bob: r.text.includes("bob") }).toEqual({ host, bob: false });
      if (!host.startsWith("alice.")) expect({ host, alice: r.text.includes("alice") }).toEqual({ host, alice: false });
      expect(r.json?.blocks ?? []).toEqual(expect.any(Array));
      for (const b of r.json?.blocks ?? []) expect(JSON.stringify(b)).not.toMatch(/bob/);
    }
  });

  it("an unsigned write that arrives under another name does not land in the root's data", async () => {
    const INJECT = "injected-from-another-name-51d0";
    for (const host of [`whatever.${ALIAS_ROOT}`, "not-a-known-space.example"]) {
      await request(origin, host, "POST", "/", { path: "profile.motto", value: INJECT, operation: "write" });
    }
    const atRoot = await request(origin, ROOT, "GET", "/profile/motto");
    expect(atRoot.text).toContain(MARKER);
    expect(atRoot.text).not.toContain(INJECT);
  });

  it("a read by network address is the monad's own public view: it grants no write and no private path", async () => {
    const ip = new URL(origin).host;
    // it is the same information the root's own address already publishes, nothing more
    const view = await request(origin, ip, "GET", "/");
    expect(view.status).toBe(200);
    expect(names(view)).toEqual(["alice", "bob"]);
    // and a write made by address is not a privileged channel into someone's namespace
    const forged = await request(origin, ip, "POST", "/", { path: "users.alice.profile.email", value: "forged@example.test", operation: "write" });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    // an unclaimed-namespace write guard still applies to reserved branches
    const reserved = await request(origin, ip, "POST", "/", { path: "daemon.gateways.x.owner", value: "me", operation: "write" });
    expect(reserved.status).toBeGreaterThanOrEqual(400);
  });
});
