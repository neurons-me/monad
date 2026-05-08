import { parseSelectorGroups } from "../http/selfMapping.js";
import { parseNamespaceIdentityParts } from "../namespace/identity.js";
import { resolveAdaptiveWeights } from "./adaptiveWeights.js";
import { findMonadByNameAsync, findMonadsForNamespaceAsync, listMonadIndexAsync, type MonadIndexEntry } from "./monadIndex.js";
import { getPatchScorers } from "./patchBay.js";
import { BUILT_IN_SCORERS, computeScoreDetailed, readClaimMeta, type ScoreBreakdown, type Scorer } from "./scoring.js";

export const DEFAULT_STALE_MS = 300_000; // 5 min

/**
 * The second-best claimant observed during a mesh selection pass.
 *
 * Capturing this in the same O(N) scan lets the bridge log winner/runner-up
 * margin without recomputing scores.
 */
export type MeshRunnerUp = {
  entry: MonadIndexEntry;
  score: number;
  breakdown: ScoreBreakdown;
};

/**
 * Result of selecting a monad for a namespace.
 *
 * `mesh-claim` means the highest-scored eligible claimant won. `exploration`
 * means the decision margin was low and the runner-up was intentionally tried
 * to gather comparative feedback. `name-selector` means the caller bypassed
 * scoring by asking for a specific monad.
 */
export type MeshSelection = {
  entry: MonadIndexEntry;
  // "exploration": margin was below threshold and the runner-up was chosen instead of the winner.
  reason: "name-selector" | "mesh-claim" | "exploration";
  score?: number;
  breakdown?: ScoreBreakdown;
  runnerUp?: MeshRunnerUp;
};

function normalizeToken(s: string): string {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
}

function endpointHost(endpoint: string): string {
  try { return new URL(endpoint).hostname.toLowerCase(); } catch { return ""; }
}

/**
 * Tests whether a monad entry satisfies a selector constraint.
 *
 * The selector uses the same DNF grammar as self mapping:
 * `device:macbook|host:edge;tag:primary`. Empty selectors always match.
 */
export function matchesMeshSelector(entry: MonadIndexEntry, selectorRaw: string | null): boolean {
  if (!selectorRaw) return true;
  const groups = parseSelectorGroups(selectorRaw);
  if (groups.length === 0) return true;

  const tagSet = new Set<string>(
    [
      ...(entry.tags ?? []).map(normalizeToken),
      entry.type ? normalizeToken(entry.type) : "",
    ].filter(Boolean),
  );
  const hostSet = new Set<string>(
    [normalizeToken(entry.namespace), endpointHost(entry.endpoint)].filter(Boolean),
  );

  // DNF: any group fully satisfied → match
  return groups.some((group) =>
    group.every((clause) => {
      if (clause.type === "device" || clause.type === "tag") {
        return clause.values.some((v) => tagSet.has(normalizeToken(v)));
      }
      if (clause.type === "host") {
        return clause.values.some(
          (v) => hostSet.has(normalizeToken(v)) || tagSet.has(normalizeToken(v)),
        );
      }
      return false;
    }),
  );
}

// Margin below this value qualifies a decision for epsilon-greedy exploration.
const EXPLORATION_MARGIN_THRESHOLD = 0.05;
// Softmax temperature for exploration sampling: lower = more peaked (winner likely),
// higher = more uniform. Fixed at a value that gives ~40% exploration probability
// at margin=0.01 and ~10% at margin=0.05.
const SOFTMAX_TEMPERATURE = 0.1;

// Samples an index from allScored using softmax probabilities with the given temperature.
// index 0 = highest scorer (winner). index > 0 = exploration candidates.
function sampleSoftmax(allScored: { detailed: ScoreBreakdown }[], temperature: number): number {
  const maxScore = allScored[0]!.detailed.total;
  const expScores = allScored.map((s) => Math.exp((s.detailed.total - maxScore) / temperature));
  const expSum = expScores.reduce((a, b) => a + b, 0);
  let rand = Math.random();
  for (let i = 0; i < allScored.length; i++) {
    rand -= expScores[i]! / expSum;
    if (rand <= 0) return i;
  }
  return 0;
}

/**
 * Resolves the rootspace constant from a compound namespace.
 *
 * `suign.cleaker.me` → `cleaker.me`  (strip user prefix)
 * `cleaker.me`       → `cleaker.me`  (already rootspace)
 */
function rootspaceOf(namespace: string): string {
  const parts = parseNamespaceIdentityParts(namespace);
  return parts.host || namespace;
}

/**
 * Scope-chain selection for `monad[frank]` path syntax.
 *
 * Traversal order for monadId="frank" in namespace="suign.cleaker.me":
 *   1. frank claiming exact namespace  (suign.cleaker.me)
 *   2. frank claiming rootspace        (cleaker.me)
 *   3. null → 404
 *
 * Backward-compatible: absent scope_path on old entries is treated as "/".
 */
export async function selectMeshClaimantByScope(opts: {
  monadId: string;
  namespace: string;
  selfEndpoint: string;
  selfMonadId: string;
  stalenessMs?: number;
  now?: number;
}): Promise<MeshSelection | null> {
  const { monadId, namespace, selfEndpoint, selfMonadId, stalenessMs = DEFAULT_STALE_MS, now = Date.now() } = opts;

  const normSelf = selfEndpoint.replace(/\/+$/, "");
  const normalizedName = monadId.trim().toLowerCase();

  const all = await listMonadIndexAsync();
  const candidates = all.filter(
    (m) =>
      m.endpoint.replace(/\/+$/, "") !== normSelf &&
      (!selfMonadId || m.monad_id !== selfMonadId) &&
      now - m.last_seen <= stalenessMs &&
      ((m.name?.toLowerCase() === normalizedName) || m.monad_id.toLowerCase() === normalizedName),
  );

  if (candidates.length === 0) return null;

  const rootspace = rootspaceOf(namespace);
  const normalizedNs = namespace.trim().toLowerCase();
  const normalizedRoot = rootspace.trim().toLowerCase();

  function claimsNamespace(m: MonadIndexEntry, ns: string): boolean {
    if (m.namespace.trim().toLowerCase() === ns) return true;
    return (m.claimed_namespaces ?? []).some((c) => c.trim().toLowerCase() === ns);
  }

  // Fallback chain: compound namespace → rootspace → first available
  const inCompound = candidates.filter((m) => claimsNamespace(m, normalizedNs));
  const inRootspace = inCompound.length === 0 && normalizedRoot !== normalizedNs
    ? candidates.filter((m) => claimsNamespace(m, normalizedRoot))
    : [];
  const winner = (inCompound[0] ?? inRootspace[0] ?? candidates[0])!;

  return { entry: winner, reason: "name-selector" };
}

/**
 * Selects the best mesh claimant for a namespace request.
 *
 * Selection proceeds in this order:
 * 1. explicit `monadSelector` lookup, if present
 * 2. namespace claim filtering
 * 3. selector constraint filtering
 * 4. scoring via `computeScoreDetailed`
 * 5. optional epsilon-greedy exploration for low-margin decisions
 */
export async function selectMeshClaimant(opts: {
  monadSelector: string;
  namespace: string;
  selfEndpoint: string;
  selfMonadId: string;
  selectorConstraint?: string | null;
  stalenessMs?: number;
  now?: number;
  extraScorers?: Scorer[];
  // Probability [0, 1] of routing to runner-up when margin < EXPLORATION_MARGIN_THRESHOLD.
  // Default 0 (off). Use 0.1–0.2 to gather comparative data on nearly-tied candidates.
  explorationRate?: number;
}): Promise<MeshSelection | null> {
  const {
    monadSelector,
    namespace,
    selfEndpoint,
    selfMonadId,
    selectorConstraint = null,
    stalenessMs = DEFAULT_STALE_MS,
    now = Date.now(),
    extraScorers = [],
    explorationRate = 0,
  } = opts;

  const normSelf = selfEndpoint.replace(/\/+$/, "");

  if (monadSelector) {
    const named = await findMonadByNameAsync(monadSelector);
    if (named?.endpoint) return { entry: named, reason: "name-selector" };
    return null;
  }

  const claimants = (await findMonadsForNamespaceAsync(namespace)).filter(
    (m) =>
      m.endpoint.replace(/\/+$/, "") !== normSelf &&
      (!selfMonadId || m.monad_id !== selfMonadId) &&
      now - m.last_seen <= stalenessMs &&
      matchesMeshSelector(m, selectorConstraint),
  );

  if (claimants.length === 0) return null;

  // Inject one pre-blended adaptive weight object for this request.
  // This keeps the hot path at one blend per request, not per claimant.
  const adaptiveWeights = resolveAdaptiveWeights(namespace);
  const ctx = { namespace, requestedAt: now, adaptiveWeights };

  // Merge patch bay scorers (Phase 8) with caller-supplied extras.
  // Patch scorers resolve against built-ins only — patch-of-patch not yet supported.
  const patchScorers = getPatchScorers(BUILT_IN_SCORERS);
  const allExtraScorers = [...patchScorers, ...extraScorers];

  // Score all claimants and sort descending. O(N) scoring + O(N log N) sort.
  // N is typically 2–5 in a real mesh, so the sort cost is negligible.
  const allScored = claimants
    .map((m) => {
      const meta = readClaimMeta(m.monad_id, namespace);
      return { entry: m, detailed: computeScoreDetailed(m, meta, ctx, allExtraScorers) };
    })
    .sort((a, b) => {
      const d = b.detailed.total - a.detailed.total;
      return d !== 0 ? d : a.entry.monad_id.localeCompare(b.entry.monad_id);
    });

  const best = allScored[0]!;
  const second = allScored[1] ?? null;
  const margin = second ? best.detailed.total - second.detailed.total : 1;

  // Epsilon-greedy gate: only explore on fragile decisions.
  // Within the gate, softmax samples from all candidates — avoids top-2 bias
  // when 3+ claimants are present.
  if (second && explorationRate > 0 && margin < EXPLORATION_MARGIN_THRESHOLD && Math.random() < explorationRate) {
    const idx = sampleSoftmax(allScored, SOFTMAX_TEMPERATURE);
    if (idx > 0) {
      return {
        entry: allScored[idx]!.entry,
        reason: "exploration",
        score: allScored[idx]!.detailed.total,
        breakdown: allScored[idx]!.detailed,
        runnerUp: { entry: best.entry, score: best.detailed.total, breakdown: best.detailed },
      };
    }
    // softmax chose index 0 (winner) — fall through to normal return
  }

  return {
    entry: best.entry,
    reason: "mesh-claim",
    score: best.detailed.total,
    breakdown: best.detailed,
    ...(second
      ? { runnerUp: { entry: second.entry, score: second.detailed.total, breakdown: second.detailed } }
      : {}),
  };
}
