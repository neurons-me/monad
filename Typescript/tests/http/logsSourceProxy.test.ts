/**
 * logsSourceProxy.test.ts — the `logs`/`logs.*` NRP read path never touches
 * the memory store (see logsSourceProxy.ts's own header for why); it
 * proxies to a real, external, ROTATING log source configured via
 * LOG_SOURCE_URL, ONLY for the exact namespace configured via
 * LOG_SOURCE_NAMESPACE, and ONLY for the finite set of real log types.
 * This is a fake source (an http.Server this test controls entirely) —
 * never a real netget backend, never the real gateway.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { resolveLogsFromSource, shouldInterceptLogsPath } from "../../src/http/logsSourceProxy.js";
import { createPathResolverHandler } from "../../src/http/pathResolver.js";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["LOG_SOURCE_URL", "LOG_SOURCE_NAMESPACE"];

function saveEnv(): void {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

function fakeReq(query: Record<string, unknown>, headers: Record<string, string> = {}): { header(name: string): string | undefined; query: Record<string, unknown> } {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    query,
  };
}

describe("shouldInterceptLogsPath -- namespace and path must both match exactly", () => {
  afterEach(restoreEnv);

  it("never intercepts when LOG_SOURCE_NAMESPACE isn't configured, regardless of dotPath", () => {
    delete process.env.LOG_SOURCE_NAMESPACE;
    expect(shouldInterceptLogsPath("netget.local.cleaker", "logs.access")).toBe(false);
  });

  it("intercepts the configured namespace's own logs.access/error/server and bare 'logs'", () => {
    process.env.LOG_SOURCE_NAMESPACE = "netget.local.cleaker";
    expect(shouldInterceptLogsPath("netget.local.cleaker", "logs")).toBe(true);
    expect(shouldInterceptLogsPath("netget.local.cleaker", "logs.access")).toBe(true);
    expect(shouldInterceptLogsPath("netget.local.cleaker", "logs.error")).toBe(true);
    expect(shouldInterceptLogsPath("netget.local.cleaker", "logs.server")).toBe(true);
  });

  it("never intercepts a DIFFERENT namespace's read of the exact same dotPath -- two namespaces asking for logs.access must not resolve to the same host logs", () => {
    process.env.LOG_SOURCE_NAMESPACE = "netget.local.cleaker";
    expect(shouldInterceptLogsPath("someone-else.local.cleaker", "logs.access")).toBe(false);
    expect(shouldInterceptLogsPath("alice.local.cleaker", "logs.access")).toBe(false);
  });

  it("never intercepts a dotPath outside the finite known set, even under the configured namespace -- a legitimate 'logs.retention-policy' path must fall through untouched", () => {
    process.env.LOG_SOURCE_NAMESPACE = "netget.local.cleaker";
    expect(shouldInterceptLogsPath("netget.local.cleaker", "logs.retention-policy")).toBe(false);
    expect(shouldInterceptLogsPath("netget.local.cleaker", "logsomething")).toBe(false);
  });
});

describe("resolveLogsFromSource", () => {
  let fakeSource: http.Server;
  let fakeSourceUrl: string;
  let lastRequest: { url: string; headers: http.IncomingHttpHeaders } | null = null;
  let fakeSourceStatus = 200;
  let fakeSourceBody: unknown = { logs: [{ id: 0, timestamp: "2026-09-11T00:00:00Z", level: "INFO", message: "hello" }], total: 1 };

  beforeAll(async () => {
    saveEnv();
    fakeSource = http.createServer((req, res) => {
      lastRequest = { url: req.url || "", headers: req.headers };
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
    lastRequest = null;
    fakeSourceStatus = 200;
    fakeSourceBody = { logs: [{ id: 0, timestamp: "2026-09-11T00:00:00Z", level: "INFO", message: "hello" }], total: 1 };
  });

  it("fails closed when LOG_SOURCE_URL is not configured -- never a silent empty result", async () => {
    delete process.env.LOG_SOURCE_URL;
    const result = await resolveLogsFromSource(fakeReq({}), "logs.access");
    expect(result.ok).toBe(false);
    expect((result as { status: number }).status).toBe(404);
    expect((result as { error: string }).error).toBe("LOG_SOURCE_NOT_CONFIGURED");
  });

  it("proxies to the configured source, forwarding type/limit/offset and the Authorization header ONLY", async () => {
    process.env.LOG_SOURCE_URL = fakeSourceUrl;
    const result = await resolveLogsFromSource(
      fakeReq(
        { limit: "10", offset: "5" },
        {
          authorization: "Bearer real-session-token",
          // Forged headers a direct caller (bypassing nginx) could set --
          // must NOT reach the source at all, proving the fix, not just
          // asserting it in prose.
          "x-netget-identity": "forged-identity",
          "x-netget-scopes": '["gateway:read"]',
        },
      ),
      "logs.error",
    );
    expect(result.ok).toBe(true);
    expect((result as { value: unknown }).value).toEqual(fakeSourceBody);

    expect(lastRequest).not.toBeNull();
    const url = new URL(lastRequest!.url, "http://x");
    expect(url.pathname).toBe("/logs");
    expect(url.searchParams.get("type")).toBe("error"); // from the PATH segment, not a query param
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("offset")).toBe("5");
    expect(lastRequest!.headers["authorization"]).toBe("Bearer real-session-token");
    expect(lastRequest!.headers["x-netget-identity"]).toBeUndefined();
    expect(lastRequest!.headers["x-netget-scopes"]).toBeUndefined();
  });

  it("falls back to ?type= when the dotPath is bare 'logs'", async () => {
    process.env.LOG_SOURCE_URL = fakeSourceUrl;
    await resolveLogsFromSource(fakeReq({ type: "server" }), "logs");
    const url = new URL(lastRequest!.url, "http://x");
    expect(url.searchParams.get("type")).toBe("server");
  });

  it("passes through the source's own error status and body -- never masks a real 401/403 as something else", async () => {
    process.env.LOG_SOURCE_URL = fakeSourceUrl;
    fakeSourceStatus = 403;
    fakeSourceBody = { ok: false, error: "NOT_AN_ADMIN" };
    const result = await resolveLogsFromSource(fakeReq({}), "logs.access");
    expect(result.ok).toBe(false);
    expect((result as { status: number }).status).toBe(403);
    expect((result as { error: string }).error).toBe("NOT_AN_ADMIN");
  });

  it("reports the source as unreachable rather than throwing, when nothing is listening", async () => {
    process.env.LOG_SOURCE_URL = "http://127.0.0.1:1"; // reserved port, nothing ever listens here
    const result = await resolveLogsFromSource(fakeReq({}), "logs.access");
    expect(result.ok).toBe(false);
    expect((result as { status: number }).status).toBe(502);
    expect((result as { error: string }).error).toBe("LOG_SOURCE_UNREACHABLE");
  });
});

describe("createPathResolverHandler -- logs branch wired end to end, namespace-scoped", () => {
  const CONFIGURED_NAMESPACE = "netget.logs-e2e-test.local";
  let fakeSource: http.Server;
  let fakeSourceUrl: string;
  let app: express.Express;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    saveEnv();
    fakeSource = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ logs: [{ id: 1, timestamp: "2026-09-11T00:00:00Z", level: "WARN", message: "disk 80% full" }], total: 1 }));
    });
    await new Promise<void>((resolve) => fakeSource.listen(0, resolve));
    fakeSourceUrl = `http://127.0.0.1:${(fakeSource.address() as AddressInfo).port}`;
    process.env.LOG_SOURCE_URL = fakeSourceUrl;
    process.env.LOG_SOURCE_NAMESPACE = CONFIGURED_NAMESPACE;

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

  it("resolves me://<configured namespace>:read/logs.error into the fake source's real data, wrapped in the normal envelope", async () => {
    const res = await fetch(`${baseUrl}/logs.error?limit=5`, { headers: { 'x-forwarded-host': CONFIGURED_NAMESPACE } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.target.value.logs[0].message).toBe("disk 80% full");
    expect(body.disclosure).toBe("public");
  });

  it("does NOT intercept the identical dotPath under a DIFFERENT namespace -- falls through to the normal (empty) memory-store read instead of returning the host's logs", async () => {
    const res = await fetch(`${baseUrl}/logs.error?limit=5`, { headers: { 'x-forwarded-host': "someone-else.logs-e2e-test.local" } });
    const body = await res.json();
    // Genuinely absent for this namespace (nothing was ever written there)
    // -> 404, never the fake source's data. If the namespace check were
    // missing, this would incorrectly return 200 with "disk 80% full".
    expect(res.status).toBe(404);
    expect(JSON.stringify(body)).not.toContain("disk 80% full");
  });

  it("never falls through to the memory store's own public/closed/404 classification for the configured namespace's logs path", async () => {
    // If this fell through, a namespace with nothing at "logs.error" would
    // 404 (genuinely absent) -- the whole point is that it must not reach
    // that code path at all, real data must come back instead.
    const res = await fetch(`${baseUrl}/logs.error`, { headers: { 'x-forwarded-host': CONFIGURED_NAMESPACE } });
    expect(res.status).not.toBe(404);
  });
});
