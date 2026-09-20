/**
 * www.<root> is <root> -- the front door of a namespace is the namespace --
 * and www / api are never a person's handle.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createMonadApp } from "../src/index";
import { claimNamespace } from "../src/claim/records";
import { resetKernelStateForTests } from "../src/kernel/manager";
import { hasReservedHandleLabel, isReservedHandleLabel, stripWwwLabel } from "../src/namespace/identity";

describe("reserved labels", () => {
  it("knows which labels are never a handle", () => {
    expect(isReservedHandleLabel("www")).toBe(true);
    expect(isReservedHandleLabel("WWW")).toBe(true);
    expect(isReservedHandleLabel("api")).toBe(true);
    expect(isReservedHandleLabel("ana")).toBe(false);
    expect(hasReservedHandleLabel("www.cleaker.me")).toBe(true);
    expect(hasReservedHandleLabel("api.cleaker.me")).toBe(true);
    expect(hasReservedHandleLabel("ana.cleaker.me")).toBe(false);
    expect(hasReservedHandleLabel("www")).toBe(false); // no handle position without a root
    expect(hasReservedHandleLabel("cleaker.me")).toBe(false);
    expect(hasReservedHandleLabel("awww.cleaker.me")).toBe(false);
  });

  it("drops only a leading www over a name that still has a dot", () => {
    expect(stripWwwLabel("www.cleaker.me")).toBe("cleaker.me");
    expect(stripWwwLabel("WWW.Cleaker.Me")).toBe("Cleaker.Me");
    expect(stripWwwLabel("www.ana.cleaker.me")).toBe("ana.cleaker.me");
    expect(stripWwwLabel("cleaker.me")).toBe("cleaker.me");
    expect(stripWwwLabel("ana.cleaker.me")).toBe("ana.cleaker.me");
    expect(stripWwwLabel("www")).toBe("www");
    expect(stripWwwLabel("www.localhost")).toBe("www.localhost");
    expect(stripWwwLabel("awww.cleaker.me")).toBe("awww.cleaker.me");
  });

  it("refuses to claim www.<root> or api.<root> as a handle, before anything else", async () => {
    resetKernelStateForTests();
    for (const namespace of ["www.cleaker.me", "api.cleaker.me", "WWW.cleaker.me"]) {
      const result = await claimNamespace({ namespace, secret: "s" } as any);
      expect(result).toEqual({ ok: false, error: "RESERVED_HANDLE" });
    }
  });
});

describe("a request to www.<root>", () => {
  let root: string;
  let server: Server | null = null;

  beforeEach(() => {
    resetKernelStateForTests();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-www-"));
  });
  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = null;
    resetKernelStateForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is answered as the namespace itself", async () => {
    const app = await createMonadApp({
      cwd: root, seed: "test-seed-www", namespace: "cleaker.me", stateDir: path.join(root, "s"),
      claimDir: path.join(root, "c"), selfConfigPath: path.join(root, "self.json"), selfIdentity: "cleaker.me",
      selfHostname: "cleaker.me", selfEndpoint: "http://127.0.0.1:0", selfTags: ["local"], port: 0,
      guiPkgDistDir: root, mePkgDistDir: root, cleakerPkgDistDir: root, reactUmdDir: root, reactDomUmdDir: root,
      routesPath: path.join(root, "routes.js"), logger: false,
    } as any);
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const titleFor = async (host: string) => {
      const res = await fetch(`${base}/`, { headers: { accept: "text/html", "x-forwarded-host": host } });
      return /<title>([^<]*)<\/title>/.exec(await res.text())?.[1];
    };
    expect(await titleFor("cleaker.me")).toBe("cleaker.me");
    expect(await titleFor("www.cleaker.me")).toBe("cleaker.me");
    expect(await titleFor("ana.cleaker.me")).toBe("ana.cleaker.me");
  });
});
