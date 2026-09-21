/**
 * requestedNamespace.test.ts -- a read says which namespace it is about; the door it came through does not decide.
 *
 * The root and a user's tree hold DIFFERENT content, so what is checked is that the right content arrives,
 * not only that an error goes away.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import WebSocket from "ws";
import { createMonadApp } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";
import { appendSemanticMemory } from "../src/claim/memoryStore";
import { attachNrpWebSocketServer } from "../src/http/nrpHandler";
import { readRequestedNamespace, resolveServedNamespace } from "../src/http/requestedNamespace";

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = null;
  resetKernelStateForTests();
});

const ITEM_IDS = "layout.sidebar.scopes.root.itemIds";

async function start() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-requested-ns-"));
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><html><head></head><body></body></html>");
  const app = await createMonadApp({
    cwd: root, seed: "requested-namespace-seed", namespace: "acme.test",
    stateDir: path.join(root, "me-state"), claimDir: path.join(root, "claims"), selfConfigPath: path.join(root, "self.json"),
    indexPath: path.join(root, "index.html"), logger: false,
  });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  attachNrpWebSocketServer(server);
  // different content in the root's tree and in the user's
  appendSemanticMemory({ namespace: "acme.test", path: ITEM_IDS, operator: "=", data: ["root-item"], timestamp: Date.now() });
  appendSemanticMemory({ namespace: "jabellae.acme.test", path: ITEM_IDS, operator: "=", data: ["handle-item"], timestamp: Date.now() });
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port };
}

/** A read of the sidebar's item ids, through the door `host`, optionally naming its namespace. */
async function read(base: string, host: string, query = "", extra: Record<string, string> = {}) {
  const res = await fetch(`${base}/${ITEM_IDS.replace(/\./g, "/")}${query}`, { headers: { accept: "application/json", host, "x-forwarded-host": host, ...extra } });
  const body: any = await res.json().catch(() => null);
  return { status: res.status, body, ns: body?.target?.namespace?.me, value: body?.target?.value ?? body?.value };
}

// the unit cases run without a monad: the space they are about is set explicitly
let priorNamespace: string | undefined;
beforeAll(() => { priorNamespace = process.env.ME_NAMESPACE; process.env.ME_NAMESPACE = "acme.test"; });
afterAll(() => { if (priorNamespace === undefined) delete process.env.ME_NAMESPACE; else process.env.ME_NAMESPACE = priorNamespace; });

describe("resolveServedNamespace: the namespaces this monad serves, and no others", () => {
  it("accepts its root and what lives under it, canonically", () => {
    expect(resolveServedNamespace("acme.test")).toEqual({ ok: true, namespace: "acme.test" });
    expect(resolveServedNamespace("Jabellae.ACME.test")).toEqual({ ok: true, namespace: "jabellae.acme.test" });
  });
  it("refuses another namespace, a reserved door label and anything that is not one plain name", () => {
    for (const raw of ["evil.example", "acme.test.evil.example", "notacme.test", "www.acme.test"]) {
      expect(resolveServedNamespace(raw), raw).toEqual({ ok: false, reason: "NAMESPACE_NOT_SERVED" });
    }
    for (const raw of ["", "  ", "acme.test/x", "acme.test:8080", "a@acme.test", "acme.test,evil.example", "acme test", ["acme.test"], 7, null]) {
      expect(resolveServedNamespace(raw as any), String(raw)).toEqual({ ok: false, reason: "NAMESPACE_INVALID" });
    }
  });
});

describe("readRequestedNamespace: only a read names its namespace, only with ?namespace=", () => {
  const req = (method: string, query: Record<string, unknown>) => ({ method, query } as any);
  it("reads name it; writes never do", () => {
    expect(readRequestedNamespace(req("GET", { namespace: "acme.test" }))).toEqual({ present: true, ok: true, namespace: "acme.test" });
    expect(readRequestedNamespace(req("HEAD", { namespace: "acme.test" })).present).toBe(true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(readRequestedNamespace(req(method, { namespace: "acme.test" })), method).toEqual({ present: false });
    expect(readRequestedNamespace(req("GET", {}))).toEqual({ present: false });
  });
});

describe("HTTP reads: the right tree arrives whichever door carried the request", () => {
  it("without naming one, the door decides, as it always did", async () => {
    const { base } = await start();
    const apex = await read(base, "acme.test");
    const www = await read(base, "www.acme.test");
    const handle = await read(base, "jabellae.acme.test");
    expect([apex.ns, www.ns, handle.ns]).toEqual(["acme.test", "acme.test", "jabellae.acme.test"]);
    expect(apex.value).toEqual(["root-item"]);
    expect(www.value).toEqual(["root-item"]);
    expect(handle.value).toEqual(["handle-item"]);
  });

  it("naming the root from a user's door reads the ROOT's content, not the user's", async () => {
    const { base } = await start();
    const r = await read(base, "jabellae.acme.test", "?namespace=acme.test");
    expect(r.status).toBe(200);
    expect(r.ns).toBe("acme.test");
    expect(r.value).toEqual(["root-item"]);
    expect(JSON.stringify(r.body)).not.toContain("handle-item");
  });

  it("naming a user from the root's door reads that user's content", async () => {
    const { base } = await start();
    const r = await read(base, "acme.test", "?namespace=jabellae.acme.test");
    expect(r.ns).toBe("jabellae.acme.test");
    expect(r.value).toEqual(["handle-item"]);
  });

  it("the connection's X-Forwarded-Host describes the connection, not the namespace asked for", async () => {
    const { base } = await start();
    // an edge that rewrites X-Forwarded-Host to the connection's host (nginx does) cannot change the answer
    const viaEdge = await read(base, "jabellae.acme.test", "?namespace=acme.test", { "x-forwarded-host": "jabellae.acme.test", "x-forwarded-proto": "https" });
    expect(viaEdge.value).toEqual(["root-item"]);
    // and a forged one cannot pull a namespace this monad does not serve
    const forged = await read(base, "acme.test", "?namespace=acme.test", { "x-forwarded-host": "evil.example" });
    expect(forged.value).toEqual(["root-item"]);
  });

  it("a namespace this monad does not serve is refused, and never answered from another tree", async () => {
    const { base } = await start();
    for (const q of ["?namespace=evil.example", "?namespace=www.acme.test", "?namespace=acme.test.evil.example", "?namespace=", "?namespace=a/b"]) {
      const r = await read(base, "acme.test", q);
      expect(r.ns, q).not.toBe("acme.test");
      expect(r.value, q).toBeUndefined();
      expect(JSON.stringify(r.body ?? {}), q).not.toContain("root-item");
      expect(JSON.stringify(r.body ?? {}), q).not.toContain("handle-item");
    }
  });

  it("/__surface answers for the namespace asked, so a client can confirm a transport can serve it", async () => {
    const { base } = await start();
    const asked = await (await fetch(`${base}/__surface?namespace=acme.test`, { headers: { host: "jabellae.acme.test", "x-forwarded-host": "jabellae.acme.test" } })).json() as any;
    expect(asked.target.namespace.me).toBe("acme.test");
    const door = await (await fetch(`${base}/__surface`, { headers: { host: "jabellae.acme.test", "x-forwarded-host": "jabellae.acme.test" } })).json() as any;
    expect(door.target.namespace.me).toBe("jabellae.acme.test");
  });

  it("a write is not selected by ?namespace=", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/?namespace=jabellae.acme.test`, {
      method: "POST", headers: { "content-type": "application/json", host: "acme.test", "x-forwarded-host": "acme.test" },
      body: JSON.stringify({ operation: "write", expression: "probe.value", value: 1 }),
    });
    // whatever it answers, nothing was written under the user's namespace
    void res.status;
    const handle = await read(base, "jabellae.acme.test", "");
    expect(JSON.stringify(handle.body ?? {})).not.toContain("probe");
  });
});

describe("WebSocket reads name their namespace, and it is one this monad serves", () => {
  function ask(port: number, message: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/nrp`);
      const timer = setTimeout(() => { ws.close(); reject(new Error("no answer")); }, 4000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "read", channelId: "c1", ...message })));
      ws.on("message", (raw) => { clearTimeout(timer); ws.close(); resolve(JSON.parse(String(raw))); });
      ws.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
  }

  it("returns the content of the namespace named, from the same connection", async () => {
    const { port } = await start();
    const root = await ask(port, { namespace: "acme.test", path: ITEM_IDS });
    const handle = await ask(port, { namespace: "jabellae.acme.test", path: ITEM_IDS });
    expect(root.type).toBe("data");
    expect(root.payload.value).toEqual(["root-item"]);
    expect(handle.payload.value).toEqual(["handle-item"]);
  });

  it("refuses a namespace it does not serve (it used to fall to the kernel root's storage)", async () => {
    const { port } = await start();
    for (const namespace of ["evil.example", "www.acme.test", "acme.test/x", ""]) {
      const r = await ask(port, { namespace, path: ITEM_IDS });
      expect(r.type, namespace).toBe("error");
      expect(["NAMESPACE_NOT_SERVED", "NAMESPACE_INVALID"], namespace).toContain(r.payload);
      expect(JSON.stringify(r), namespace).not.toContain("root-item");
    }
  });
});
