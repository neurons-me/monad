/**
 * monadsControlOrigin.test.ts — /__monads/* control-plane authorization
 * (start/stop/restart/delete named monad processes, src/http/monadsControl.ts).
 *
 * Found live 2026-10-04 (netget-side audit of loopback-only/CORS-reflection
 * gaps, extended to monad's own routes): localControlGuard's isAllowedOrigin()
 * treated the literal Origin header value "null" the same as no Origin header
 * at all -- both exempted from the check entirely. That is a real,
 * well-known CSRF bypass class, not a harmless edge case: a sandboxed iframe
 * (`<iframe sandbox src="data:text/html,...">`) or a data:/file: page sends
 * exactly `Origin: null` by spec, specifically because it has no origin of
 * its own to disclose. A page with nothing to lose by having no real origin
 * could embed one of these, whose script then reaches this control plane
 * with Origin: null and sailed straight through the guard -- while an
 * ordinary cross-origin fetch() (a real Origin header) was already,
 * correctly, rejected.
 *
 * Fixed: only a COMPLETELY ABSENT Origin header is treated as "nothing to
 * check" now; the literal string "null" is evaluated as a real origin value
 * (and fails, since "null" is not a local host).
 *
 * This battery proves, against a real in-process monad (no mocks for the
 * guard itself), that:
 *   - no Origin header at all is still allowed (non-browser callers, and
 *     same-origin requests, send none) -- the fix must not break this;
 *   - a real cross-origin fetch (Origin: https://evil.example) is blocked --
 *     confirms the mechanism this guard is actually for still works;
 *   - Origin: null is now ALSO blocked -- the bug this file exists to prove
 *     fixed;
 *   - a legitimate local origin (matching local.monad/localhost/127.0.0.1/
 *     ::1/*.local) still passes.
 *
 * Deliberately NOT changed here, and worth documenting rather than treating
 * as the same class of bug: isLocalControlHost() trusts ANY origin whose
 * host label matches those patterns, regardless of port -- an origin of
 * http://localhost:9999 passes exactly like http://localhost:<this-monad's-
 * own-port> would. That is a broader "anything running locally on this
 * machine is trusted" boundary, a judgment call about this guard's threat
 * model (a compromised OTHER local dev server could pivot into this control
 * plane), not a clear-cut bug the way the null-Origin exemption was -- left
 * alone pending an explicit decision to narrow it.
 */
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, it } from "vitest";
import { createMonadApp } from "../../src/index.js";

describe("monadsControl /__monads Origin guard", () => {
  let tmp: string;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "monad-control-origin-"));
    process.env.SEED = crypto.randomBytes(32).toString("hex");
    process.env.ME_STATE_DIR = tmp;
    process.env.MONAD_NETGET_DISABLED = "1";
    process.env.MONAD_SELF_IDENTITY = "control-origin-test.local";
    const app: any = await createMonadApp({});
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    port = (server.address() as any).port;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function call(headers: Record<string, string>): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "GET", path: "/__monads", timeout: 5000, headers: { host: "localhost", ...headers } },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c) => { text += c; });
          res.on("end", () => resolve({ status: res.statusCode || 0, text }));
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.end();
    });
  }

  it("no Origin header at all is allowed", async () => {
    const r = await call({});
    assert.equal(r.status, 200, r.text);
  });

  it("a real cross-origin request is blocked", async () => {
    const r = await call({ origin: "https://evil.example" });
    assert.equal(r.status, 403, r.text);
    assert.match(r.text, /LOCAL_MONADS_CONTROL_ONLY/);
  });

  it("Origin: null (the sandboxed-iframe/data: bypass) is now blocked, not exempted", async () => {
    const r = await call({ origin: "null" });
    assert.equal(r.status, 403, r.text);
    assert.match(r.text, /LOCAL_MONADS_CONTROL_ONLY/);
  });

  it("a legitimate local Origin still passes", async () => {
    const r = await call({ origin: "http://localhost" });
    assert.equal(r.status, 200, r.text);
  });
});
