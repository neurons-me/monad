/**
 * HTTP orders are closed: every request under /__monads that is not a read is refused with 403 ORDERS_DISABLED,
 * on every path and with any headers; reads keep working; the CLI keeps working.
 *
 * Disposable MONADS_HOME. The monad is a stand-in: a plain sleeping child process with a hand-written record, so
 * the test needs neither a real monad server nor network ports beyond the control router's own (listening on every
 * interface, as src/index.ts does).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createMonadsControlRouter, ORDERS_DISABLED } from "../src/http/monadsControl.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const LAN = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;

let server: Server;
let port = 0;
let home = "";
let child: ChildProcess | null = null;
const saved: Record<string, string | undefined> = {};

type Reply = { status: number; body: any };

function send(address: string, lines: string[], body = ""): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, address, () => socket.write(lines.join("\r\n") + "\r\n\r\n" + body));
    let data = "";
    socket.on("data", (c) => { data += c.toString(); });
    socket.on("end", () => {
      const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(data)?.[1] || 0);
      const raw = data.split("\r\n\r\n").slice(1).join("\r\n\r\n");
      let parsed: any = raw;
      try { parsed = JSON.parse(raw); } catch {}
      resolve({ status, body: parsed });
    });
    socket.on("error", reject);
    setTimeout(() => socket.destroy(), 5000);
  });
}

function req(method: string, url: string, headers: Record<string, string> = {}, address = "127.0.0.1", json?: unknown): Promise<Reply> {
  const body = json === undefined ? "" : JSON.stringify(json);
  const lines = [`${method} ${url} HTTP/1.1`, "Connection: close", `Content-Length: ${Buffer.byteLength(body)}`];
  if (body) lines.push("Content-Type: application/json");
  if (!("Host" in headers)) lines.push(`Host: localhost:${port}`);
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  return send(address, lines, body);
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code !== "ESRCH"; }
}

async function waitGone(pid: number, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** A stand-in monad: a sleeping process and the record the runtime would have written for it. */
function standIn(name: string): { pid: number; recordPath: string } {
  child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
  const runtimeDir = path.join(home, name);
  const stateDir = path.join(runtimeDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const stdoutLog = path.join(runtimeDir, "stdout.log");
  const stderrLog = path.join(runtimeDir, "stderr.log");
  fs.writeFileSync(stdoutLog, "stand-in started\n");
  fs.writeFileSync(stderrLog, "");
  const now = new Date().toISOString();
  const record = {
    name, identity: name, namespace: `${name}.test`, surface: "", port: 1, pid: child.pid!,
    endpoint: "http://127.0.0.1:1", cwd: runtimeDir, startedAt: now, updatedAt: now, status: "running",
    runtimeDir, stateDir, claimDir: path.join(runtimeDir, "claims"), selfConfigPath: path.join(runtimeDir, "self.json"),
    stdoutLog, stderrLog,
  };
  const recordPath = path.join(runtimeDir, "monad.json");
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  return { pid: child.pid!, recordPath };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(createMonadsControlRouter());
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  saved.MONADS_HOME = process.env.MONADS_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "monad-orders-closed-"));
  process.env.MONADS_HOME = home;
});

afterEach(async () => {
  if (child?.pid && isAlive(child.pid)) {
    child.kill("SIGKILL");
    await waitGone(child.pid);
  }
  child = null;
  if (saved.MONADS_HOME === undefined) delete process.env.MONADS_HOME;
  else process.env.MONADS_HOME = saved.MONADS_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

// Every order route the router has had, including the older aliases, plus paths no route serves today.
const ORDERS: Array<[string, string, unknown?]> = [
  ["POST", "/__monads/start", { name: "fresh", port: 0 }],
  ["POST", "/__monads/a/start", { namespace: "someone.else" }],
  ["POST", "/__monads/a/on"],
  ["POST", "/__monads/a/resume"],
  ["POST", "/__monads/a/pause"],
  ["POST", "/__monads/a/off"],
  ["POST", "/__monads/a/stop"],
  ["POST", "/__monads/a/restart"],
  ["POST", "/__monads/a/delete"],
  ["DELETE", "/__monads/a"],
  ["PUT", "/__monads/a"],
  ["PATCH", "/__monads/a"],
  ["POST", "/__monads/a/recovery"],
  ["POST", "/__monads/a/anything-added-later"],
  ["POST", "/__monads"],
];

describe("HTTP orders are closed", () => {
  it("every order route, old and new, is refused with ORDERS_DISABLED and changes nothing", async () => {
    const { pid, recordPath } = standIn("a");
    const before = fs.readFileSync(recordPath, "utf8");

    for (const [method, url, body] of ORDERS) {
      const r = await req(method, url, {}, "127.0.0.1", body);
      expect([method, url, r.status, r.body?.error]).toEqual([method, url, 403, ORDERS_DISABLED]);
    }

    expect(isAlive(pid)).toBe(true);
    expect(fs.readFileSync(recordPath, "utf8")).toBe(before);
    expect(fs.existsSync(path.join(home, "fresh"))).toBe(false);
  });

  it("no header combination reopens them (forged Host, *.local, no Host, local Origins, forwarding)", async () => {
    const variants: Array<[Record<string, string>, string]> = [
      [{ Host: "localhost" }, "127.0.0.1"],
      [{ Host: "anything.local" }, "127.0.0.1"],
      [{ Host: "localhost", Origin: "http://printer.local" }, "127.0.0.1"],
      [{ Host: "localhost", Origin: `http://localhost:${port}` }, "127.0.0.1"],
      [{ Host: "localhost", Origin: "http://localhost:5173" }, "127.0.0.1"],
      [{ Host: "localhost", "X-Forwarded-For": "203.0.113.9" }, "127.0.0.1"],
    ];
    if (LAN) variants.push([{ Host: "localhost" }, LAN], [{ Host: "anything.local" }, LAN]);
    for (const [headers, address] of variants) {
      const r = await req("POST", "/__monads/a/off", headers, address);
      expect([headers, address, r.status, r.body?.error]).toEqual([headers, address, 403, ORDERS_DISABLED]);
    }
    const raw = await send("127.0.0.1", ["POST /__monads/a/off HTTP/1.0", "Content-Length: 0"]);
    expect([raw.status, raw.body?.error]).toEqual([403, ORDERS_DISABLED]);
  });

  it("reads still work: list, status, logs", async () => {
    standIn("a");
    const list = await req("GET", "/__monads");
    expect(list.status).toBe(200);
    expect(list.body.monads.map((m: any) => m.name)).toEqual(["a"]);
    expect((await req("GET", "/__monads/a/status")).status).toBe(200);
    expect((await req("GET", "/__monads/a/logs")).status).toBe(200);
  });

  it("the list advertises orders as CLI-only, so clients show them disabled instead of calling them", async () => {
    const list = await req("GET", "/__monads");
    const command = list.body.command;
    expect(command.orders).toMatchObject({ enabled: false, error: ORDERS_DISABLED });
    const byName = Object.fromEntries(command.actions.map((a: any) => [a.name, a]));
    for (const name of ["start", "on", "resume", "pause", "off", "stop", "restart", "delete"]) {
      expect([name, byName[name].method, byName[name].path]).toEqual([name, "CLI", ""]);
      expect(byName[name].command).toMatch(/^monads /);
    }
    for (const name of ["list", "status", "logs"]) {
      expect([name, byName[name].method]).toEqual([name, "GET"]);
    }
  });

  it("the monads command itself, run as its own process from source, still turns a monad off", async () => {
    const { pid, recordPath } = standIn("a");
    const out = spawnSync(path.join(here, "..", "node_modules", ".bin", "tsx"), [path.join(here, "..", "src", "cli", "monads.ts"), "off", "a"], {
      env: { ...process.env, MONADS_HOME: home },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(out.status).toBe(0);
    expect(await waitGone(pid)).toBe(true);
    expect(JSON.parse(fs.readFileSync(recordPath, "utf8")).status).toBe("stopped");
  }, 60_000);
});
