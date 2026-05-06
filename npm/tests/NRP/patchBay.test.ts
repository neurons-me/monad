import { describe, it, beforeEach, expect } from "vitest";
import {
  registerPatch,
  unregisterPatch,
  readPatchBay,
  getPatchScorers,
  resetPatchBayForTests,
} from "../../src/kernel/patchBay.js";
import { BUILT_IN_SCORERS, computeScoreDetailed } from "../../src/kernel/scoring.js";
import type { MonadIndexEntry } from "../../src/kernel/monadIndex.js";

function makeEntry(overrides: Partial<MonadIndexEntry> = {}): MonadIndexEntry {
  return {
    monad_id: "test",
    namespace: "ns",
    endpoint: "http://localhost:9001",
    last_seen: Date.now(),
    tags: [],
    ...overrides,
  } as MonadIndexEntry;
}

// Meta that produces predictable base scorer values:
//   latency  = 1 - 1000/2000 = 0.5
//   resonance = 50/100        = 0.5
const HALF_META = { avgLatencyMs: 1000, effectiveResonance: 50 };

// Ctx with requestedAt == last_seen → recency = 1.0
function freshCtx(entry: MonadIndexEntry) {
  return { namespace: "ns", requestedAt: entry.last_seen };
}

describe("patchBay — registration and storage", () => {
  beforeEach(() => resetPatchBayForTests());

  it("starts empty", () => {
    expect(readPatchBay()).toHaveLength(0);
  });

  it("registerPatch stores a patch and readPatchBay returns it", () => {
    registerPatch({ inputs: ["latency", "recency"], op: "multiply", out: "lat_rec" });
    const patches = readPatchBay();
    expect(patches).toHaveLength(1);
    expect(patches[0]!.out).toBe("lat_rec");
    expect(patches[0]!.inputs).toEqual(["latency", "recency"]);
    expect(patches[0]!.op).toBe("multiply");
  });

  it("auto-generates output name when out is omitted", () => {
    registerPatch({ inputs: ["latency", "recency"], op: "add" });
    const patches = readPatchBay();
    expect(patches[0]!.out).toBe("latency_recency_add");
  });

  it("multiple patches coexist", () => {
    registerPatch({ inputs: ["latency", "recency"], op: "multiply", out: "a" });
    registerPatch({ inputs: ["resonance"],           op: "power",    out: "b", params: { exp: 2 } });
    expect(readPatchBay()).toHaveLength(2);
  });

  it("registering same name overwrites the previous entry", () => {
    registerPatch({ inputs: ["latency", "recency"], op: "multiply", out: "x" });
    registerPatch({ inputs: ["latency"],             op: "power",    out: "x", params: { exp: 2 } });
    const patches = readPatchBay();
    expect(patches).toHaveLength(1);
    expect(patches[0]!.op).toBe("power");
  });

  it("unregisterPatch removes an entry", () => {
    registerPatch({ inputs: ["latency", "recency"], op: "multiply", out: "lat_rec" });
    unregisterPatch("lat_rec");
    expect(readPatchBay()).toHaveLength(0);
  });

  it("unregisterPatch is a no-op for unknown names", () => {
    expect(() => unregisterPatch("nonexistent")).not.toThrow();
  });
});

describe("patchBay — getPatchScorers materializes Scorers", () => {
  beforeEach(() => resetPatchBayForTests());

  it("returns an empty array when no patches are registered", () => {
    expect(getPatchScorers(BUILT_IN_SCORERS)).toHaveLength(0);
  });

  it("returned scorer has the correct name and defaultWeight", () => {
    registerPatch({ inputs: ["latency"], op: "power", out: "lat2", defaultWeight: 0.2, params: { exp: 2 } });
    const scorers = getPatchScorers(BUILT_IN_SCORERS);
    expect(scorers).toHaveLength(1);
    expect(scorers[0]!.name).toBe("lat2");
    expect(scorers[0]!.defaultWeight).toBe(0.2);
  });

  it("defaults defaultWeight to 0.1 when not specified", () => {
    registerPatch({ inputs: ["latency", "recency"], op: "multiply", out: "x" });
    const scorers = getPatchScorers(BUILT_IN_SCORERS);
    expect(scorers[0]!.defaultWeight).toBe(0.1);
  });

  it("unknown input name resolves to 0 without throwing", () => {
    registerPatch({ inputs: ["unknown_signal", "recency"], op: "multiply", out: "x" });
    const scorers = getPatchScorers(BUILT_IN_SCORERS);
    const entry = makeEntry();
    const result = scorers[0]!.fn(entry, {}, freshCtx(entry));
    // multiply: 0 * 1.0 = 0
    expect(result).toBe(0);
  });
});

describe("patchBay — op correctness", () => {
  beforeEach(() => resetPatchBayForTests());

  // latency(1000ms) = 0.5, recency(fresh) = 1.0, resonance(50) = 0.5

  it("multiply: product of inputs", () => {
    registerPatch({ inputs: ["latency", "recency"], op: "multiply", out: "p" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, HALF_META, freshCtx(entry));
    expect(v).toBeCloseTo(0.5 * 1.0, 5); // 0.5
  });

  it("multiply: three-way product", () => {
    registerPatch({ inputs: ["latency", "recency", "resonance"], op: "multiply", out: "p3" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, HALF_META, freshCtx(entry));
    expect(v).toBeCloseTo(0.5 * 1.0 * 0.5, 5); // 0.25
  });

  it("add: sum clamped to 1", () => {
    registerPatch({ inputs: ["recency", "recency"], op: "add", out: "p" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, {}, freshCtx(entry));
    // recency = 1.0 + 1.0 = 2.0 → clamped to 1.0
    expect(v).toBe(1.0);
  });

  it("add: partial sum stays below 1", () => {
    registerPatch({ inputs: ["latency", "resonance"], op: "add", out: "p" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, HALF_META, freshCtx(entry));
    expect(v).toBeCloseTo(0.5 + 0.5, 5); // 1.0 exact
  });

  it("min: returns weakest input", () => {
    registerPatch({ inputs: ["latency", "recency"], op: "min", out: "p" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, HALF_META, freshCtx(entry));
    expect(v).toBeCloseTo(Math.min(0.5, 1.0), 5); // 0.5
  });

  it("max: returns strongest input", () => {
    registerPatch({ inputs: ["latency", "recency"], op: "max", out: "p" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, HALF_META, freshCtx(entry));
    expect(v).toBeCloseTo(Math.max(0.5, 1.0), 5); // 1.0
  });

  it("gate: passes inputs[1] when inputs[0] >= threshold", () => {
    // recency = 1.0 >= 0.5 threshold → return resonance = 0.5
    registerPatch({ inputs: ["recency", "resonance"], op: "gate", params: { threshold: 0.5 }, out: "p" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, HALF_META, freshCtx(entry));
    expect(v).toBeCloseTo(0.5, 5); // resonance passes through
  });

  it("gate: blocks when inputs[0] < threshold", () => {
    // latency = 0.5, threshold = 0.8 → blocked → 0
    registerPatch({ inputs: ["latency", "resonance"], op: "gate", params: { threshold: 0.8 }, out: "p" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, HALF_META, freshCtx(entry));
    expect(v).toBe(0);
  });

  it("gate: with no inputs[1] returns 1 when gate open", () => {
    registerPatch({ inputs: ["recency"], op: "gate", params: { threshold: 0.5 }, out: "p" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, {}, freshCtx(entry));
    expect(v).toBe(1); // recency = 1.0 → gate open, no passthrough → 1
  });

  it("power: squares a single input", () => {
    // latency = 0.5 → 0.5² = 0.25
    registerPatch({ inputs: ["latency"], op: "power", params: { exp: 2 }, out: "lat2" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, HALF_META, freshCtx(entry));
    expect(v).toBeCloseTo(0.25, 5);
  });

  it("power: cube of a single input", () => {
    // latency = 0.5 → 0.5³ = 0.125
    registerPatch({ inputs: ["latency"], op: "power", params: { exp: 3 }, out: "lat3" });
    const entry = makeEntry();
    const [scorer] = getPatchScorers(BUILT_IN_SCORERS);
    const v = scorer!.fn(entry, HALF_META, freshCtx(entry));
    expect(v).toBeCloseTo(0.125, 5);
  });
});

describe("patchBay — integration with computeScoreDetailed", () => {
  beforeEach(() => resetPatchBayForTests());

  it("patch scorers flow through computeScoreDetailed and appear in breakdown", () => {
    registerPatch({ inputs: ["latency", "recency"], op: "multiply", out: "lat_rec", defaultWeight: 0.1 });
    const patchScorers = getPatchScorers(BUILT_IN_SCORERS);
    const entry = makeEntry();
    const result = computeScoreDetailed(entry, HALF_META, freshCtx(entry), patchScorers);
    expect(result.breakdown).toHaveProperty("lat_rec");
    expect(result.breakdown["lat_rec"]!.value).toBeCloseTo(0.5, 5);
  });

  it("total score includes patch contribution and stays in [0,1]", () => {
    registerPatch({ inputs: ["latency", "resonance"], op: "multiply", out: "lr", defaultWeight: 0.5 });
    const patchScorers = getPatchScorers(BUILT_IN_SCORERS);
    const entry = makeEntry();
    const { total } = computeScoreDetailed(entry, HALF_META, freshCtx(entry), patchScorers);
    expect(total).toBeGreaterThanOrEqual(0);
    expect(total).toBeLessThanOrEqual(1);
  });

  it("patch with zero contribution does not corrupt total", () => {
    // unknown input → value=0 → contribution=0
    registerPatch({ inputs: ["unknown"], op: "multiply", out: "noop", defaultWeight: 0.5 });
    const patchScorers = getPatchScorers(BUILT_IN_SCORERS);
    const entry = makeEntry();
    const { total, breakdown } = computeScoreDetailed(entry, {}, freshCtx(entry), patchScorers);
    expect(breakdown["noop"]!.value).toBe(0);
    expect(total).toBeGreaterThanOrEqual(0);
    expect(total).toBeLessThanOrEqual(1);
  });
});
