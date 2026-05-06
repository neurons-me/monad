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
    runnerUp?: {
        monad_id: string;
        score: number;
    };
    outcome?: "success" | "failure";
    latencyMs?: number;
    reward?: number;
};
/**
 * Stores a decision snapshot until the bridge knows the outcome.
 *
 * This is intentionally in-memory and best-effort. Durable output happens only
 * after `correlateOutcome`, when success/failure and latency are known.
 */
export declare function recordDecision(entry: Omit<DecisionEntry, "outcome" | "latencyMs" | "reward">): void;
/**
 * Closes a pending decision with its actual request outcome.
 *
 * When `MONAD_DECISION_LOG` is set, the completed decision is appended as one
 * JSON object per line. Missing decision IDs are ignored.
 */
export declare function correlateOutcome(decisionId: string, latencyMs: number, ok: boolean): void;
export declare function resetDecisionLogForTests(): void;
