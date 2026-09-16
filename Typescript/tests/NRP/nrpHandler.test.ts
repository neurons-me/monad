/**
 * nrpHandler.test.ts — wire-visible disclosure contract for the /nrp WebSocket path.
 *
 * AGENTS.md priority: HTTP and WebSocket must agree on disclosure states.
 * pathResolver.ts (HTTP) already collapses stealth/near-secret to "closed".
 * These tests pin that nrpHandler.ts (WebSocket) does the same — "stealth"
 * must never appear in a message actually sent to a client, regardless of
 * what the kernel reports internally.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "fs";
import os from "os";
import path from "path";
import WebSocket from "ws";
import { attachNrpWebSocketServer } from "../../src/http/nrpHandler.js";
import { resetKernelStateForTests } from "../../src/kernel/manager.js";

const ALLOWED_DISCLOSURES = new Set(["public", "opened", "closed", "contested"]);

const savedEnv: Record<string, string | undefined> = {};
const envKeys = ["ME_STATE_DIR", "MONADS_HOME", "SEED", "MONAD_ID"];

function saveEnv(): void {
  for (const key of envKeys) savedEnv[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of envKeys) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

let server: http.Server;
let baseUrl: string;

beforeAll(saveEnv);

beforeEach(async () => {
  process.env.ME_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "monad-nrp-ws-state-"));
  process.env.MONADS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "monad-nrp-ws-home-"));
  process.env.SEED = "nrp-handler-test-seed";
  process.env.MONAD_ID = "alice";
  resetKernelStateForTests();

  server = http.createServer();
  attachNrpWebSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${port}/nrp`;
});

afterEach(async () => {
  resetKernelStateForTests();
  restoreEnv();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function openAndAwaitType(expression: string, awaitedType: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`timed out waiting for ${awaitedType} message`));
    }, 2000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "nrp.open",
        expression,
        canonical: expression,
        ast: null,
      }));
    });

    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      if (msg.type === awaitedType) {
        clearTimeout(timer);
        ws.close();
        resolve(msg);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function openAndResolve(expression: string): Promise<Record<string, unknown>> {
  return openAndAwaitType(expression, "resolved");
}

function openAndError(expression: string): Promise<Record<string, unknown>> {
  return openAndAwaitType(expression, "error");
}

function openWithAst(canonical: string, ast: unknown, awaitedType: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`timed out waiting for ${awaitedType} message`));
    }, 2000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "nrp.open", expression: canonical, canonical, ast }));
    });

    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      if (msg.type === awaitedType) {
        clearTimeout(timer);
        ws.close();
        resolve(msg);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("/nrp WebSocket — disclosure never leaks 'stealth' on the wire", () => {
  it("a namespace the kernel does not confirm resolves to 'closed', not 'stealth'", async () => {
    const msg = await openAndResolve("me://nobody.local/profile/name");
    const payload = msg.payload as Record<string, unknown>;
    expect(payload.disclosure).not.toBe("stealth");
    expect(ALLOWED_DISCLOSURES.has(String(payload.disclosure))).toBe(true);
  });

  it("a bare expression with no namespace context still never emits 'stealth'", async () => {
    // Bare (no me:// scheme) namespace with real FQDN shape — the case this
    // test originally targeted: no explicit namespace context, kernel has
    // never heard of it, still must classify (not error) and never leak
    // 'stealth' on the wire.
    const msg = await openAndResolve("nobody.local");
    const payload = msg.payload as Record<string, unknown>;
    expect(payload.disclosure).not.toBe("stealth");
    expect(ALLOWED_DISCLOSURES.has(String(payload.disclosure))).toBe(true);
  });

  it("a shape-invalid bare expression is rejected before classification, not resolved as a namespace", async () => {
    // "profile/name" has no me:// scheme, so the bare-expression branch takes
    // the whole string as the namespace — "profile" (single label, no dot)
    // fails isValidDomainShape. This must reject with the domain-shape error
    // code before ever reaching the kernel, not get treated as if a path
    // fragment were a legitimate namespace to classify.
    const msg = await openAndError("profile/name");
    expect(msg.code).toBe("invalid_namespace_shape");
    expect(msg.payload).not.toContain("stealth");
  });

  it("an overlay expression's namespace leaf is shape-checked and classified on its own, not the whole composite string", async () => {
    // "nobody.local @ facebook.com" as a bare string fails isValidDomainShape
    // outright (spaces, '@' aren't domain-label characters) — before the ast
    // extraction fix, ANY overlay expression sent this way was rejected
    // regardless of whether its own namespace leaf was valid. The ast hint
    // lets the server find just "nobody.local" and classify that, ignoring
    // the (still fully unresolved, per SetChemistry.findings.md) surface.
    const canonical = "nobody.local @ facebook.com";
    const ast = {
      kind: "overlay",
      namespace: { kind: "namespace", value: "nobody.local", parsed: { fqdn: "nobody.local" } },
      surface: "facebook.com",
    };
    const msg = await openWithAst(canonical, ast, "resolved");
    const payload = msg.payload as Record<string, unknown>;
    expect(payload.disclosure).not.toBe("stealth");
    expect(ALLOWED_DISCLOSURES.has(String(payload.disclosure))).toBe(true);
  });

  it("a composite expression with no single namespace leaf (union) still falls back to the raw string", async () => {
    // Two leaves, no single one to prefer — falls back to the pre-fix
    // behavior (whole string checked as-is), which is why this stays
    // rejected: SetChemistry.findings.md already documents union/
    // intersection as having no real per-leaf resolution to fall back to
    // instead.
    const canonical = "a.b + c.d";
    const ast = {
      kind: "union",
      left: { kind: "namespace", value: "a.b", parsed: { fqdn: "a.b" } },
      right: { kind: "namespace", value: "c.d", parsed: { fqdn: "c.d" } },
    };
    const msg = await openWithAst(canonical, ast, "error");
    expect(msg.code).toBe("invalid_namespace_shape");
  });
});
