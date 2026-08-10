/**
 * Phase 10 — Total Monad Synthesis
 *
 * Types for multi-source mesh synthesis. A synthesis takes N parallel responses
 * from qualified claimants for a namespace/path request and reduces them to one
 * coherent DisclosureEnvelope with quorum, divergence, and provenance metadata.
 *
 * Implementation lives in synthesize() — added in Phase 10 Step 4.
 */

import type { ScoreBreakdown } from "./scoring.js";
import type { DisclosureContent } from "../http/disclosure.js";

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/**
 * The result of forwarding a single request to one mesh claimant.
 *
 * `ok` is false when the forward failed (network error, timeout, non-2xx).
 * Failed sources are included in `SynthesisResult.sources` for observability
 * but excluded from value agreement computation.
 */
export type SynthesisSource = {
  monad_id: string;
  monad_name?: string | null;
  endpoint: string;
  score: number;
  breakdown: ScoreBreakdown;
  /** Raw value returned by this monad. null when ok=false. */
  value: unknown;
  ok: boolean;
  latencyMs: number;
  /**
   * The NRP disclosure this source reported for its own response (NRP Section 6).
   * Only "public"/"opened" sources are eligible to participate in value quorum —
   * a "closed" source responded successfully (ok=true) but its value is null by
   * NRP contract, and must not be silently counted as agreeing with other null
   * or matching values. "contested" here means the source itself couldn't settle
   * on a value (rare at the single-source level, but excluded from quorum for
   * the same reason).
   */
  disclosure: DisclosureContent;
};

// ---------------------------------------------------------------------------
// Divergence
// ---------------------------------------------------------------------------

/**
 * How the responding sources compare on the synthesized value.
 *
 * - `quorum`:         majority agreed; value comes from the winner's group.
 * - `highest-scored`: quorum met but winner is NOT in majority group;
 *                     value taken from highest-scored member of majority.
 * - `contested`:      no majority; value is null, all sources exposed.
 */
export type DivergenceStrategy = "quorum" | "highest-scored" | "contested";

export type SynthesisDivergence = {
  strategy: DivergenceStrategy;
  /** Max absolute delta between numeric values across responding sources. */
  maxDelta?: number;
  /** Object keys where not all responding sources agreed. */
  diffKeys?: string[];
  sourceCount: number;
  agreeCount: number;
};

// ---------------------------------------------------------------------------
// Quorum verdict
// ---------------------------------------------------------------------------

export type SynthesisQuorum = {
  /** Fraction threshold required for agreement (0–1). */
  threshold: number;
  met: boolean;
  agreeCount: number;
  totalCount: number;
};

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * A named synthesis policy.
 *
 * Built-in: `"strict-quorum"` (deep equality, minRelativeScore=0.8,
 * quorumThreshold=0.5, maxCandidates=3).
 *
 * Custom policies can be registered and passed to synthesize() directly.
 */
export type SynthesisPolicyName = "strict-quorum" | "highest-scored" | "first-ok" | (string & {});

export type SynthesisPolicy = {
  name: SynthesisPolicyName;
  /**
   * Returns true when two values should be considered equal under this policy.
   *
   * Default: deep equality via canonical JSON (keys sorted).
   * Custom policies may allow numeric tolerance, partial match, etc.
   */
  valuesAgree: (a: unknown, b: unknown) => boolean;
  /**
   * A candidate must score >= winner.score * minRelativeScore to be included.
   * Range [0, 1]. 0 = all candidates included. 1 = only exact-score matches.
   */
  minRelativeScore: number;
  /**
   * Fraction of responding sources that must agree for quorum to be met.
   * Range (0, 1]. 0.5 = simple majority. 1.0 = unanimous.
   */
  quorumThreshold: number;
  /**
   * Maximum number of claimants to query in parallel.
   * Latency cost = max(individual latencies), so keep this ≤ 3 for
   * latency-sensitive paths.
   */
  maxCandidates: number;
};

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * The output of a synthesis pass.
 *
 * `disclosure` follows the NRP contract:
 * - `"public"`:    quorum met, public value available
 * - `"opened"`:    quorum met, value was opened by valid key material
 * - `"closed"`:    all sources failed / nothing responded
 * - `"contested"`: sources responded but could not reach quorum
 *
 * When `disclosure` is `"contested"`, `value` is null and all sources
 * are exposed in `sources` so the caller can log, audit, or retry.
 */
export type SynthesisResult = {
  ok: boolean;
  value: unknown | null;
  disclosure: "public" | "opened" | "closed" | "contested";
  sources: SynthesisSource[];
  quorum: SynthesisQuorum;
  divergence: SynthesisDivergence;
  synthesizedAt: number;
  policy: SynthesisPolicyName;
};

// ---------------------------------------------------------------------------
// Default policy (exported for tests and meshSelectMulti)
// ---------------------------------------------------------------------------

/**
 * Canonical JSON serialization used by the default valuesAgree check.
 * Keys are sorted recursively so nested objects with different key order
 * are still considered equal: { a: { y: 1, x: 2 } } === { a: { x: 2, y: 1 } }.
 */
function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, val]) => JSON.stringify(k) + ":" + canonicalJson(val));
    return "{" + entries.join(",") + "}";
  }
  return JSON.stringify(v);
}

function defaultValuesAgree(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return canonicalJson(a) === canonicalJson(b);
}

export const DEFAULT_SYNTHESIS_POLICY: SynthesisPolicy = {
  name: "strict-quorum",
  valuesAgree: defaultValuesAgree,
  minRelativeScore: 0.8,
  quorumThreshold: 0.5,
  maxCandidates: 3,
};

/**
 * Builds the active synthesis policy by reading env overrides.
 *
 * Environment variables (all optional):
 *   MONAD_SYNTHESIS_MAX_CANDIDATES     — integer, default 3
 *   MONAD_SYNTHESIS_QUORUM_THRESHOLD   — float 0–1, default 0.5
 *   MONAD_SYNTHESIS_MIN_RELATIVE_SCORE — float 0–1, default 0.8
 */
function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getDefaultSynthesisPolicy(): SynthesisPolicy {
  const maxCandidates = Math.max(
    1,
    envInt("MONAD_SYNTHESIS_MAX_CANDIDATES", DEFAULT_SYNTHESIS_POLICY.maxCandidates),
  );
  const quorumThreshold = Math.min(
    1,
    Math.max(0, envFloat("MONAD_SYNTHESIS_QUORUM_THRESHOLD", DEFAULT_SYNTHESIS_POLICY.quorumThreshold)),
  );
  const minRelativeScore = Math.min(
    1,
    Math.max(0, envFloat("MONAD_SYNTHESIS_MIN_RELATIVE_SCORE", DEFAULT_SYNTHESIS_POLICY.minRelativeScore)),
  );

  return {
    ...DEFAULT_SYNTHESIS_POLICY,
    maxCandidates,
    quorumThreshold,
    minRelativeScore,
  };
}

// ---------------------------------------------------------------------------
// synthesize() — Phase 10 core algorithm
// ---------------------------------------------------------------------------

/**
 * Reduces N parallel source responses into one coherent SynthesisResult.
 *
 * Algorithm:
 *   1. Filter to responding sources (ok=true).
 *   2. If none respond → { ok:false, disclosure:"closed" }.
 *   2b. Filter to value-eligible sources (disclosure="public"|"opened"). A
 *       source that itself disclosed "closed" answered successfully but its
 *       value is null by NRP contract — it must not count toward agreement.
 *       If none are value-eligible → { ok:false, disclosure:"closed" }, same
 *       as step 2 (no usable value signal at all, not disagreement).
 *   3. Sort value-eligible sources by score descending; winner = [0].
 *   4. Group by policy.valuesAgree() — find the largest agreement group.
 *   5. Case A: quorum met AND winner is in majority group
 *              → value from winner, disclosure=winner.disclosure, strategy="quorum"
 *      Case B: quorum met AND winner is NOT in majority group
 *              → value from highest-scored member of majority group,
 *                disclosure=majorityWinner.disclosure, strategy="highest-scored"
 *      Case C: no quorum
 *              → value=null, disclosure="contested", strategy="contested"
 *   6. Compute divergence metadata (maxDelta for numbers, diffKeys for objects)
 *      over value-eligible sources only.
 *   7. Return SynthesisResult. `sources` always contains the full original
 *      list (including closed/failed) for audit.
 */
export function synthesize(
  sources: SynthesisSource[],
  policy: SynthesisPolicy = DEFAULT_SYNTHESIS_POLICY,
): SynthesisResult {
  const synthesizedAt = Date.now();

  // Step 1 — filter to responding sources (transport succeeded)
  const responding = sources.filter((s) => s.ok);

  // Step 2 — nothing responded at all
  if (responding.length === 0) {
    return {
      ok: false,
      value: null,
      disclosure: "closed",
      sources,
      quorum: { threshold: policy.quorumThreshold, met: false, agreeCount: 0, totalCount: 0 },
      divergence: { strategy: "contested", sourceCount: sources.length, agreeCount: 0 },
      synthesizedAt,
      policy: policy.name,
    };
  }

  // Step 2b — responding, but none are value-eligible. A source that answered
  // with disclosure="closed" (or "contested") has value=null by NRP contract —
  // that null must never be treated as a value the source is knowingly agreeing
  // on. Distinct from Step 2: this is disclosure state, not disagreement, so it
  // must not surface as "contested" (which implies sources shared values that
  // conflicted).
  const valueEligible = responding.filter((s) => s.disclosure === "public" || s.disclosure === "opened");
  if (valueEligible.length === 0) {
    return {
      ok: false,
      value: null,
      disclosure: "closed",
      sources,
      quorum: { threshold: policy.quorumThreshold, met: false, agreeCount: 0, totalCount: 0 },
      divergence: { strategy: "contested", sourceCount: responding.length, agreeCount: 0 },
      synthesizedAt,
      policy: policy.name,
    };
  }

  // Step 3 — sort value-eligible sources by score descending, winner first
  const sorted = [...valueEligible].sort((a, b) => {
    const d = b.score - a.score;
    return d !== 0 ? d : a.monad_id.localeCompare(b.monad_id);
  });
  const winner = sorted[0]!;

  // Step 4 — build agreement groups
  // Each group is a cluster of sources whose values are considered equal
  // under policy.valuesAgree(). We use the first member as the representative.
  const groups: Array<{ representative: SynthesisSource; members: SynthesisSource[] }> = [];

  for (const source of sorted) {
    const existing = groups.find((g) => policy.valuesAgree(g.representative.value, source.value));
    if (existing) {
      existing.members.push(source);
    } else {
      groups.push({ representative: source, members: [source] });
    }
  }

  // Largest group by member count; tie-break by highest-scored representative
  const largestGroup = groups.reduce((best, g) => {
    if (g.members.length > best.members.length) return g;
    if (g.members.length === best.members.length && g.representative.score > best.representative.score) return g;
    return best;
  });

  // Step 5 — quorum verdict
  //
  // Three regimes to avoid float-comparison traps:
  //   threshold <= 0  → any single response qualifies (test/debug mode)
  //   threshold >= 1  → unanimous: every responding source must agree
  //   otherwise       → strict majority: agreeCount > totalCount * threshold
  //                     (NOT >=, so 1/2 is contested, not public)
  const agreeCount = largestGroup.members.length;
  const totalCount = valueEligible.length;
  const quorumMet =
    totalCount > 0 &&
    (policy.quorumThreshold <= 0
      ? true
      : policy.quorumThreshold >= 1
      ? agreeCount === totalCount
      : agreeCount > totalCount * policy.quorumThreshold);

  let value: unknown;
  let disclosure: SynthesisResult["disclosure"];
  let strategy: DivergenceStrategy;

  if (quorumMet) {
    const winnerInMajority = largestGroup.members.some((s) => s.monad_id === winner.monad_id);
    if (winnerInMajority) {
      // Case A: winner agrees with majority — trust the winner
      value = winner.value;
      disclosure = winner.disclosure;
      strategy = "quorum";
    } else {
      // Case B: winner disagrees with majority — defer to majority, pick highest scorer within it
      const majorityWinner = largestGroup.members.sort((a, b) => b.score - a.score)[0]!;
      value = majorityWinner.value;
      disclosure = majorityWinner.disclosure;
      strategy = "highest-scored";
    }
  } else {
    // Case C: no quorum — contested
    value = null;
    disclosure = "contested";
    strategy = "contested";
  }

  // Step 6 — divergence metadata
  const divergence = computeDivergence(valueEligible, strategy, agreeCount);

  return {
    ok: quorumMet,
    value,
    disclosure,
    sources,
    quorum: { threshold: policy.quorumThreshold, met: quorumMet, agreeCount, totalCount },
    divergence,
    synthesizedAt,
    policy: policy.name,
  };
}

// ---------------------------------------------------------------------------
// Divergence helpers
// ---------------------------------------------------------------------------

function computeDivergence(
  responding: SynthesisSource[],
  strategy: DivergenceStrategy,
  agreeCount: number,
): SynthesisDivergence {
  const base: SynthesisDivergence = {
    strategy,
    sourceCount: responding.length,
    agreeCount,
  };

  if (responding.length < 2) return base;

  const firstValue = responding[0]!.value;

  // Numeric values: compute max absolute delta
  if (typeof firstValue === "number") {
    const nums = responding.map((s) => s.value).filter((v): v is number => typeof v === "number");
    if (nums.length >= 2) {
      const max = Math.max(...nums);
      const min = Math.min(...nums);
      return { ...base, maxDelta: max - min };
    }
    return base;
  }

  // Object values: collect keys where not all sources agree
  if (firstValue !== null && typeof firstValue === "object" && !Array.isArray(firstValue)) {
    const allKeys = new Set<string>();
    for (const s of responding) {
      if (s.value !== null && typeof s.value === "object" && !Array.isArray(s.value)) {
        for (const k of Object.keys(s.value as object)) allKeys.add(k);
      }
    }
    const diffKeys: string[] = [];
    for (const key of allKeys) {
      const vals = responding.map((s) => {
        const v = s.value as Record<string, unknown> | null;
        return v?.[key];
      });
      const first = vals[0];
      if (vals.some((v) => canonicalJson(v) !== canonicalJson(first))) {
        diffKeys.push(key);
      }
    }
    if (diffKeys.length > 0) return { ...base, diffKeys };
  }

  return base;
}
