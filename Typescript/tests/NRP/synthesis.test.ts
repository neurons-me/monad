/**
 * synthesis.test.ts — Phase 10: Total Monad Synthesis algorithm
 *
 * WHAT IS THIS?
 * synthesize() reduces N parallel source responses into one coherent result.
 * It answers: "Given that several monads responded to the same request,
 * what is the canonical answer — and how confident are we?"
 *
 * Three outcomes:
 *   "public"    — quorum met, value available (Cases A and B)
 *   "closed"    — nobody responded ok=true
 *   "contested" — responses conflict, no majority reached
 *
 * WHAT WE TEST (6 groups):
 *   1. All agree (Case A)
 *   2. Majority agrees, winner in minority (Case B)
 *   3. No quorum (Case C — contested)
 *   4. Failure handling (some/all sources fail)
 *   5. Policy variants (quorumThreshold extremes)
 *   6. Value comparison edge cases (objects, null, nested keys)
 *   7. Divergence metadata (maxDelta, diffKeys)
 */

import { synthesize, DEFAULT_SYNTHESIS_POLICY, type SynthesisSource, type SynthesisPolicy } from "../../src/kernel/synthesis.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let idCounter = 0;

// Every existing test in this file predates disclosure and assumes "these are
// real, meaningful values" — that's exactly what disclosure="public" means.
// Tests exercising disclosure itself override it explicitly.
function source(overrides: Partial<SynthesisSource> & { value: unknown }): SynthesisSource {
  const id = `monad-${++idCounter}`;
  return {
    monad_id: id,
    endpoint: `http://${id}:8282`,
    score: 0.9,
    breakdown: { total: 0.9, recency: 0.9, resonance: 0, latency: 0, scorers: {} } as any,
    ok: true,
    disclosure: "public",
    latencyMs: 10,
    ...overrides,
  };
}

function policy(overrides: Partial<SynthesisPolicy>): SynthesisPolicy {
  return { ...DEFAULT_SYNTHESIS_POLICY, ...overrides };
}

// Reset idCounter before each test for deterministic monad_ids
beforeEach(() => { idCounter = 0; });

// ── 1. All agree — Case A ────────────────────────────────────────────────────

describe("synthesize — all agree (Case A)", () => {
  it("3 sources return identical value → quorum, disclosure=public", () => {
    const sources = [
      source({ value: "hello", score: 0.9 }),
      source({ value: "hello", score: 0.8 }),
      source({ value: "hello", score: 0.7 }),
    ];
    const result = synthesize(sources);
    expect(result.disclosure).toBe("public");
    expect(result.value).toBe("hello");
    expect(result.ok).toBe(true);
    expect(result.quorum.met).toBe(true);
    expect(result.quorum.agreeCount).toBe(3);
    expect(result.quorum.totalCount).toBe(3);
    expect(result.divergence.strategy).toBe("quorum");
    expect(result.policy).toBe("strict-quorum");
  });

  it("2 of 3 agree and winner is in majority → Case A, value from winner", () => {
    const sources = [
      source({ value: 42, score: 0.95 }),  // winner, in majority
      source({ value: 42, score: 0.80 }),  // agrees with winner
      source({ value: 99, score: 0.60 }),  // minority
    ];
    const result = synthesize(sources);
    expect(result.disclosure).toBe("public");
    expect(result.value).toBe(42);
    expect(result.divergence.strategy).toBe("quorum");
  });

  it("single source → quorum met (1/1 ≥ 0.5), value returned", () => {
    const result = synthesize([source({ value: "solo" })]);
    expect(result.disclosure).toBe("public");
    expect(result.value).toBe("solo");
    expect(result.quorum.met).toBe(true);
  });
});

// ── 2. Majority agrees, winner disagrees — Case B ────────────────────────────

describe("synthesize — winner in minority (Case B)", () => {
  it("2 of 3 agree but winner disagrees → highest-scored of majority used", () => {
    const sources = [
      source({ value: "wrong", score: 0.99 }),  // winner, minority
      source({ value: "right", score: 0.80 }),  // majority, highest-scored
      source({ value: "right", score: 0.70 }),  // majority
    ];
    const result = synthesize(sources);
    expect(result.disclosure).toBe("public");
    expect(result.value).toBe("right");
    expect(result.divergence.strategy).toBe("highest-scored");
    expect(result.ok).toBe(true);
  });
});

// ── 3. No quorum — Case C ────────────────────────────────────────────────────

describe("synthesize — contested (Case C)", () => {
  it("all 3 sources return different values → contested, value=null", () => {
    const sources = [
      source({ value: "a", score: 0.9 }),
      source({ value: "b", score: 0.8 }),
      source({ value: "c", score: 0.7 }),
    ];
    const result = synthesize(sources);
    expect(result.disclosure).toBe("contested");
    expect(result.value).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.quorum.met).toBe(false);
    expect(result.divergence.strategy).toBe("contested");
  });

  it("sources field still contains all sources when contested", () => {
    const sources = [
      source({ value: "a" }),
      source({ value: "b" }),
      source({ value: "c" }),
    ];
    const result = synthesize(sources);
    expect(result.sources).toHaveLength(3);
  });
});

// ── 4. Failure handling ──────────────────────────────────────────────────────

describe("synthesize — failure handling", () => {
  it("failed source (ok=false) excluded from agreement count", () => {
    const sources = [
      source({ value: "good", score: 0.9 }),
      source({ value: "good", score: 0.8 }),
      source({ value: null, ok: false, score: 0.7 }),
    ];
    const result = synthesize(sources);
    expect(result.disclosure).toBe("public");
    expect(result.value).toBe("good");
    expect(result.quorum.totalCount).toBe(2);  // only ok=true counted
    expect(result.quorum.agreeCount).toBe(2);
  });

  it("all sources fail → ok=false, disclosure=closed", () => {
    const sources = [
      source({ value: null, ok: false }),
      source({ value: null, ok: false }),
    ];
    const result = synthesize(sources);
    expect(result.ok).toBe(false);
    expect(result.disclosure).toBe("closed");
    expect(result.value).toBeNull();
  });

  it("empty sources array → ok=false, disclosure=closed", () => {
    const result = synthesize([]);
    expect(result.ok).toBe(false);
    expect(result.disclosure).toBe("closed");
    expect(result.quorum.totalCount).toBe(0);
  });

  it("failed sources appear in result.sources for observability", () => {
    const sources = [
      source({ value: "ok", score: 0.9 }),
      source({ value: null, ok: false, score: 0.5 }),
    ];
    const result = synthesize(sources);
    expect(result.sources).toHaveLength(2);
    expect(result.sources.some((s) => !s.ok)).toBe(true);
  });
});

// ── 5. Policy variants ───────────────────────────────────────────────────────

describe("synthesize — policy variants", () => {
  it("quorumThreshold=1.0 (unanimous): 2 of 3 agree → contested", () => {
    const sources = [
      source({ value: "a", score: 0.9 }),
      source({ value: "a", score: 0.8 }),
      source({ value: "b", score: 0.7 }),
    ];
    const result = synthesize(sources, policy({ quorumThreshold: 1.0 }));
    expect(result.disclosure).toBe("contested");
    expect(result.quorum.met).toBe(false);
  });

  it("quorumThreshold=0 (any response): single source always reaches quorum", () => {
    const result = synthesize([source({ value: "x" })], policy({ quorumThreshold: 0 }));
    expect(result.disclosure).toBe("public");
    expect(result.quorum.met).toBe(true);
  });

  it("quorumThreshold=0.3: 1 of 3 agreeing is enough", () => {
    const sources = [
      source({ value: "a", score: 0.9 }),
      source({ value: "b", score: 0.8 }),
      source({ value: "c", score: 0.7 }),
    ];
    // largest group has 1 member. 1 > 3 * 0.3 = 1 > 0.9 = true → public.
    // Using 0.3 (not 1/3) to avoid floating-point exact-boundary ambiguity:
    // 3 * (1/3) === 1.0 in V8, so 1 > 1 = false. 0.3 stays unambiguous.
    const result = synthesize(sources, policy({ quorumThreshold: 0.3 }));
    expect(result.disclosure).toBe("public");
    expect(result.quorum.met).toBe(true);
  });

  it("first-ok policy name is preserved in result", () => {
    const sources = [source({ value: "v" })];
    const result = synthesize(sources, policy({ name: "first-ok" }));
    expect(result.policy).toBe("first-ok");
  });
});

// ── 6. Value comparison edge cases ───────────────────────────────────────────

describe("synthesize — value comparison", () => {
  it("objects with different key order are considered equal", () => {
    const sources = [
      source({ value: { b: 2, a: 1 }, score: 0.9 }),
      source({ value: { a: 1, b: 2 }, score: 0.8 }),
    ];
    const result = synthesize(sources);
    expect(result.disclosure).toBe("public");
    expect(result.quorum.agreeCount).toBe(2);
  });

  it("nested objects with different key order are considered equal", () => {
    const sources = [
      source({ value: { x: { y: 1, z: 2 } }, score: 0.9 }),
      source({ value: { x: { z: 2, y: 1 } }, score: 0.8 }),
    ];
    const result = synthesize(sources);
    expect(result.disclosure).toBe("public");
    expect(result.quorum.agreeCount).toBe(2);
  });

  it("null !== undefined: do not agree → contested (1/2 is not majority)", () => {
    const sources = [
      source({ value: null, score: 0.9 }),
      source({ value: undefined, score: 0.8 }),
    ];
    // Each value is its own group of size 1. 1 > 2*0.5 = 1 > 1 = false → contested.
    // Two monads with different answers is the canonical contested scenario.
    const result = synthesize(sources);
    expect(result.disclosure).toBe("contested");
    expect(result.value).toBeNull();
    expect(result.quorum.met).toBe(false);
    expect(result.quorum.agreeCount).toBe(1);
  });

  it("null !== empty string: do not agree", () => {
    const sources = [
      source({ value: null, score: 0.9 }),
      source({ value: "", score: 0.8 }),
    ];
    const result = synthesize(sources);
    expect(result.quorum.agreeCount).toBe(1);
  });

  it("identical primitive values agree regardless of source count", () => {
    const sources = Array.from({ length: 5 }, (_, i) =>
      source({ value: 100, score: 0.9 - i * 0.05 }),
    );
    const result = synthesize(sources);
    expect(result.quorum.agreeCount).toBe(5);
    expect(result.value).toBe(100);
  });
});

// ── 7. Divergence metadata ───────────────────────────────────────────────────

describe("synthesize — divergence metadata", () => {
  it("numeric values: maxDelta computed correctly", () => {
    const sources = [
      source({ value: 10, score: 0.9 }),
      source({ value: 10, score: 0.8 }),  // agrees with winner → quorum
      source({ value: 15, score: 0.7 }),  // outlier but quorum already met
    ];
    const result = synthesize(sources, policy({ quorumThreshold: 0.5 }));
    expect(result.disclosure).toBe("public");
    expect(result.divergence.maxDelta).toBe(5);
  });

  it("object values: diffKeys lists keys where sources disagree (even when contested)", () => {
    const sources = [
      source({ value: { name: "ana", age: 30 }, score: 0.9 }),
      source({ value: { name: "ana", age: 31 }, score: 0.8 }),
    ];
    // 2 sources disagree on age → each forms its own group of size 1.
    // 1 > 2*0.5 = false → contested. diffKeys still populated for observability.
    const result = synthesize(sources, policy({ quorumThreshold: 0.5 }));
    expect(result.disclosure).toBe("contested");
    expect(result.divergence.diffKeys).toContain("age");
    expect(result.divergence.diffKeys).not.toContain("name");
  });

  it("sourceCount and agreeCount are always present", () => {
    const sources = [
      source({ value: "x", score: 0.9 }),
      source({ value: "y", score: 0.8 }),
    ];
    const result = synthesize(sources);
    expect(typeof result.divergence.sourceCount).toBe("number");
    expect(typeof result.divergence.agreeCount).toBe("number");
  });

  it("synthesizedAt is a recent timestamp", () => {
    const before = Date.now();
    const result = synthesize([source({ value: "v" })]);
    const after = Date.now();
    expect(result.synthesizedAt).toBeGreaterThanOrEqual(before);
    expect(result.synthesizedAt).toBeLessThanOrEqual(after);
  });
});

// ── 8. Disclosure — per-source eligibility ───────────────────────────────────
//
// A source can be ok=true (the transport succeeded) while still having
// nothing to contribute: NRP Section 6 says a "closed" response is 200 with
// value=null. Before disclosure existed on SynthesisSource, that null could
// get silently counted as a value every other closed source "agreed" with —
// a false quorum on nothing. These tests pin the fix.

describe("synthesize — disclosure eligibility", () => {
  it("all sources closed → disclosure=closed, not contested (this is absence, not disagreement)", () => {
    const sources = [
      source({ value: null, disclosure: "closed" }),
      source({ value: null, disclosure: "closed" }),
      source({ value: null, disclosure: "closed" }),
    ];
    const result = synthesize(sources);
    expect(result.disclosure).toBe("closed");
    expect(result.ok).toBe(false);
    expect(result.value).toBeNull();
  });

  it("public sources disagreeing → contested (unchanged from Case C)", () => {
    const sources = [
      source({ value: "a", disclosure: "public", score: 0.9 }),
      source({ value: "b", disclosure: "public", score: 0.8 }),
      source({ value: "c", disclosure: "public", score: 0.7 }),
    ];
    const result = synthesize(sources);
    expect(result.disclosure).toBe("contested");
    expect(result.value).toBeNull();
  });

  it("closed + public does not form a false quorum on null", () => {
    // Before the fix: 2 closed sources both had value=null, which formed a
    // majority group of 2 against the 1 public source — a false "public"
    // consensus that the value IS null, when really 2 sources just had
    // nothing to say. With disclosure filtering, only the 1 public source is
    // eligible, and it wins on its own.
    const sources = [
      source({ value: null, disclosure: "closed", score: 0.95 }),
      source({ value: null, disclosure: "closed", score: 0.90 }),
      source({ value: "real-value", disclosure: "public", score: 0.50 }),
    ];
    const result = synthesize(sources, policy({ quorumThreshold: 0.5 }));
    expect(result.disclosure).toBe("public");
    expect(result.value).toBe("real-value");
    expect(result.quorum.totalCount).toBe(1); // only the public source counts
  });

  it("closed sources still appear in result.sources for audit", () => {
    const sources = [
      source({ value: "real-value", disclosure: "public" }),
      source({ value: null, disclosure: "closed" }),
    ];
    const result = synthesize(sources);
    expect(result.sources).toHaveLength(2);
    expect(result.sources.some((s) => s.disclosure === "closed")).toBe(true);
  });

  it("opened sources are value-eligible, same as public", () => {
    const sources = [
      source({ value: "secret-shared", disclosure: "opened", score: 0.9 }),
      source({ value: "secret-shared", disclosure: "opened", score: 0.8 }),
    ];
    const result = synthesize(sources);
    expect(result.disclosure).toBe("opened");
    expect(result.value).toBe("secret-shared");
  });

  it("mixed public/opened quorum preserves the chosen source's disclosure", () => {
    const sources = [
      source({ value: "shared", disclosure: "opened", score: 0.9 }),
      source({ value: "shared", disclosure: "public", score: 0.8 }),
    ];
    const result = synthesize(sources);
    expect(result.disclosure).toBe("opened");
    expect(result.value).toBe("shared");
  });

  it("a source's own disclosure='contested' is excluded from quorum, same as closed", () => {
    const sources = [
      source({ value: null, disclosure: "contested" }),
      source({ value: "real-value", disclosure: "public" }),
    ];
    const result = synthesize(sources);
    expect(result.disclosure).toBe("public");
    expect(result.value).toBe("real-value");
    expect(result.quorum.totalCount).toBe(1);
  });

  it("closed source with ok=false is excluded before disclosure filtering even runs", () => {
    const sources = [
      source({ value: null, ok: false, disclosure: "closed" }),
      source({ value: "real-value", disclosure: "public" }),
    ];
    const result = synthesize(sources);
    expect(result.disclosure).toBe("public");
    expect(result.value).toBe("real-value");
  });
});
