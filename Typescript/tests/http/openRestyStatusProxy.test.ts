/**
 * openRestyStatusProxy.test.ts — the `openResty`/`openResty.<port>` NRP
 * read path never touches the memory store (see openRestyStatusProxy.ts's
 * own header for why); it proxies to a real, external, LIVE gateway-status
 * source configured via OPENRESTY_STATUS_URL, ONLY for the exact namespace
 * configured via OPENRESTY_STATUS_NAMESPACE, and ONLY for a port this proxy
 * actually knows how to answer. This is a fake source (an http.Server this
 * test controls entirely) — never a real netget backend, never the real
 * gateway.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { resolveOpenRestyStatusFromSource, shouldInterceptOpenRestyPath } from "../../src/http/openRestyStatusProxy.js";
import { createPathResolverHandler } from "../../src/http/pathResolver.js";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["OPENRESTY_STATUS_URL", "OPENRESTY_STATUS_NAMESPACE"];

function saveEnv(): void {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

function fakeReq(headers: Record<string, string> = {}): { header(name: string): string | undefined } {
  return { header: (name: string) => headers[name.toLowerCase()] };
}

describe("shouldInterceptOpenRestyPath -- namespace and path must both match exactly", () => {
  afterEach(restoreEnv);

  it("never intercepts when OPENRESTY_STATUS_NAMESPACE isn't configured, regardless of dotPath", () => {
    delete process.env.OPENRESTY_STATUS_NAMESPACE;
    expect(shouldInterceptOpenRestyPath("netget.local.cleaker", "openResty.443")).toBe(false);
  });

  it("intercepts the configured namespace's own openResty.80/443 and bare 'openResty'", () => {
    process.env.OPENRESTY_STATUS_NAMESPACE = "netget.local.cleaker";
    expect(shouldInterceptOpenRestyPath("netget.local.cleaker", "openResty")).toBe(true);
    expect(shouldInterceptOpenRestyPath("netget.local.cleaker", "openResty.80")).toBe(true);
    expect(shouldInterceptOpenRestyPath("netget.local.cleaker", "openResty.443")).toBe(true);
  });

  it("never intercepts a DIFFERENT namespace's read of the exact same dotPath -- two namespaces asking for openResty.443 must not resolve to the same host status", () => {
    process.env.OPENRESTY_STATUS_NAMESPACE = "netget.local.cleaker";
    expect(shouldInterceptOpenRestyPath("someone-else.local.cleaker", "openResty.443")).toBe(false);
  });

  it("never intercepts a port this proxy can't answer for, even under the configured namespace -- a legitimate 'openResty.8080' path (or any non-numeric leaf) falls through untouched", () => {
    process.env.OPENRESTY_STATUS_NAMESPACE = "netget.local.cleaker";
    expect(shouldInterceptOpenRestyPath("netget.local.cleaker", "openResty.8080")).toBe(false);
    expect(shouldInterceptOpenRestyPath("netget.local.cleaker", "openResty.mode")).toBe(false);
  });
});

describe("resolveOpenRestyStatusFromSource", () => {
  let fakeSource: http.Server;
  let fakeSourceUrl: string;
  let fakeSourceStatus = 200;
  let fakeSourceBody: unknown = { ok: true, httpListening: true, httpsListening: false, mode: "service" };

  beforeAll(async () => {
    saveEnv();
    fakeSource = http.createServer((req, res) => {
      res.writeHead(fakeSourceStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(fakeSourceBody));
    });
    await new Promise<void>((resolve) => fakeSource.listen(0, resolve));
    const { port } = fakeSource.address() as AddressInfo;
    fakeSourceUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    restoreEnv();
    await new Promise<void>((resolve) => fakeSource.close(() => resolve()));
  });

  beforeEach(() => {
    fakeSourceStatus = 200;
    fakeSourceBody = { ok: true, httpListening: true, httpsListening: false, mode: "service" };
  });

  it("fails closed when OPENRESTY_STATUS_URL is not configured -- never a silent empty result", async () => {
    delete process.env.OPENRESTY_STATUS_URL;
    const result = await resolveOpenRestyStatusFromSource(fakeReq(), "openResty.443");
    expect(result.ok).toBe(false);
    expect((result as { status: number }).status).toBe(404);
    expect((result as { error: string }).error).toBe("OPENRESTY_STATUS_SOURCE_NOT_CONFIGURED");
  });

  it("bare 'openResty' returns the source's full status object as-is", async () => {
    process.env.OPENRESTY_STATUS_URL = fakeSourceUrl;
    const result = await resolveOpenRestyStatusFromSource(fakeReq(), "openResty");
    expect(result.ok).toBe(true);
    expect((result as { value: unknown }).value).toEqual(fakeSourceBody);
  });

  it("openResty.80 picks out httpListening; openResty.443 picks out httpsListening", async () => {
    process.env.OPENRESTY_STATUS_URL = fakeSourceUrl;
    const http80 = await resolveOpenRestyStatusFromSource(fakeReq(), "openResty.80");
    const https443 = await resolveOpenRestyStatusFromSource(fakeReq(), "openResty.443");
    expect((http80 as { value: unknown }).value).toBe(true);
    expect((https443 as { value: unknown }).value).toBe(false);
  });

  it("a confirmed 'not listening' is a real, visible false -- not an error, not omitted", async () => {
    process.env.OPENRESTY_STATUS_URL = fakeSourceUrl;
    fakeSourceBody = { ok: true, httpListening: false, httpsListening: false, mode: "service" };
    const result = await resolveOpenRestyStatusFromSource(fakeReq(), "openResty.443");
    expect(result.ok).toBe(true);
    expect((result as { value: unknown }).value).toBe(false);
  });

  it("passes through the source's own error status and body -- never masks a real 401/403 as something else", async () => {
    process.env.OPENRESTY_STATUS_URL = fakeSourceUrl;
    fakeSourceStatus = 401;
    fakeSourceBody = { ok: false, error: "SESSION_TOKEN_REQUIRED" };
    const result = await resolveOpenRestyStatusFromSource(fakeReq(), "openResty.443");
    expect(result.ok).toBe(false);
    expect((result as { status: number }).status).toBe(401);
    expect((result as { error: string }).error).toBe("SESSION_TOKEN_REQUIRED");
  });

  it("reports the source as unreachable rather than throwing, when nothing is listening -- distinguished from a confirmed 'not listening' value", async () => {
    process.env.OPENRESTY_STATUS_URL = "http://127.0.0.1:1"; // reserved port, nothing ever listens here
    const result = await resolveOpenRestyStatusFromSource(fakeReq(), "openResty.443");
    expect(result.ok).toBe(false);
    expect((result as { status: number }).status).toBe(502);
    expect((result as { error: string }).error).toBe("OPENRESTY_STATUS_SOURCE_UNREACHABLE");
  });
});

describe("createPathResolverHandler -- openResty branch wired end to end, namespace-scoped", () => {
  const CONFIGURED_NAMESPACE = "netget.openresty-e2e-test.local";
  let fakeSource: http.Server;
  let fakeSourceUrl: string;
  let app: express.Express;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    saveEnv();
    fakeSource = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, httpListening: true, httpsListening: true, mode: "service" }));
    });
    await new Promise<void>((resolve) => fakeSource.listen(0, resolve));
    fakeSourceUrl = `http://127.0.0.1:${(fakeSource.address() as AddressInfo).port}`;
    process.env.OPENRESTY_STATUS_URL = fakeSourceUrl;
    process.env.OPENRESTY_STATUS_NAMESPACE = CONFIGURED_NAMESPACE;

    app = express();
    app.get("/*", createPathResolverHandler());
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    restoreEnv();
    await new Promise<void>((resolve) => fakeSource.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("resolves me://<configured namespace>:read/openResty.443 into the fake source's real data, wrapped in the normal envelope", async () => {
    const res = await fetch(`${baseUrl}/openResty.443`, { headers: { 'x-forwarded-host': CONFIGURED_NAMESPACE } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.target.value).toBe(true);
    expect(body.disclosure).toBe("public");
  });

  it("does NOT intercept the identical dotPath under a DIFFERENT namespace -- falls through to the normal (empty) memory-store read instead of returning the host's own status", async () => {
    const res = await fetch(`${baseUrl}/openResty.443`, { headers: { 'x-forwarded-host': "someone-else.openresty-e2e-test.local" } });
    // Genuinely absent for this namespace (nothing was ever written there)
    // -> 404, never the fake source's data.
    expect(res.status).toBe(404);
  });
});
