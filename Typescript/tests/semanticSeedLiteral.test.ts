/**
 * semanticSeedLiteral.test.ts — a value written with operator "=" through appendSemanticMemory is stored as the
 * literal value ("set", the monad's contract), so text survives and the bootstrap does not re-insert it.
 *
 * Regression for 2026-11-11: memoryStore.kernelWrite routed "=" with a primitive through the proxy's eval syntax
 * (`scope["="](leaf, data)`). In .me that is the formula operator: a string is evaluated as an expression, so plain
 * text ("Maria Garcia", "text") was stored with expression and value undefined. Text seeds were lost, and every monad
 * start re-inserted the 158 schema/gui seeds because the read never matched (measured: 164 memories per start/stop,
 * 158 of them those seeds; on the VM 790 of 836 "=" memories had no value).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { appendSemanticMemory, readSemanticValueForNamespace } from "../src/claim/memoryStore.js";
import { ensureRootSemanticBootstrap } from "../src/claim/semanticBootstrap.js";
import { ROOT_SCHEMA_SEEDS } from "../src/claim/semanticCatalog.js";
import { getKernel, getKernelMemoryLog, resetKernelStateForTests, saveSnapshotOrThrow } from "../src/kernel/manager.js";

const envKeys = ["ME_STATE_DIR", "MONADS_HOME", "SEED", "ME_NAMESPACE"];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => { for (const k of envKeys) savedEnv[k] = process.env[k]; });

beforeEach(() => {
  process.env.ME_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "monad-seed-literal-state-"));
  process.env.MONADS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "monad-seed-literal-home-"));
  process.env.SEED = "semantic-seed-literal-test-seed";
  process.env.ME_NAMESPACE = "cleaker.me";
  resetKernelStateForTests();
});

afterEach(() => {
  resetKernelStateForTests();
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const NS = "cleaker.me";

describe('operator "=" stores the literal value', () => {
  it.each([
    ["plain text", "Maria Garcia"],
    ["a word", "text"],
    ["text that looks like a formula", "a + b"],
    ["empty text", ""],
    ["a number", 10],
    ["zero", 0],
    ["a boolean", false],
  ])("%s reads back exactly", (_label, value) => {
    appendSemanticMemory({ namespace: NS, path: "profile.field", operator: "=", data: value });
    expect(readSemanticValueForNamespace(NS, "profile.field")).toEqual(value);
    const last = getKernelMemoryLog()[getKernelMemoryLog().length - 1]!;
    expect(last.operator).toBe("=");
    expect(last.value).toEqual(value);
  });
});

// A restart: drop the kernel (resetKernelStateForTests also removes the state dir), put the saved snapshot back,
// and let the next getKernel() hydrate from it.
function restartFromSnapshot(): void {
  saveSnapshotOrThrow();
  const stateDir = process.env.ME_STATE_DIR!;
  const saved = fs.readFileSync(path.join(stateDir, "snapshot.json"));
  resetKernelStateForTests();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "snapshot.json"), saved);
  getKernel();
}

// Records written BEFORE this fix: the old kernelWrite sent "=" through the proxy's formula syntax. Here they are
// written the same way, directly on the kernel, and then hydrated by the fixed code. Hydration does not go through
// kernelWrite, so the fix must not change how any of them reads.
describe("records written before the fix keep reading as they did", () => {
  const writeTheOldWay = (leafParent: string, leaf: string, data: unknown) => {
    const scope = leafParent.split(".").reduce((p: any, k) => p[k], getKernel() as any);
    scope["="](leaf, data);
  };

  it("an old text record stays as it was stored (empty), an old formula keeps its computed value", () => {
    getKernel();
    (getKernel() as any).execute("me://self:write/old/a", 2, null);
    (getKernel() as any).execute("me://self:write/old/b", 3, null);
    writeTheOldWay("old", "name", "Maria Garcia"); // old bug: stored with value undefined
    writeTheOldWay("old", "total", "a + b"); // a real formula: stored with its computed value
    expect(readSemanticValueForNamespace(NS, "old.name")).toBeUndefined();
    expect(readSemanticValueForNamespace(NS, "old.total")).toBe(5);
    const count = getKernelMemoryLog().length;

    restartFromSnapshot();

    expect(getKernelMemoryLog().length).toBe(count);
    expect(readSemanticValueForNamespace(NS, "old.name")).toBeUndefined();
    expect(readSemanticValueForNamespace(NS, "old.total")).toBe(5);
  });

  it("on a snapshot made by the old code, the bootstrap re-inserts the lost text seeds once, then never again", () => {
    getKernel();
    // What the old code left behind: each text seed stored with value undefined.
    const textSeeds = ROOT_SCHEMA_SEEDS.filter((s) => typeof s.data === "string");
    for (const seed of textSeeds) {
      const parts = seed.path.split(".");
      writeTheOldWay(parts.slice(0, -1).join("."), parts[parts.length - 1]!, seed.data);
    }
    restartFromSnapshot();
    const first = ensureRootSemanticBootstrap(NS);
    expect(first).toBeGreaterThan(0); // the seeds whose text was lost (and any never written)
    restartFromSnapshot();
    expect(ensureRootSemanticBootstrap(NS)).toBe(0);
  });
});

describe("root semantic bootstrap", () => {
  it("a second run in the same process inserts nothing", () => {
    expect(ensureRootSemanticBootstrap(NS)).toBeGreaterThan(0);
    expect(ensureRootSemanticBootstrap(NS)).toBe(0);
  });

  it("a run after a save and a restart from the snapshot inserts nothing", () => {
    expect(ensureRootSemanticBootstrap(NS)).toBeGreaterThan(0);
    const count = getKernelMemoryLog().length;
    saveSnapshotOrThrow();
    // A restart: drop the kernel (resetKernelStateForTests also removes the state dir), put the saved snapshot back,
    // and let the next getKernel() hydrate from it.
    const stateDir = process.env.ME_STATE_DIR!;
    const saved = fs.readFileSync(path.join(stateDir, "snapshot.json"));
    resetKernelStateForTests();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "snapshot.json"), saved);
    getKernel();
    expect(getKernelMemoryLog().length).toBe(count);
    expect(ensureRootSemanticBootstrap(NS)).toBe(0);
    expect(getKernelMemoryLog().length).toBe(count);
  });
});
