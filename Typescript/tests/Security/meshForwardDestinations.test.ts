/**
 * meshForwardDestinations.test.ts -- the mesh may not be used to make this monad fetch what only it can reach.
 *
 * Before (measured on a disposable monad, 2026-11-13): POST /.mesh/announce signed with ANY freshly generated key was
 * accepted as `verified` when no operator allowlist was set; its endpoint could be http://127.0.0.1:<port>; one
 * GET /resolve for that namespace then made the monad fetch the loopback URL and return the body to the caller --
 * also for the monad's own unclaimed root namespace.
 *
 * Now: no allowlist -> no announce is accepted and nothing is written; with one, only signed, fresh announces from a
 * listed key, with an endpoint that is not loopback/link-local (literal or `localhost`); and the bridge refuses to
 * forward to an announced endpoint whose name resolves to such an address, or to a private one unless the operator
 * allows it. Entries this monad wrote itself (no `status`) still reach sibling monads on loopback.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { createMonadApp } from "../../src/index";
import { resetKernelStateForTests } from "../../src/kernel/manager";
import { readMonadIndexEntry, writeMonadIndexEntry } from "../../src/kernel/monadIndex";
import { resetAnnounceThrottleForTests } from "../../src/http/meshAnnounce";
import { classifyAddress } from "../../src/http/meshForwardPolicy";
import { toStableJson } from "../../src/claim/replay";

const ROOT = "mesh-forward.test";
let dir: string;
let server: http.Server;
let marker: http.Server;
let base: string;
let markerPort: number;
const hits: string[] = [];
const realFetch = globalThis.fetch;
const outbound: string[] = [];

async function get(p: string) {
  const res = await realFetch(base + p, { headers: { accept: "application/json", "x-forwarded-host": ROOT } });
  return { status: res.status, text: await res.text() };
}
async function announce(fields: Record<string, unknown>, privateKey: crypto.KeyObject, publicPem: string) {
  const signed = { monad_id: fields.monad_id, namespace: fields.namespace, endpoint: fields.endpoint, claimed_namespaces: [fields.namespace], identity_hash: "", timestamp: Date.now() };
  const signature = crypto.sign(null, Buffer.from(toStableJson(signed)), privateKey).toString("base64");
  const res = await realFetch(base + "/.mesh/announce", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-host": ROOT },
    body: JSON.stringify({ ...signed, public_key: publicPem, signature }),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}
const resolve = (ns: string, p = "secret") => get(`/resolve?target=${encodeURIComponent(`me://${ns}:read/${p}`)}`);
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { privateKey, publicPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}
function verifiedEntry(monadId: string, namespace: string, endpoint: string, status?: "verified") {
  const now = Date.now();
  writeMonadIndexEntry({ monad_id: monadId, namespace, endpoint, claimed_namespaces: [namespace], first_seen: now, last_seen: now, ...(status ? { status } : {}) } as any);
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-mesh-forward-"));
  resetKernelStateForTests();
  delete process.env.MONAD_TRUSTED_ANNOUNCE_KEYS_FILE;
  delete process.env.MONAD_MESH_ALLOW_PRIVATE_ENDPOINTS;
  delete process.env.MONAD_SYNTHESIS_ENABLED;
  marker = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ marker: "INTERNAL-ONLY" })); });
  await new Promise<void>((r) => marker.listen(0, "127.0.0.1", () => r()));
  markerPort = (marker.address() as AddressInfo).port;
  // Outbound requests are recorded; only loopback ever leaves the process (the private-range case is answered here).
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    outbound.push(url);
    if (/^https?:\/\/10\.255\.255\.1(:|\/)/.test(url)) return new Response(JSON.stringify({ ok: true, value: "lan" }), { headers: { "content-type": "application/json" } });
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(url)) throw new Error("test: non-loopback fetch blocked: " + url);
    return realFetch(input, init);
  }) as typeof fetch;
  const app = await createMonadApp({ cwd: dir, seed: "mesh-forward-test-seed", namespace: ROOT, stateDir: path.join(dir, "me-state"), claimDir: path.join(dir, "claims"), selfConfigPath: path.join(dir, "self.json") });
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  delete process.env.MONAD_TRUSTED_ANNOUNCE_KEYS_FILE;
  delete process.env.MONAD_MESH_ALLOW_PRIVATE_ENDPOINTS;
  resetAnnounceThrottleForTests();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise((r) => server.close(() => r(null)));
  await new Promise((r) => marker.close(() => r(null)));
  resetKernelStateForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("announces fail closed", () => {
  it("with no operator allowlist, a self-signed announce is refused, nothing is stored, and /resolve fetches nothing", async () => {
    const k = keypair();
    for (const ns of ["victim.test", ROOT]) {
      const before = hits.length;
      const a = await announce({ monad_id: `evil-${ns}`, namespace: ns, endpoint: `http://127.0.0.1:${markerPort}` }, k.privateKey, k.publicPem);
      assert.equal(a.status, 403, JSON.stringify(a.json));
      assert.equal(a.json.error, "MESH_ANNOUNCE_DISABLED");
      assert.equal(readMonadIndexEntry(`evil-${ns}`), undefined);
      await resolve(ns);
      assert.equal(hits.length, before, `the marker was reached for ${ns}`);
    }
  });

  it("with an allowlist: an unlisted key is refused, and a listed key cannot announce a loopback endpoint", async () => {
    const listed = keypair();
    const stranger = keypair();
    const file = path.join(dir, "trusted.json");
    fs.writeFileSync(file, JSON.stringify({ keys: [listed.publicPem.trim()] }));
    process.env.MONAD_TRUSTED_ANNOUNCE_KEYS_FILE = file;

    const s = await announce({ monad_id: "stranger", namespace: "victim.test", endpoint: "https://node.example.test" }, stranger.privateKey, stranger.publicPem);
    assert.equal(s.status, 403); assert.equal(s.json.error, "ANNOUNCE_NOT_TRUSTED");
    assert.equal(readMonadIndexEntry("stranger"), undefined);

    for (const [i, endpoint] of [`http://127.0.0.1:${markerPort}`, `http://localhost:${markerPort}`, "http://[::1]:80", "http://169.254.169.254", "http://0.0.0.0:80", "file:///etc/passwd"].entries()) {
      const a = await announce({ monad_id: `listed-${i}`, namespace: "victim.test", endpoint }, listed.privateKey, listed.publicPem);
      assert.equal(a.status, 400, `${endpoint}: ${JSON.stringify(a.json)}`);
      assert.equal(a.json.error, "ENDPOINT_NOT_ALLOWED");
      assert.equal(readMonadIndexEntry(`listed-${i}`), undefined);
    }
    const ok = await announce({ monad_id: "listed-ok", namespace: "peer.test", endpoint: "https://node.example.test" }, listed.privateKey, listed.publicPem);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.status, "verified");
  });
});

describe("the bridge checks where an announced endpoint really points", () => {
  it("a stored announced entry whose NAME resolves to loopback is not fetched", async () => {
    verifiedEntry("named-loopback", "named.test", `http://localhost:${markerPort}`, "verified");
    const before = hits.length;
    const r = await resolve("named.test");
    assert.equal(hits.length, before, r.text);
    assert.notEqual(r.status, 200);
  });

  it("a private address is refused unless the operator allows private endpoints", async () => {
    verifiedEntry("lan-node", "lan.test", "http://10.255.255.1:8161", "verified");
    let r = await resolve("lan.test");
    assert.ok(!outbound.some((u) => u.startsWith("http://10.255.255.1")), "fetched a private address by default");
    assert.notEqual(r.status, 200);
    process.env.MONAD_MESH_ALLOW_PRIVATE_ENDPOINTS = "1";
    r = await resolve("lan.test");
    assert.ok(outbound.some((u) => u.startsWith("http://10.255.255.1")), r.text);
  });

  it("entries this monad wrote itself (no announce status) still reach a sibling on loopback", async () => {
    verifiedEntry("sibling", "sibling.test", `http://127.0.0.1:${markerPort}`);
    const before = hits.length;
    const r = await resolve("sibling.test", "x");
    assert.equal(r.status, 200, r.text);
    assert.equal(hits.length, before + 1);
  });
});

describe("address classes", () => {
  it("classifies loopback, metadata, mapped, private and public addresses", () => {
    for (const ip of ["127.0.0.1", "127.9.9.9", "::1", "[::1]", "::ffff:127.0.0.1", "169.254.169.254", "fd00:ec2::254", "0.0.0.0", "::", "fe80::1", "224.0.0.1", "255.255.255.255", "not-an-ip"]) {
      assert.equal(classifyAddress(ip), "blocked", ip);
    }
    for (const ip of ["10.1.2.3", "172.16.0.1", "192.168.1.10", "100.64.0.1", "fd12::1", "::ffff:192.168.1.1"]) {
      assert.equal(classifyAddress(ip), "private", ip);
    }
    for (const ip of ["8.8.8.8", "2606:4700::1111"]) assert.equal(classifyAddress(ip), "public", ip);
  });
});
