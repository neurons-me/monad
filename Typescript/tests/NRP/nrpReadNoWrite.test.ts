/**
 * nrpReadNoWrite.test.ts — opening an NRP channel is a read: it must not write to the chain.
 *
 * Regression for 2026-11-11: classifyNamespace() called `(kernel as any).read?.(segments)`. The `.me` kernel has no
 * `read` method; on its proxy that call is a path builder, so every `nrp.open` appended a memory at `read` whose value
 * was the namespace's segments (reproduced on a disposable monad: 5 opens -> 5 `read` memories, control 0).
 *
 * The /nrp handler records no telemetry of its own, so any memory appended during an open is incidental.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "fs";
import os from "os";
import path from "path";
import WebSocket from "ws";
import { attachNrpWebSocketServer } from "../../src/http/nrpHandler.js";
import { getKernel, getKernelMemoryLog, resetKernelStateForTests } from "../../src/kernel/manager.js";

const envKeys = ["ME_STATE_DIR", "MONADS_HOME", "SEED", "MONAD_ID", "ME_NAMESPACE"];
const savedEnv: Record<string, string | undefined> = {};
let server: http.Server;
let baseUrl: string;

beforeAll(() => { for (const k of envKeys) savedEnv[k] = process.env[k]; });

beforeEach(async () => {
  process.env.ME_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "monad-nrp-nowrite-state-"));
  process.env.MONADS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "monad-nrp-nowrite-home-"));
  process.env.SEED = "nrp-read-no-write-seed";
  process.env.MONAD_ID = "alice";
  resetKernelStateForTests();
  server = http.createServer();
  attachNrpWebSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/nrp`;
});

afterEach(async () => {
  resetKernelStateForTests();
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function openAndResolve(expression: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("timed out waiting for resolved")); }, 2000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "nrp.open", expression, canonical: expression, ast: null })));
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      if (msg.type === "resolved" || msg.type === "error") { clearTimeout(timer); ws.close(); resolve(msg); }
    });
    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

const readMemories = () => getKernelMemoryLog().filter((m) => m.path === "read").length;

describe("/nrp open is a read", () => {
  it("does not append any memory to the chain", async () => {
    getKernel(); // the kernel exists before the first open, so its own bootstrap is not counted
    const before = getKernelMemoryLog().length;
    for (let i = 0; i < 5; i += 1) {
      const msg = await openAndResolve("me://jabellae.cleaker.me");
      expect(msg.type).toBe("resolved");
    }
    expect(readMemories()).toBe(0);
    expect(getKernelMemoryLog().length).toBe(before);
  });

  it("answers the same disclosure on every open (no state carried by a previous open)", async () => {
    getKernel();
    const first = await openAndResolve("me://nobody.local");
    const second = await openAndResolve("me://nobody.local");
    expect((first.payload as any).disclosure).toBe((second.payload as any).disclosure);
  });
});

// Public or private is decided at the namespace's root: the root and its handles are public unless a secret scope
// covers them; a namespace this monad does not serve is not answered as public.
describe("/nrp open: public or private at the namespace root", () => {
  const disclosureOf = async (expression: string) => ((await openAndResolve(expression)).payload as any).disclosure;

  beforeEach(() => {
    process.env.ME_NAMESPACE = "cleaker.me";
    resetKernelStateForTests();
  });

  it("this monad's root namespace is public", async () => {
    expect(await disclosureOf("me://cleaker.me")).toBe("public");
  });

  it("a handle under this monad's root is public", async () => {
    expect(await disclosureOf("me://jabellae.cleaker.me")).toBe("public");
  });

  it("a namespace this monad does not serve is closed", async () => {
    expect(await disclosureOf("me://nobody.local")).toBe("closed");
    expect(await disclosureOf("me://jabellae.other-root.com")).toBe("closed");
  });

  it("a handle whose root is a declared secret scope is closed, and its siblings stay public", async () => {
    (getKernel() as any).users.jabellae["_"]("nrp-test-scope-key");
    expect(Object.keys((getKernel() as any).localSecrets)).toContain("users.jabellae");
    expect(await disclosureOf("me://jabellae.cleaker.me")).toBe("closed");
    expect(await disclosureOf("me://ana.cleaker.me")).toBe("public");
  });

  it("a secret scope at the bare root makes every served namespace closed", async () => {
    (getKernel() as any)["_"]("nrp-test-root-key");
    expect(Object.keys((getKernel() as any).localSecrets)).toContain("");
    expect(await disclosureOf("me://cleaker.me")).toBe("closed");
    expect(await disclosureOf("me://jabellae.cleaker.me")).toBe("closed");
  });

  it("none of these opens writes to the chain", async () => {
    getKernel();
    const before = getKernelMemoryLog().length;
    for (const e of ["me://cleaker.me", "me://jabellae.cleaker.me", "me://nobody.local"]) await disclosureOf(e);
    expect(getKernelMemoryLog().length).toBe(before);
    expect(readMemories()).toBe(0);
  });
});
