/**
 * mountReferenceNodePath.test.ts -- the mount reference (namespace + node path, GatewayAccessContract.md
 * §7) a page can get two ways: injected into the HTML it was served, or fetched with GET /__provider.
 * Both must describe the SAME thing at the namespace's own root; the fetched path can additionally ask
 * for an interior node, which the injected path (the whole page IS the page's own root) never needs to.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createMonadApp } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";

let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = null;
  resetKernelStateForTests();
});

async function start(namespace: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-mount-ref-"));
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><html><head></head><body></body></html>");
  const app = await createMonadApp({
    cwd: root, seed: "mount-reference-seed", namespace,
    stateDir: path.join(root, "me-state"), claimDir: path.join(root, "claims"), selfConfigPath: path.join(root, "self.json"),
    indexPath: path.join(root, "index.html"), logger: false,
  });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function injectedBoot(base: string, host: string) {
  const res = await fetch(`${base}/`, { headers: { accept: "text/html", host, "x-forwarded-host": host } });
  const html = await res.text();
  const match = html.match(/var boot = (\{[\s\S]*?\});\s*\n\s*window\.__MONAD_NAMESPACE_PROVIDER_BOOT__/);
  expect(match, `no boot injected for ${host}`).not.toBeNull();
  return JSON.parse(match![1]);
}

async function discoveredBoot(base: string, host: string, nodePath?: string) {
  const url = new URL(`${base}/__provider`);
  if (nodePath !== undefined) url.searchParams.set("nodePath", nodePath);
  const res = await fetch(url, { headers: { host, "x-forwarded-host": host } });
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.provider;
}

describe("mount reference: injected boot and GET /__provider describe the same place", () => {
  it("at the namespace's own root: same namespace, rootNamespace, handle, empty nodePath", async () => {
    const base = await start("acme.test");

    const injected = await injectedBoot(base, "acme.test");
    expect(injected.nodePath).toBe("");

    const discovered = await discoveredBoot(base, "acme.test");
    expect(discovered.nodePath).toBe("");
    expect([discovered.namespace, discovered.rootNamespace, discovered.handle]).toEqual(
      [injected.namespace, injected.rootNamespace, injected.handle]
    );
  });

  it("at a handle host: injected and discovered still agree", async () => {
    const base = await start("acme.test");
    const injected = await injectedBoot(base, "jabellae.acme.test");
    const discovered = await discoveredBoot(base, "jabellae.acme.test");
    expect([discovered.namespace, discovered.rootNamespace, discovered.handle, discovered.nodePath]).toEqual(
      [injected.namespace, injected.rootNamespace, injected.handle, injected.nodePath]
    );
    expect(discovered.handle).toBe("jabellae");
  });

  it("discovery alone can additionally resolve an interior node -- injection has no such need (the page IS its own root)", async () => {
    const base = await start("acme.test");
    const atRoot = await discoveredBoot(base, "acme.test");
    const atNode = await discoveredBoot(base, "acme.test", "dashboard/status");
    expect(atRoot.nodePath).toBe("");
    expect(atNode.nodePath).toBe("dashboard/status");
    // everything ELSE about the mount reference is unchanged -- only where under the namespace moved
    expect([atNode.namespace, atNode.rootNamespace, atNode.handle]).toEqual(
      [atRoot.namespace, atRoot.rootNamespace, atRoot.handle]
    );
  });

  it("a node path is normalized the same way /__provider/resolve's own ?path= already is", async () => {
    const base = await start("acme.test");
    const messy = await discoveredBoot(base, "acme.test", "//dashboard//status//");
    expect(messy.nodePath).toBe("dashboard/status");
    const empty = await discoveredBoot(base, "acme.test", "   ");
    expect(empty.nodePath).toBe("");
  });
});
