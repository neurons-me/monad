/**
 * nrpDeclaredRoot.test.ts — the /nrp entry accepts the root form of a declared space.
 *
 * `me://jabellae.localhost` (a name inside a space) always passed the domain-shape gate. `me://localhost` (the
 * space itself) could not: the gate is context-free and wants two labels. The entry now also lets through a
 * space THIS runtime declared (ME_NAMESPACE / MONAD_LOCAL_ALIAS_ROOT / MONAD_CANONICAL_SPACE), and nothing else.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "fs";
import os from "os";
import path from "path";
import WebSocket from "ws";
import { attachNrpWebSocketServer } from "../../src/http/nrpHandler.js";
import { declaredSpaceReference } from "../../src/runtime/hostResolver.js";
import { resetKernelStateForTests } from "../../src/kernel/manager.js";

const envKeys = ["ME_STATE_DIR", "MONADS_HOME", "SEED", "MONAD_ID", "ME_NAMESPACE", "MONAD_LOCAL_ALIAS_ROOT", "MONAD_CANONICAL_SPACE"];
const savedEnv: Record<string, string | undefined> = {};

let server: http.Server;
let baseUrl: string;

beforeAll(() => {
  for (const key of envKeys) savedEnv[key] = process.env[key];
});

beforeEach(async () => {
  process.env.ME_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "monad-nrp-root-state-"));
  process.env.MONADS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "monad-nrp-root-home-"));
  process.env.SEED = "nrp-declared-root-seed";
  process.env.MONAD_ID = "alice";
  delete process.env.MONAD_LOCAL_ALIAS_ROOT;
  delete process.env.MONAD_CANONICAL_SPACE;
  resetKernelStateForTests();
  server = http.createServer();
  attachNrpWebSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/nrp`;
});

afterEach(async () => {
  resetKernelStateForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterAll(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** Sends one message after the socket opens and resolves with the first reply of the awaited type. */
function exchange(message: Record<string, unknown>, awaitedType: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`timed out waiting for ${awaitedType}`));
    }, 2000);
    ws.on("open", () => ws.send(JSON.stringify(message)));
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      if (msg.type === awaitedType || msg.type === "error") {
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

const open = (expression: string) =>
  exchange({ type: "nrp.open", expression, canonical: expression, ast: null }, "resolved");

describe("declaredSpaceReference", () => {
  it("recognizes a declared space, with or without me://, and nothing else", () => {
    const env = { ME_NAMESPACE: "localhost", MONAD_CANONICAL_SPACE: "neurons.me" };
    expect(declaredSpaceReference("me://localhost", env)).toEqual({ space: "localhost" });
    expect(declaredSpaceReference("localhost", env)).toEqual({ space: "localhost" });
    expect(declaredSpaceReference("LocalHost", env)).toEqual({ space: "localhost" });
    expect(declaredSpaceReference("me://neurons.me", env)).toEqual({ space: "neurons.me" });
    // A name inside a declared space is the handle form, not the space.
    expect(declaredSpaceReference("me://jabellae.localhost", env)).toBeNull();
    expect(declaredSpaceReference("elsewhere", env)).toBeNull();
    expect(declaredSpaceReference("a + b", env)).toBeNull();
    expect(declaredSpaceReference("", env)).toBeNull();
  });

  it("takes nothing for a space when the runtime declares nothing", () => {
    expect(declaredSpaceReference("me://localhost", {})).toBeNull();
    expect(declaredSpaceReference("localhost", {})).toBeNull();
  });
});

describe("/nrp open under a declared single-label root", () => {
  beforeEach(() => {
    process.env.ME_NAMESPACE = "localhost";
  });

  it("accepts the root form and the handle form of the same address", async () => {
    expect((await open("me://localhost")).type).toBe("resolved");
    expect((await open("me://localhost/profile.name")).type).toBe("resolved");
    expect((await open("me://localhost[macbook]")).type).toBe("resolved");
    expect((await open("me://jabellae.localhost")).type).toBe("resolved");
    // A bare expression (no me://) is the same reference.
    expect((await open("localhost")).type).toBe("resolved");
  });

  it("still refuses a single label that was not declared", async () => {
    const msg = await open("me://elsewhere");
    expect(msg).toMatchObject({ type: "error", code: "invalid_namespace_shape" });
  });

  it("serves reads under the declared root: an absent path is a missing path, not an unserved namespace", async () => {
    const absent = await exchange({ type: "read", namespace: "localhost", path: "profile.name" }, "data");
    expect(absent).toMatchObject({ type: "error", payload: "PATH_NOT_FOUND" });
    // The same read against a namespace this runtime does not serve is refused for THAT reason.
    const unserved = await exchange({ type: "read", namespace: "elsewhere", path: "profile.name" }, "data");
    expect(unserved).toMatchObject({ type: "error", payload: "NAMESPACE_NOT_SERVED" });
  });
});

describe("/nrp open when the declared root has several labels or the runtime declares another", () => {
  it("does not let a single label through just because some other space is declared", async () => {
    process.env.ME_NAMESPACE = "cleaker.me";
    expect(await open("me://cleaker.me").then((m) => m.type)).toBe("resolved");
    expect(await open("me://localhost")).toMatchObject({ type: "error", code: "invalid_namespace_shape" });
  });

  it("accepts the root as declared by MONAD_LOCAL_ALIAS_ROOT too", async () => {
    process.env.ME_NAMESPACE = "cleaker.me";
    process.env.MONAD_LOCAL_ALIAS_ROOT = "here";
    expect(await open("me://here").then((m) => m.type)).toBe("resolved");
  });
});
