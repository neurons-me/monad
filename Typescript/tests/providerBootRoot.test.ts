/**
 * providerBootRoot.test.ts -- what a page is told about the namespace it is on.
 *
 * The page's address resolves to a namespace: the root itself (cleaker.me, and www.cleaker.me is
 * answered as cleaker.me) or, at a handle host, that handle's own (jabellae.cleaker.me). A client
 * that composes a handle's namespace from "the namespace it was told" got jabellae.jabellae.cleaker.me
 * at a handle host. So the boot also carries the ROOT the monad serves and the handle (if any),
 * and a client composes from those.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createMonadApp } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";
import { buildNamespaceProviderBoot } from "../src/http/provider";

let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = null;
  resetKernelStateForTests();
});

async function start(namespace: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-boot-root-"));
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><html><head></head><body></body></html>");
  const app = await createMonadApp({
    cwd: root, seed: "provider-boot-root-seed", namespace,
    stateDir: path.join(root, "me-state"), claimDir: path.join(root, "claims"), selfConfigPath: path.join(root, "self.json"),
    indexPath: path.join(root, "index.html"), logger: false,
  });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The boot the shell injects for a request that arrived under `host`. */
async function bootFor(base: string, host: string) {
  const res = await fetch(`${base}/`, { headers: { accept: "text/html", host, "x-forwarded-host": host } });
  const html = await res.text();
  const match = html.match(/var boot = (\{[\s\S]*?\});\s*\n\s*window\.__MONAD_NAMESPACE_PROVIDER_BOOT__/);
  expect(match, `no boot injected for ${host}`).not.toBeNull();
  return JSON.parse(match![1]);
}

describe("the boot names the root as well as the address's own namespace", () => {
  it("at the root, at www and at a handle host", async () => {
    const base = await start("acme.test");

    const root = await bootFor(base, "acme.test");
    expect([root.namespace, root.rootNamespace, root.handle]).toEqual(["acme.test", "acme.test", null]);

    const www = await bootFor(base, "www.acme.test");
    expect([www.namespace, www.rootNamespace, www.handle]).toEqual(["acme.test", "acme.test", null]);

    const handle = await bootFor(base, "jabellae.acme.test");
    expect(handle.namespace).toBe("jabellae.acme.test");
    expect(handle.rootNamespace).toBe("acme.test");
    expect(handle.handle).toBe("jabellae");
  });

  it("is the same root whatever host the page came from, and a stranger host is not made a handle of it", async () => {
    const base = await start("acme.test");
    for (const host of ["acme.test", "www.acme.test", "ana.acme.test", "someone-else.example"]) {
      expect((await bootFor(base, host)).rootNamespace, host).toBe("acme.test");
    }
    expect((await bootFor(base, "someone-else.example")).handle).toBeNull();
  });

  it("builds the pieces from what it is given", () => {
    const boot = (namespace: string, rootNamespace?: string) => buildNamespaceProviderBoot({
      namespace, rootNamespace, route: "/", origin: "http://x", resolverHostName: "x", resolverDisplayName: "x", surfaceEntry: null,
    });
    expect(boot("jabellae.cleaker.me", "cleaker.me")).toMatchObject({ rootNamespace: "cleaker.me", handle: "jabellae" });
    expect(boot("a.b.cleaker.me", "cleaker.me").handle).toBe("a.b");
    expect(boot("cleaker.me", "cleaker.me").handle).toBeNull();
    expect(boot("notcleaker.me", "cleaker.me").handle).toBeNull();
    expect(boot("cleaker.me")).toMatchObject({ rootNamespace: "cleaker.me", handle: null }); // no root given: it is its own
  });
});
