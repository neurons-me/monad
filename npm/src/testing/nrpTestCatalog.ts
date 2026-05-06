/**
 * Describes one documented test group in the NRP suite.
 *
 * The catalog is exported so TypeDoc can publish the test taxonomy alongside
 * the runtime APIs. It is not used by Vitest at runtime.
 */
export type NrpTestCatalogEntry = {
  /** Test file path relative to the package root. */
  file: string;
  /** Functional area covered by the file. */
  category: "parsing" | "index" | "selection" | "scoring" | "observability" | "learning";
  /** Whether this test group protects a production invariant. */
  invariant: boolean;
  /** Short description of the behavior under test. */
  covers: string[];
};

/**
 * Public documentation catalog for `tests/NRP`.
 *
 * This lets the generated API docs explain what is covered without coupling the
 * production package to Vitest internals.
 */
export const NRP_TEST_CATALOG: NrpTestCatalogEntry[] = [
  {
    file: "tests/NRP/bridge.parse.test.ts",
    category: "parsing",
    invariant: true,
    covers: [
      "cleaker v3 `__ptr.target` parsing",
      "dot-prefixed paths such as `.mesh/monads`",
      "namespace normalization",
      "canonical bridge NRP construction",
    ],
  },
  {
    file: "tests/NRP/monadIndex.test.ts",
    category: "index",
    invariant: true,
    covers: [
      "local monad index read/write/list",
      "namespace claim discovery",
      "case-insensitive name lookup",
      "deterministic freshness ordering",
    ],
  },
  {
    file: "tests/NRP/meshSelect.test.ts",
    category: "selection",
    invariant: true,
    covers: [
      "self-exclusion",
      "staleness filtering",
      "selector matching",
      "runner-up exploration for low-margin decisions",
    ],
  },
  {
    file: "tests/NRP/scoring.test.ts",
    category: "scoring",
    invariant: true,
    covers: [
      "score normalization into `[0, 1]`",
      "determinism and invalid-number safety",
      "decayed resonance and EWMA latency learning",
      "score breakdown introspection",
      "winner/runner-up scoring integration",
    ],
  },
  {
    file: "tests/NRP/decisionLog.test.ts",
    category: "observability",
    invariant: true,
    covers: [
      "decisionId-based outcome correlation",
      "continuous reward calculation",
      "JSONL decision log output",
      "best-effort failure isolation",
    ],
  },
  {
    file: "tests/NRP/adaptiveWeights.test.ts",
    category: "learning",
    invariant: true,
    covers: [
      "global adaptive weight updates",
      "namespace-local weight attribution",
      "maturity-based global/namespace blending",
      "learning-loop integration through decision outcomes",
    ],
  },
];
