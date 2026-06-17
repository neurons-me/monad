/**
 * bridgeSynthesis.test.ts — Phase 10: bridge-level Total Monad Synthesis
 *
 * WHAT IS THIS?
 * Step 7 wires the Phase 10 synthesis engine into bridgeHandler behind
 * MONAD_SYNTHESIS_ENABLED=1. These tests verify the wire behavior:
 *
 *   - flag off: old single-winner bridge path is unchanged
 *   - flag on + quorum: N monads are queried and reduced to one public value
 *   - flag on + divergence: response is disclosure="contested", value=null
 *   - maxCandidates=1: degenerates to the old single-forward path
 *   - all failed sources: disclosure="closed", HTTP 502
 */

import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import request from "supertest";
import { createBridgeHandler } from "../../src/handlers/bridgeHandler.js";
import { resetSynthesisDecisionLogForTests } from "../../src/kernel/decisionLog.js";
import { resetKernelStateForTests } from "../../src/kernel/manager.js";
import { writeMonadIndexEntry, type MonadIndexEntry } from "../../src/kernel/monadIndex.js";

const NS = "bob.local";
const SELF_ID = "alice";
const SELF_PORT = 9999;

const savedEnv: Record<string, string | undefined> = {};
const envKeys = [
  "ME_STATE_DIR",
  "MONADS_HOME",
  "SEED",
  "MONAD_ID",
  "MONAD_MESH_STALE_MS",
  "MONAD_SYNTHESIS_ENABLED",
  "MONAD_SYNTHESIS_MAX_CANDIDATES",
  "MONAD_SYNTHESIS_MIN_RELATIVE_SCORE",
  "MONAD_SYNTHESIS_QUORUM_THRESHOLD",
  "MONAD_SYNTHESIS_TIMEOUT_MS",
  "MONAD_DECISION_LOG",
  "MONAD_LEARNING_QUALITY_WEIGHT",
];

const originalFetch = globalThis.fetch;

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

function makeApp() {
  const app = express();
  app.use(express.json());
  app.get("/resolve", createBridgeHandler({
    hostname: "alice.local",
    port: SELF_PORT,
    selfNodeConfig: null,
  }));
  return app;
}

function target(pathSlash = "profile/name"): string {
  return `me://${NS}:read/${pathSlash}`;
}

function mesh(index: number, overrides: Partial<MonadIndexEntry> = {}): MonadIndexEntry {
  const now = Date.now();
  return {
    monad_id: `node-${index}`,
    namespace: NS,
    endpoint: `http://node-${index}.local:81${index}`,
    name: `node-${index}`,
    claimed_namespaces: [NS],
    first_seen: now - 60_000,
    last_seen: now - index * 1_000,
    ...overrides,
  };
}

function seedNodes(count: number): MonadIndexEntry[] {
  const entries: MonadIndexEntry[] = [];
  for (let i = 0; i < count; i++) {
    const entry = mesh(i);
    writeMonadIndexEntry(entry);
    entries.push(entry);
  }
  return entries;
}

function installFetch(valuesByMonadId: Record<string, unknown>, statusByMonadId: Record<string, number> = {}) {
  const mock = vi.fn(async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    const id = url.hostname.replace(".local", "");
    const status = statusByMonadId[id] ?? 200;
    const payload =
      status >= 200 && status < 300
        ? { ok: true, disclosure: "public", value: valuesByMonadId[id] }
        : { ok: false, error: "UPSTREAM_FAILED", value: null };

    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  });

  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

function tmpLog(): string {
  return path.join(os.tmpdir(), `bridge-synthesis-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

function readLog(filePath: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(saveEnv);

beforeEach(() => {
  process.env.ME_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "monad-bridge-synthesis-state-"));
  process.env.MONADS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "monad-bridge-synthesis-home-"));
  process.env.SEED = "bridge-synthesis-test-seed";
  process.env.MONAD_ID = SELF_ID;
  process.env.MONAD_MESH_STALE_MS = "300000";
  process.env.MONAD_SYNTHESIS_MIN_RELATIVE_SCORE = "0";
  process.env.MONAD_SYNTHESIS_QUORUM_THRESHOLD = "0.5";
  process.env.MONAD_SYNTHESIS_TIMEOUT_MS = "1000";
  process.env.MONAD_LEARNING_QUALITY_WEIGHT = "0.7";
  delete process.env.MONAD_DECISION_LOG;
  delete process.env.MONAD_SYNTHESIS_ENABLED;
  delete process.env.MONAD_SYNTHESIS_MAX_CANDIDATES;
  resetKernelStateForTests();
  resetSynthesisDecisionLogForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetKernelStateForTests();
  resetSynthesisDecisionLogForTests();
  restoreEnv();
});

describe("bridge synthesis — feature flag", () => {
  it("flag off preserves the Phase 8 single-forward response shape", async () => {
    seedNodes(3);
    const fetchMock = installFetch({
      "node-0": "winner",
      "node-1": "also-winner",
      "node-2": "different",
    });

    const res = await request(makeApp())
      .get("/resolve")
      .query({ target: target() });

    expect(res.status).toBe(200);
    expect(res.body.value).toBe("winner");
    expect(res.body._mesh.monad_id).toBe("node-0");
    expect(res.body._synthesis).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("flag on + quorum queries multiple monads and returns one public value", async () => {
    process.env.MONAD_SYNTHESIS_ENABLED = "1";
    process.env.MONAD_SYNTHESIS_MAX_CANDIDATES = "3";
    seedNodes(3);
    const fetchMock = installFetch({
      "node-0": "same",
      "node-1": "same",
      "node-2": "different",
    });

    const res = await request(makeApp())
      .get("/resolve")
      .query({ target: target() });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.disclosure).toBe("public");
    expect(res.body.value).toBe("same");
    expect(res.body._mesh.monad_id).toBe("node-0");
    expect(res.body._mesh.reason).toBe("synthesis");
    expect(res.body._synthesis.quorum.met).toBe(true);
    expect(res.body._synthesis.quorum.agreeCount).toBe(2);
    expect(res.body._synthesis.sources).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("flag on + no quorum returns contested with null value and negative synthesis reward", async () => {
    process.env.MONAD_SYNTHESIS_ENABLED = "1";
    process.env.MONAD_SYNTHESIS_MAX_CANDIDATES = "3";
    const logFile = tmpLog();
    process.env.MONAD_DECISION_LOG = logFile;
    seedNodes(3);
    const fetchMock = installFetch({
      "node-0": "a",
      "node-1": "b",
      "node-2": "c",
    });

    const res = await request(makeApp())
      .get("/resolve")
      .query({ target: target() });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.disclosure).toBe("contested");
    expect(res.body.value).toBeNull();
    expect(res.body._mesh.monad_id).toBe("node-0");
    expect(res.body._synthesis.quorum.met).toBe(false);
    expect(res.body._synthesis.divergence.strategy).toBe("contested");
    expect(res.body._synthesis.sources.map((s: any) => s.value)).toEqual(["a", "b", "c"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [entry] = readLog(logFile);
    expect(entry!.synthesisPolicy).toBe("strict-quorum");
    expect(entry!.monadId).toBe("synthesis");
    expect(entry!.divergenceStrategy).toBe("contested");
    expect(entry!.reward).toBeCloseTo(-0.21, 10);
    try { fs.unlinkSync(logFile); } catch { /* best-effort */ }
  });

  it("maxCandidates=1 degenerates to single-forward without _synthesis", async () => {
    process.env.MONAD_SYNTHESIS_ENABLED = "1";
    process.env.MONAD_SYNTHESIS_MAX_CANDIDATES = "1";
    seedNodes(3);
    const fetchMock = installFetch({
      "node-0": "winner",
      "node-1": "other",
      "node-2": "other",
    });

    const res = await request(makeApp())
      .get("/resolve")
      .query({ target: target() });

    expect(res.status).toBe(200);
    expect(res.body.value).toBe("winner");
    expect(res.body._mesh.monad_id).toBe("node-0");
    expect(res.body._synthesis).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("all failed sources return closed synthesis with HTTP 502", async () => {
    process.env.MONAD_SYNTHESIS_ENABLED = "1";
    process.env.MONAD_SYNTHESIS_MAX_CANDIDATES = "3";
    seedNodes(3);
    const fetchMock = installFetch(
      { "node-0": null, "node-1": null, "node-2": null },
      { "node-0": 500, "node-1": 502, "node-2": 503 },
    );

    const res = await request(makeApp())
      .get("/resolve")
      .query({ target: target() });

    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.disclosure).toBe("closed");
    expect(res.body.value).toBeNull();
    expect(res.body._synthesis.quorum.totalCount).toBe(0);
    expect(res.body._synthesis.sources).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
