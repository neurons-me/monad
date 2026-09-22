/**
 * mountReferenceInjectionParity.test.ts -- the two remaining gaps found in review of
 * mountReferenceNodePath.test.ts:
 *
 * 1. An injected boot could only ever describe the namespace's own root; discovery alone could
 *    describe an interior node. An interface served BY the monad (not fetched by a standalone file)
 *    must be able to describe the same interior mount, the same way.
 * 2. Carrying `nodePath` in the boot proved nothing about READS. A "relative" resolve must actually
 *    compose under that node -- different real data at the root and at an interior node, read back
 *    correctly from each.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createMonadApp } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";
import { appendSemanticMemory } from "../src/claim/memoryStore";

let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = null;
  resetKernelStateForTests();
});

async function start(namespace: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-mount-ref-parity-"));
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><html><head></head><body></body></html>");
  const app = await createMonadApp({
    cwd: root, seed: "mount-reference-parity-seed", namespace,
    stateDir: path.join(root, "me-state"), claimDir: path.join(root, "claims"), selfConfigPath: path.join(root, "self.json"),
    indexPath: path.join(root, "index.html"), logger: false,
  });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function injectedBoot(base: string, host: string, urlPath = "/", nodePath?: string) {
  const url = new URL(urlPath, base);
  if (nodePath !== undefined) url.searchParams.set("nodePath", nodePath);
  const res = await fetch(url, { headers: { accept: "text/html", host, "x-forwarded-host": host } });
  const html = await res.text();
  const match = html.match(/var boot = (\{[\s\S]*?\});\s*\n\s*window\.__MONAD_NAMESPACE_PROVIDER_BOOT__/);
  expect(match, `no boot injected for ${host}${urlPath}`).not.toBeNull();
  return JSON.parse(match![1]);
}

async function discoveredBoot(base: string, host: string, nodePath?: string) {
  const url = new URL(`${base}/__provider`);
  if (nodePath !== undefined) url.searchParams.set("nodePath", nodePath);
  const res = await fetch(url, { headers: { host, "x-forwarded-host": host } });
  expect(res.status).toBe(200);
  return (await res.json()).provider;
}

async function resolve(base: string, host: string, resolvePath: string, nodePath?: string) {
  const url = new URL(`${base}/__provider/resolve`);
  url.searchParams.set("path", resolvePath);
  if (nodePath !== undefined) url.searchParams.set("nodePath", nodePath);
  const res = await fetch(url, { headers: { host, "x-forwarded-host": host } });
  return { status: res.status, body: await res.json() };
}

describe("an injected boot can describe an interior node too -- not only discovery", () => {
  it("the SAME root route, given ?nodePath=, injects that node -- catchAll (an unmatched path) does too", async () => {
    const base = await start("acme.test");

    const rootInjected = await injectedBoot(base, "acme.test");
    expect(rootInjected.nodePath).toBe("");

    const nodeInjected = await injectedBoot(base, "acme.test", "/?nodePath=dashboard/status");
    expect(nodeInjected.nodePath).toBe("dashboard/status");
    expect([nodeInjected.namespace, nodeInjected.rootNamespace]).toEqual([rootInjected.namespace, rootInjected.rootNamespace]);

    // catchAll: any unmatched path also serves the shell (a client-side route) -- the SPA's own
    // path (`route`) and the mount reference (`nodePath`) stay two independent query knobs.
    const viaCatchAll = await injectedBoot(base, "acme.test", "/some/client/route?nodePath=dashboard/status");
    expect(viaCatchAll.nodePath).toBe("dashboard/status");
  });

  it("injected and discovered agree at the SAME interior node, not only at the root", async () => {
    const base = await start("acme.test");
    const injected = await injectedBoot(base, "acme.test", "/?nodePath=dashboard/status");
    const discovered = await discoveredBoot(base, "acme.test", "dashboard/status");
    expect([discovered.namespace, discovered.rootNamespace, discovered.handle, discovered.nodePath]).toEqual(
      [injected.namespace, injected.rootNamespace, injected.handle, injected.nodePath]
    );
  });
});

describe("nodePath is load-bearing for reads, not merely carried in the boot", () => {
  it("a relative read composes UNDER the node -- different real data at the root and at an interior node", async () => {
    const base = await start("acme.test");
    appendSemanticMemory({ namespace: "acme.test", path: "title", data: "ROOT TITLE" });
    appendSemanticMemory({ namespace: "acme.test", path: "dashboard.status.title", data: "NODE TITLE" });

    const atRoot = await resolve(base, "acme.test", "title");
    expect(atRoot.status).toBe(200);
    expect(atRoot.body.target.value).toBe("ROOT TITLE");

    const atNode = await resolve(base, "acme.test", "title", "dashboard/status");
    expect(atNode.status).toBe(200);
    expect(atNode.body.target.value).toBe("NODE TITLE");

    // reading the SAME relative name at the root must not see the interior node's value, and vice
    // versa -- this is the actual composition being proven, not just "some value came back"
    expect(atRoot.body.target.value).not.toBe(atNode.body.target.value);
  });

  it("a read that only exists at the root is NOT found through an interior node, and the reverse", async () => {
    const base = await start("acme.test");
    appendSemanticMemory({ namespace: "acme.test", path: "onlyAtRoot", data: "root-only" });
    appendSemanticMemory({ namespace: "acme.test", path: "dashboard.onlyAtNode", data: "node-only" });

    const rootValueViaNode = await resolve(base, "acme.test", "onlyAtRoot", "dashboard");
    expect(rootValueViaNode.status).toBe(404);

    const nodeValueAtRoot = await resolve(base, "acme.test", "onlyAtNode");
    expect(nodeValueAtRoot.status).toBe(404);

    const nodeValueViaNode = await resolve(base, "acme.test", "onlyAtNode", "dashboard");
    expect(nodeValueViaNode.status).toBe(200);
    expect(nodeValueViaNode.body.target.value).toBe("node-only");
  });
});
