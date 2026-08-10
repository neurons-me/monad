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

function openAndResolve(expression: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("timed out waiting for resolved message"));
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
      if (msg.type === "resolved") {
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
    const msg = await openAndResolve("profile/name");
    const payload = msg.payload as Record<string, unknown>;
    expect(payload.disclosure).not.toBe("stealth");
    expect(ALLOWED_DISCLOSURES.has(String(payload.disclosure))).toBe(true);
  });
});
