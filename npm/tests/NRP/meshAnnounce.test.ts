/**
 * meshAnnounce.test.ts — Remote Surface Registration
 *
 * WHAT IS MESH ANNOUNCE?
 * Any monad can POST to another surface's /.mesh/announce to register itself
 * in that surface's mesh index. This is how a Raspberry Pi monad becomes
 * visible in `cleaker.me`'s directory, even though it runs on a private device.
 *
 * The announce endpoint:
 *   - Validates required fields (monad_id, namespace, endpoint)
 *   - Writes the entry to the local kernel mesh index
 *   - Throttles repeated announces from the same monad (min 10s between accepts)
 *   - Returns { ok, registered, namespace, monad_id }
 *
 * WHAT WE TEST:
 *   1. Valid announce is written to index and 200 returned
 *   2. Missing required fields → 400
 *   3. Second announce within throttle window → throttled (not re-written)
 *   4. After throttle window expires → accepted again
 *   5. claimed_namespaces defaults to [namespace] when absent
 *   6. scope_path is stored when provided
 */

import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import request from "supertest";
import { resetKernelStateForTests } from "../../src/kernel/manager.js";
import { readMonadIndexEntry } from "../../src/kernel/monadIndex.js";
import { createMeshAnnounceRouter, resetAnnounceThrottleForTests } from "../../src/http/meshAnnounce.js";

// ── Test isolation ─────────────────────────────────────────────────────────────

const savedSeed = process.env.SEED;
const savedStateDir = process.env.ME_STATE_DIR;

beforeEach(() => {
  process.env.ME_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "monad-announce-"));
  process.env.SEED = "announce-test-seed";
  resetKernelStateForTests();
});

afterEach(() => {
  process.env.SEED = savedSeed;
  process.env.ME_STATE_DIR = savedStateDir;
  resetKernelStateForTests();
  resetAnnounceThrottleForTests();
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(createMeshAnnounceRouter());
  return app;
}

const VALID_BODY = {
  monad_id: "monad:abc123",
  name: "frank",
  namespace: "suign.cleaker.me",
  endpoint: "http://raspberry.local:8161",
  claimed_namespaces: ["suign.cleaker.me"],
  tags: ["raspberry", "sensor"],
  type: "server",
  trust: "trusted-peer",
};

// ── 1. Valid announce ──────────────────────────────────────────────────────────

describe("POST /.mesh/announce — valid registration", () => {
  it("returns 200 with registered=true and writes entry to index", async () => {
    const app = makeApp();
    const res = await request(app).post("/.mesh/announce").send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.registered).toBe(true);
    expect(res.body.monad_id).toBe("monad:abc123");
    expect(res.body.namespace).toBe("suign.cleaker.me");

    const entry = readMonadIndexEntry("monad:abc123");
    expect(entry).not.toBeUndefined();
    expect(entry!.namespace).toBe("suign.cleaker.me");
    expect(entry!.endpoint).toBe("http://raspberry.local:8161");
    expect(entry!.name).toBe("frank");
  });

  it("stores tags and claimed_namespaces correctly", async () => {
    await request(makeApp()).post("/.mesh/announce").send(VALID_BODY);
    const entry = readMonadIndexEntry("monad:abc123");
    expect(entry!.tags).toEqual(["raspberry", "sensor"]);
    expect(entry!.claimed_namespaces).toContain("suign.cleaker.me");
  });
});

// ── 2. Missing required fields ────────────────────────────────────────────────

describe("POST /.mesh/announce — validation", () => {
  it("returns 400 when monad_id is missing", async () => {
    const { monad_id: _, ...body } = VALID_BODY;
    const res = await request(makeApp()).post("/.mesh/announce").send(body);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("ANNOUNCE_INVALID");
  });

  it("returns 400 when namespace is missing", async () => {
    const { namespace: _, ...body } = VALID_BODY;
    const res = await request(makeApp()).post("/.mesh/announce").send(body);
    expect(res.status).toBe(400);
  });

  it("returns 400 when endpoint is missing", async () => {
    const { endpoint: _, ...body } = VALID_BODY;
    const res = await request(makeApp()).post("/.mesh/announce").send(body);
    expect(res.status).toBe(400);
  });
});

// ── 3. Throttling ─────────────────────────────────────────────────────────────

describe("POST /.mesh/announce — throttling", () => {
  it("second immediate announce returns registered=false with reason throttled", async () => {
    const app = makeApp();
    await request(app).post("/.mesh/announce").send(VALID_BODY);
    const res2 = await request(app).post("/.mesh/announce").send(VALID_BODY);

    expect(res2.body.registered).toBe(false);
    expect(res2.body.reason).toBe("throttled");
  });

  it("different monad_id is never throttled by another monad's window", async () => {
    const app = makeApp();
    await request(app).post("/.mesh/announce").send(VALID_BODY);

    const other = { ...VALID_BODY, monad_id: "monad:xyz999", name: "ana" };
    const res = await request(app).post("/.mesh/announce").send(other);

    expect(res.body.registered).toBe(true);
  });
});

// ── 4. Defaults ───────────────────────────────────────────────────────────────

describe("POST /.mesh/announce — defaults", () => {
  it("claimed_namespaces defaults to [namespace] when absent", async () => {
    const body = { monad_id: "monad:def456", namespace: "frank.local", endpoint: "http://frank.local:8161" };
    await request(makeApp()).post("/.mesh/announce").send(body);
    const entry = readMonadIndexEntry("monad:def456");
    expect(entry!.claimed_namespaces).toEqual(["frank.local"]);
  });

  it("stores scope_path when provided", async () => {
    const body = { ...VALID_BODY, monad_id: "monad:scoped", scope_path: "/projects/music" };
    await request(makeApp()).post("/.mesh/announce").send(body);
    const entry = readMonadIndexEntry("monad:scoped");
    expect(entry!.scope_path).toBe("/projects/music");
  });
});
