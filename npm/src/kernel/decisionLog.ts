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
