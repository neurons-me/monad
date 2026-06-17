/**
 * Phase 10 — Total Monad Synthesis
 * meshSelectMulti.ts
 *
 * Multi-candidate mesh selection. Returns a ranked list of qualified claimants
 * instead of a single winner, enabling Phase 10 synthesis in bridgeHandler.
 *
 * Key difference from selectMeshClaimant:
 * - Returns top-N candidates, not top-1.
 * - explorationRate is intentionally absent. Epsilon-greedy exploration is a
 *   single-winner learning strategy ("try runner-up, observe outcome"). In
 *   synthesis mode the system queries all candidates in parallel and compares
 *   results directly — no deferred observation needed.
 * - Candidates are filtered by minRelativeScore so low-confidence claimants
 *   don't dilute quorum.
 */

import { findMonadsForNamespaceAsync, type MonadIndexEntry } from "./monadIndex.js";
import { matchesMeshSelector, scoreCandidates, DEFAULT_STALE_MS } from "./meshSelect.js";
import type { Scorer, ScoreBreakdown } from "./scoring.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A scored candidate returned by selectMeshClaimants.
 */
export type ScoredCandidate = {
  entry: MonadIndexEntry;
  score: number;
  breakdown: ScoreBreakdown;
};

/**
 * Result of a multi-candidate selection pass.
 *
 * `candidates` is sorted descending by score. The first entry is the winner
 * that would have been chosen by selectMeshClaimant under the same conditions.
 *
 * An empty `candidates` array means no qualified claimants were found —
 * callers should treat this as a 503 / no-mesh-match condition.
 */
export type MeshMultiSelection = {
  candidates: ScoredCandidate[];
  namespace: string;
  selectedAt: number;
};

/**
 * Options for selectMeshClaimants.
 *
 * Mirrors selectMeshClaimant's opts minus explorationRate (not applicable
 * in multi-candidate mode — see module JSDoc).
 */
export type SelectMeshClaimantsOpts = {
  namespace: string;
  selfEndpoint: string;
  selfMonadId: string;
  selectorConstraint?: string | null;
  stalenessMs?: number;
  now?: number;
  extraScorers?: Scorer[];
  /**
   * Maximum number of candidates to return.
   * Filtered list is still sorted by score; caller receives top-N.
   * Minimum 1. Default 3.
   */
  maxCandidates?: number;
  /**
   * Candidates scoring below `winner.score * minRelativeScore` are excluded.
   * Range [0, 1].
   * - 0: include all candidates regardless of score gap.
   * - 1: include only candidates with score exactly equal to the winner.
   * Default 0.8 (bottom 20% filtered out).
   */
  minRelativeScore?: number;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Selects up to maxCandidates qualified mesh claimants for a namespace request,
 * ranked by score descending.
 *
 * Returns an empty candidates array (not null) when no eligible claimants exist
 * so callers can distinguish "no mesh" from an error.
 */
export async function selectMeshClaimants(
  opts: SelectMeshClaimantsOpts,
): Promise<MeshMultiSelection> {
  const {
    namespace,
    selfEndpoint,
    selfMonadId,
    selectorConstraint = null,
    stalenessMs = DEFAULT_STALE_MS,
    now = Date.now(),
    extraScorers = [],
    maxCandidates = 3,
    minRelativeScore = 0.8,
  } = opts;

  const normSelf = selfEndpoint.replace(/\/+$/, "");

  // Step 1 — structural filter (same as selectMeshClaimant)
  const claimants = (await findMonadsForNamespaceAsync(namespace)).filter(
    (m) =>
      m.endpoint.replace(/\/+$/, "") !== normSelf &&
      (!selfMonadId || m.monad_id !== selfMonadId) &&
      now - m.last_seen <= stalenessMs &&
      matchesMeshSelector(m, selectorConstraint),
  );

  if (claimants.length === 0) {
    return { candidates: [], namespace, selectedAt: now };
  }

  // Step 2 — score via shared pipeline (adaptive weights + patchBay + extras)
  // explorationRate=0 is implicit: we do not apply epsilon-greedy here.
  const allScored = await scoreCandidates(claimants, namespace, now, extraScorers);

  // Step 3 — filter by relative score threshold
  const winnerScore = allScored[0]!.detailed.total;
  const scoreFloor = winnerScore * Math.max(0, Math.min(1, minRelativeScore));

  const qualified = allScored
    .filter((s) => s.detailed.total >= scoreFloor)
    .slice(0, Math.max(1, maxCandidates))
    .map(
      (s): ScoredCandidate => ({
        entry: s.entry,
        score: s.detailed.total,
        breakdown: s.detailed,
      }),
    );

  return { candidates: qualified, namespace, selectedAt: now };
}
