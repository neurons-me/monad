/**
 * A monad can serve a built front end, and can be given packages that add
 * routes to it (MONAD_FRONTEND_DIR / MONAD_MODULES).
 *
 * What is pinned here:
 *  - the front end's FILES are served as they are (hashed assets kept for a
 *    year), its index.html answers browsers on any route with the namespace
 *    injected, and the same URL still answers NRP JSON to a data request;
 *  - a folder in the bundle never shadows an NRP read (no directory index, no
 *    trailing-slash redirect);
 *  - a listed module mounts its routes; one that is missing or exports no
 *    mount() is reported and the monad keeps serving.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createMonadApp } from "../src/index";
import { resetKernelStateForTests } from "../src/kernel/manager";
import { parseModuleList } from "../src/bootstrap";
import { resolveModuleMount, toImportSpecifier } from "../src/modules";

const ENV_KEYS = [
  "PORT", "SEED", "ME_SEED", "ME_NAMESPACE", "ME_STATE_DIR", "MONAD_CLAIM_DIR", "MONAD_SELF_CONFIG_PATH",
  "MONAD_SELF_IDENTITY", "MONAD_SELF_HOSTNAME", "MONAD_SELF_ENDPOINT", "MONAD_SELF_TAGS", "MONAD_FETCH_TIMEOUT_MS",
  "GUI_PKG_DIST_DIR", "ME_PKG_DIST_DIR", "CLEAKER_PKG_DIST_DIR", "LOCAL_REACT_UMD_DIR", "LOCAL_REACTDOM_UMD_DIR",
  "MONAD_ROUTES_PATH", "MONAD_INDEX_PATH", "MONAD_FRONTEND_DIR", "MONAD_MODULES",
];

let saved: Record<string, string | undefined>;
let root: string;
let server: Server | null = null;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ["MONAD_INDEX_PATH", "MONAD_FRONTEND_DIR", "MONAD_MODULES"]) delete process.env[key];
  resetKernelStateForTests();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "monad-frontend-"));
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = null;
  resetKernelStateForTests();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

async function start(extra: Record<string, unknown> = {}) {
  const app = await createMonadApp({
    cwd: root,
    seed: "test-seed-frontend-and-modules",
    namespace: "cleaker.me",
    stateDir: path.join(root, "me-state"),
    claimDir: path.join(root, "claims"),
    selfConfigPath: path.join(root, "self.json"),
    selfIdentity: "cleaker.me",
    selfHostname: "cleaker.me",
    selfEndpoint: "http://127.0.0.1:0",
    selfTags: ["local"],
    port: 0,
    guiPkgDistDir: root,
    mePkgDistDir: root,
    cleakerPkgDistDir: root,
    reactUmdDir: root,
    reactDomUmdDir: root,
    routesPath: path.join(root, "routes.js"),
    logger: false,
    ...extra,
  } as any);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { app, base };
}

function writeFrontend(): string {
  const dir = path.join(root, "web");
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><html><head><title>built app</title></head><body><div id="root">FRONTEND-MARKER</div></body></html>');
  fs.writeFileSync(path.join(dir, "assets", "app-abc123.js"), "console.log('app')");
  fs.writeFileSync(path.join(dir, "logo.png"), "png-bytes");
  return dir;
}

describe("a monad that serves a built front end", () => {
  it("serves its files as they are; hashed assets are kept, others re-checked", async () => {
    const { base } = await start({ frontendDir: writeFrontend() });

    const asset = await fetch(`${base}/assets/app-abc123.js`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("console.log('app')");
    expect(asset.headers.get("cache-control")).toContain("immutable");

    const logo = await fetch(`${base}/logo.png`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("cache-control")).toBe("no-cache");
  });

  it("answers browsers with its index.html, namespace injected, on the root and on any route", async () => {
    const { base } = await start({ frontendDir: writeFrontend() });
    for (const route of ["/", "/users", "/blockchain"]) {
      const res = await fetch(`${base}${route}`, { headers: { accept: "text/html" } });
      expect(res.status, route).toBe(200);
      const html = await res.text();
      expect(html, route).toContain("FRONTEND-MARKER");
      expect(html, route).toContain("__MONAD_PROVIDER_BOOT_INJECTED__");
      expect(html, route).toContain("<title>cleaker.me</title>");
    }
  });

  it("still answers a data request to the same URL with NRP, not the front end", async () => {
    const { base } = await start({ frontendDir: writeFrontend() });
    const res = await fetch(`${base}/`, { headers: { accept: "application/json" } });
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.target?.nrp).toContain("cleaker.me");

    // /blockchain and /blocks are pages of the front end AND data endpoints:
    // fetch() (Accept */*) still gets the ledger, a browser gets the page.
    for (const route of ["/blockchain", "/blocks"]) {
      const data = await fetch(`${base}${route}`);
      expect(data.headers.get("content-type"), route).toContain("application/json");
      expect((await data.json()).ok, route).toBe(true);
      const page = await fetch(`${base}${route}`, { headers: { accept: "text/html" } });
      expect(await page.text(), route).toContain("FRONTEND-MARKER");
    }
  });

  it("does not let a folder of the bundle shadow an NRP read", async () => {
    const { base } = await start({ frontendDir: writeFrontend() });
    const res = await fetch(`${base}/assets`, { redirect: "manual", headers: { accept: "application/json" } });
    expect(res.status).not.toBe(301);
    expect(res.status).not.toBe(302);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("without a front end it is what it was: the diagnostic shell", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/`, { headers: { accept: "text/html" } });
    expect(await res.text()).toContain("monad provider shell");
  });
});

describe("a monad given packages to mount (MONAD_MODULES)", () => {
  function writeModule(name: string, body: string): string {
    const file = path.join(root, name);
    fs.writeFileSync(file, body);
    return file;
  }

  it("mounts a listed module's routes, ahead of the NRP handlers", async () => {
    const mod = writeModule(
      "gateway.mjs",
      `export function mount(app, ctx) {
         app.get("/gateway-probe", (_req, res) => res.json({ namespace: ctx.config.localNamespaceRoot }));
       }`,
    );
    const { app, base } = await start({ modules: [mod] });
    expect(app.monadModules.loaded).toEqual([mod]);
    expect(app.monadModules.failed).toEqual([]);
    const res = await fetch(`${base}/gateway-probe`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ namespace: "cleaker.me" });
  });

  it("accepts a default-exported function too", async () => {
    const mod = writeModule("dflt.mjs", `export default (app) => app.get("/dflt-probe", (_q, r) => r.send("ok"));`);
    const { base } = await start({ modules: [mod] });
    expect(await (await fetch(`${base}/dflt-probe`)).text()).toBe("ok");
  });

  it("reports a module that is missing or exports no mount(), and keeps serving", async () => {
    const empty = writeModule("empty.mjs", "export const nothing = 1;");
    const missing = path.join(root, "nope.mjs");
    const good = writeModule("good.mjs", `export function mount(app) { app.get("/good-probe", (_q, r) => r.send("fine")); }`);
    const { app, base } = await start({ modules: [missing, empty, good] });

    expect(app.monadModules.loaded).toEqual([good]);
    expect(app.monadModules.failed.map((f) => f.specifier)).toEqual([missing, empty]);
    expect(app.monadModules.failed[1].error).toMatch(/no mount/);
    expect(await (await fetch(`${base}/good-probe`)).text()).toBe("fine");
    const root404 = await fetch(`${base}/`, { headers: { accept: "application/json" } });
    expect(root404.status).toBe(200);
  });

  it("mounts nothing when nothing is listed", async () => {
    const { app } = await start();
    expect(app.monadModules).toEqual({ loaded: [], failed: [] });
  });
});

describe("the pieces", () => {
  it("parseModuleList reads a comma list", () => {
    expect(parseModuleList("a, b,,c/d ")).toEqual(["a", "b", "c/d"]);
    expect(parseModuleList(undefined)).toEqual([]);
    expect(parseModuleList("")).toEqual([]);
  });

  it("a path is imported as a file, a name as a package", () => {
    expect(toImportSpecifier("netget/gateway", "/srv")).toBe("netget/gateway");
    expect(toImportSpecifier("./mods/a.mjs", "/srv")).toBe("file:///srv/mods/a.mjs");
    expect(toImportSpecifier("/abs/a.mjs", "/srv")).toBe("file:///abs/a.mjs");
    expect(toImportSpecifier("file:///x/a.mjs", "/srv")).toBe("file:///x/a.mjs");
  });

  it("finds mount() as a named export, a default function, or default.mount", () => {
    const fn = () => undefined;
    expect(resolveModuleMount({ mount: fn })).toBe(fn);
    expect(resolveModuleMount({ default: fn })).toBe(fn);
    expect(resolveModuleMount({ default: { mount: fn } })).toBe(fn);
    expect(resolveModuleMount({})).toBeNull();
    expect(resolveModuleMount(null)).toBeNull();
  });
});
