import fs from "fs";
import { getWeightReport, updateAdaptiveWeights } from "./adaptiveWeights.js";
import type { ScorerBreakdown } from "./scoring.js";

/**
 * One correlated scoring decision, suitable for JSONL logging and offline
 * analysis.
 *
 * `decisionId` is the primary correlation key and is unique per forwarded
 * request. `reward` is continuous: fast success approaches `1.0`, slow
 * success approaches `0.7`, and failure is `-0.7`.
 */
export type DecisionEntry = {
  decisionId: string;
  timestamp: number;
  namespace: string;
  monadId: string;
  score: number;
  margin: number;
  breakdown: Record<string, ScorerBreakdown>;
  runnerUp?: { monad_id: string; score: number };
  outcome?: "success" | "failure";
  latencyMs?: number;
  // Continuous reward: fast success → 1.0, slow success → 0.7, failure → -0.7.
  // Uses a configurable quality/latency split; default quality weight is 0.7.
  reward?: number;
};

const pending = new Map<string, DecisionEntry>();

/**
 * Stores a decision snapshot until the bridge knows the outcome.
 *
 * This is intentionally in-memory and best-effort. Durable output happens only
 * after `correlateOutcome`, when success/failure and latency are known.
 */
export function recordDecision(
  entry: Omit<DecisionEntry, "outcome" | "latencyMs" | "reward">,
): void {
  pending.set(entry.decisionId, entry as DecisionEntry);
}

/**
 * Closes a pending decision with its actual request outcome.
 *
 * When `MONAD_DECISION_LOG` is set, the completed decision is appended as one
 * JSON object per line. Missing decision IDs are ignored.
 */
export function correlateOutcome(
  decisionId: string,
  latencyMs: number,
  ok: boolean,
): void {
  const entry = pending.get(decisionId);
  if (!entry) return;
  pending.delete(decisionId);

  // Two-signal reward: quality (success/failure) weighted 70%, latency 30%.
  // Failures always penalize (-0.7 at default mix), avoiding the trap of
  // optimizing for speed while tolerating correctness failures.
  const qualityWeight = parseFloat(process.env.MONAD_LEARNING_QUALITY_WEIGHT ?? "0.7");
  const rewardQuality = ok ? 1.0 : -1.0;
  const rewardLatency = ok ? Math.max(0, 1 - latencyMs / 5_000) : 0;
  const reward = qualityWeight * rewardQuality + (1 - qualityWeight) * rewardLatency;

  appendToLog({ ...entry, outcome: ok ? "success" : "failure", latencyMs, reward });

  // Phase 7: close the learning loop — update globally learned scorer weights.
  if (Object.keys(entry.breakdown).length > 0) {
    updateAdaptiveWeights(reward, entry.breakdown, { namespace: entry.namespace });

    if (process.env.MONAD_DEBUG_WEIGHTS === "1") {
      const report = getWeightReport();
      const parts = Object.entries(report.current)
        .map(([k, v]) => {
          const d = report.delta[k] ?? 0;
          return `${k}: ${v.toFixed(3)} (Δ${d >= 0 ? "+" : ""}${d.toFixed(3)})`;
        })
        .join(", ");
      console.log(`[weights] ${parts} — updates: ${report.updateCount} reward: ${reward.toFixed(3)}`);
    }
  }
}

function appendToLog(entry: DecisionEntry): void {
  const logPath = process.env.MONAD_DECISION_LOG;
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch {
    // best-effort: never crash the server on log write failure
  }
}

export function resetDecisionLogForTests(): void {
  pending.clear();
}

// ---------------------------------------------------------------------------
// Phase 10 — Synthesis decision log
// ---------------------------------------------------------------------------

/**
 * Extended decision entry for Phase 10 Total Monad Synthesis.
 *
 * Adds synthesis-specific fields to the base DecisionEntry.
 * The correlated monadId is the winner whose value was used (or the contested
 * outcome when no quorum was reached).
 *
 * Appended to the same MONAD_DECISION_LOG JSONL file as regular decisions,
 * distinguished by the presence of `synthesisPolicy` field.
 */
export type SynthesisDecisionEntry = DecisionEntry & {
  /** Name of the synthesis policy used (e.g. "strict-quorum"). */
  synthesisPolicy: string;
  /** Number of claimants that were queried in parallel. */
  sourceCount: number;
  /** Number of responding sources that agreed on the winning value. */
  agreeCount: number;
  /** How the synthesis resolved: quorum / highest-scored / contested. */
  divergenceStrategy: "quorum" | "highest-scored" | "contested";
  /** Per-source latency breakdown for observability. */
  sourceSummaries: Array<{
    monad_id: string;
    ok: boolean;
    latencyMs: number;
    score: number;
  }>;
};

const pendingSynthesis = new Map<string, SynthesisDecisionEntry>();

/**
 * Records a synthesis decision before the bridge knows whether the
 * response was accepted by the client.
 *
 * `latencyMs` here is the max across all sources (total wall-clock cost
 * of the parallel forward). Filled in by `correlateSynthesisOutcome`.
 */
export function recordSynthesisDecision(
  entry: Omit<SynthesisDecisionEntry, "outcome" | "latencyMs" | "reward">,
): void {
  pendingSynthesis.set(entry.decisionId, entry as SynthesisDecisionEntry);
}

/**
 * Closes a pending synthesis decision with the final outcome.
 *
 * Reward computation mirrors `correlateOutcome` but accounts for
 * synthesis-specific signals:
 * - Contested outcomes (divergenceStrategy="contested") are treated as
 *   partial failures: they return a penalized reward to teach the adaptive
 *   weight learner that the current claimant mix is unreliable.
 */
export function correlateSynthesisOutcome(
  decisionId: string,
  latencyMs: number,
  ok: boolean,
): void {
  const entry = pendingSynthesis.get(decisionId);
  if (!entry) return;
  pendingSynthesis.delete(decisionId);

  const qualityWeight = parseFloat(process.env.MONAD_LEARNING_QUALITY_WEIGHT ?? "0.7");

  // Three reward regimes, ordered by severity:
  //
  //   hard failure  (ok=false)             rewardQuality=-1.0, rewardLatency=0
  //   contested     (quorum not reached)   rewardQuality=-0.3, rewardLatency=0
  //   success       (quorum or highest-scored) rewardQuality=+1.0, rewardLatency=speed bonus
  //
  // Contested explicitly receives NO latency bonus (rewardLatency=0).
  // Rationale: a fast contested response is still a divergence failure — speed
  // should not flip the sign and reward a claimant set that could not converge.
  // With default qualityWeight=0.7: contested reward = 0.7*-0.3 + 0.3*0 = -0.21 (always negative).
  let rewardQuality: number;
  let rewardLatency: number;
  if (!ok) {
    rewardQuality = -1.0;
    rewardLatency = 0;
  } else if (entry.divergenceStrategy === "contested") {
    rewardQuality = -0.3;
    rewardLatency = 0; // no latency bonus — contested is a cohesion failure regardless of speed
  } else {
    rewardQuality = 1.0;
    rewardLatency = Math.max(0, 1 - latencyMs / 5_000);
  }

  const reward = qualityWeight * rewardQuality + (1 - qualityWeight) * rewardLatency;

  const completed: SynthesisDecisionEntry = {
    ...entry,
    outcome: ok ? "success" : "failure",
    latencyMs,
    reward,
  };

  appendToLog(completed);

  // Feed synthesis reward back into adaptive weights so the learning loop
  // knows which namespace/claimant combinations tend to agree vs diverge.
  if (Object.keys(entry.breakdown).length > 0) {
    updateAdaptiveWeights(reward, entry.breakdown, { namespace: entry.namespace });

    if (process.env.MONAD_DEBUG_WEIGHTS === "1") {
      const report = getWeightReport();
      const parts = Object.entries(report.current)
        .map(([k, v]) => {
          const d = report.delta[k] ?? 0;
          return `${k}: ${v.toFixed(3)} (Δ${d >= 0 ? "+" : ""}${d.toFixed(3)})`;
        })
        .join(", ");
      console.log(
        `[synthesis weights] strategy=${entry.divergenceStrategy} sources=${entry.sourceCount} agree=${entry.agreeCount} — ${parts} reward: ${reward.toFixed(3)}`,
      );
    }
  }
}

export function resetSynthesisDecisionLogForTests(): void {
  pendingSynthesis.clear();
}
