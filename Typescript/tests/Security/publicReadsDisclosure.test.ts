/**
 * publicReadsDisclosure.test.ts -- what the public reads say, and what they no longer say.
 *
 * GET /api/v1/claim-status answers whether a namespace is claimed (and since when) to anyone -- what a page needs to
 * show a namespace live -- and nothing about the identity: no identityHash, no public key (for a v1 identity both come
 * from one fast hash of name + secret: a target for guessing the secret offline).
 *
 * /__surface, /__bootstrap and /__surface/events answer any origin; they used to carry the last 120 requests (paths,
 * namespaces looked up), and the stream pushed every request live. Now individual requests only reach a caller with
 * this process's internal token; the aggregates stay public.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createMonadApp } from "../../src/index";
import { resetKernelStateForTests } from "../../src/kernel/manager";
import { claimNamespace } from "../../src/claim/records";
import { buildClaimProof } from "../helpers/claimProof";

const ROOT = "claim-status.test";
const TOKEN = "public-reads-test-token";
let dir: string;
let server: Server;
let base: string;
let claimed: { identityHash: string; publicKey: string };

const get = async (p: string, internal = false) => {
  const res = await fetch(base + p, { headers: { accept: "application/json", "x-forwarded-host": ROOT, ...(internal ? { "x-monad-internal-token": TOKEN } : {}) } });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
};
const recent = (json: any) => json?.surfaceEntry?.monitor?.recentRequests ?? json?.target?.surfaceEntry?.monitor?.recentRequests;

/** Opens the event stream, makes one request while it is open, and returns what the stream sent. */
async function streamAround(internal: boolean, during: () => Promise<unknown>) {
  const ctrl = new AbortController();
  const res = await fetch(base + "/__surface/events", { headers: { accept: "text/event-stream", "x-forwarded-host": ROOT, ...(internal ? { "x-monad-internal-token": TOKEN } : {}) }, signal: ctrl.signal });
  const reader = res.body!.getReader();
  let text = "";
  const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); } } catch { /* aborted */ } })();
  await new Promise((r) => setTimeout(r, 150));
  await during();
  await new Promise((r) => setTimeout(r, 400));
  ctrl.abort();
  await pump;
  return text;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "monad-public-reads-"));
  resetKernelStateForTests();
  process.env.MONAD_INTERNAL_TOKEN = TOKEN;
  const app = await createMonadApp({ cwd: dir, seed: "public-reads-test-seed", namespace: ROOT, stateDir: path.join(dir, "me-state"), claimDir: path.join(dir, "claims"), selfConfigPath: path.join(dir, "self.json") });
  process.env.MONAD_INTERNAL_TOKEN = TOKEN; // the app may have resolved its own; the test's is the one it checks
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const identityHash = "c".repeat(64);
  const out = await claimNamespace({ namespace: `ana.${ROOT}`, secret: "ana-secret", identityHash, proof: await buildClaimProof({ namespace: `ana.${ROOT}`, identityHash }) });
  assert.equal(out.ok, true, JSON.stringify(out));
  claimed = { identityHash: out.ok ? out.record.identityHash : "", publicKey: out.ok ? out.record.publicKey : "" };
});

afterAll(async () => {
  await new Promise((r) => server.close(() => r(null)));
  resetKernelStateForTests();
  delete process.env.MONAD_INTERNAL_TOKEN;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/v1/claim-status", () => {
  it("says whether a namespace is claimed, and since when", async () => {
    const yes = await get(`/api/v1/claim-status?namespace=ana.${ROOT}`);
    assert.equal(yes.status, 200);
    assert.equal(yes.json.claimed, true);
    assert.equal(yes.json.target?.namespace?.me ?? yes.json.namespace, `ana.${ROOT}`);
    assert.equal(typeof yes.json.since, "number");
    const no = await get(`/api/v1/claim-status?namespace=nobody.${ROOT}`);
    assert.equal(no.status, 200);
    assert.equal(no.json.claimed, false);
    assert.equal(no.json.since, undefined);
    assert.equal((await get("/api/v1/claim-status")).status, 400);
  });

  it("says nothing about the identity: no identityHash, no public key", async () => {
    const r = await get(`/api/v1/claim-status?namespace=ana.${ROOT}`);
    assert.ok(claimed.identityHash && !r.text.includes(claimed.identityHash), "identityHash disclosed");
    assert.ok(!/identityHash|publicKey|BEGIN PUBLIC KEY/.test(r.text), r.text.slice(0, 300));
    const pemBody = claimed.publicKey.replace(/-----[^-]+-----|\s/g, "").slice(0, 40);
    assert.ok(pemBody && !r.text.includes(pemBody), "public key disclosed");
  });
});

describe("public surface reads do not list requests", () => {
  it("/__surface and /__bootstrap: no individual requests for the public; the internal token still sees them", async () => {
    await get(`/api/v1/claim-status?namespace=someone-looked-up.${ROOT}`);
    for (const p of ["/__surface", "/__bootstrap"]) {
      const pub = await get(p);
      assert.equal(pub.status, 200, p);
      assert.deepEqual(recent(pub.json), [], `${p} lists requests publicly`);
      assert.ok(!pub.text.includes("someone-looked-up"), `${p} discloses a looked-up name`);
      const internal = await get(p, true);
      assert.ok(Array.isArray(recent(internal.json)) && recent(internal.json).length > 0, `${p} internal view lost its requests`);
      assert.ok(internal.text.includes("someone-looked-up"), `${p} internal view should show requests`);
    }
  });

  it("/__surface/events: no per-request events for the public; the internal token still gets them", async () => {
    const pub = await streamAround(false, () => get(`/api/v1/claim-status?namespace=stream-public.${ROOT}`));
    assert.ok(pub.includes("event: surface"), "the public stream still carries the aggregate snapshot");
    assert.ok(!pub.includes("event: request"), "a per-request event reached a public subscriber");
    assert.ok(!pub.includes("stream-public"), "the public stream disclosed a looked-up name");
    const internal = await streamAround(true, () => get(`/api/v1/claim-status?namespace=stream-internal.${ROOT}`));
    assert.ok(internal.includes("event: request") && internal.includes("stream-internal"), "the internal stream lost its per-request events");
  });
});
