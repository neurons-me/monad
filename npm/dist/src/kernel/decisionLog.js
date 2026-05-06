import fs from "fs";
import { getWeightReport, updateAdaptiveWeights } from "./adaptiveWeights.js";
const pending = new Map();
/**
 * Stores a decision snapshot until the bridge knows the outcome.
 *
 * This is intentionally in-memory and best-effort. Durable output happens only
 * after `correlateOutcome`, when success/failure and latency are known.
 */
export function recordDecision(entry) {
    pending.set(entry.decisionId, entry);
}
/**
 * Closes a pending decision with its actual request outcome.
 *
 * When `MONAD_DECISION_LOG` is set, the completed decision is appended as one
 * JSON object per line. Missing decision IDs are ignored.
 */
export function correlateOutcome(decisionId, latencyMs, ok) {
    const entry = pending.get(decisionId);
    if (!entry)
        return;
    pending.delete(decisionId);
    // Two-signal reward: quality (success/failure) weighted 70%, latency 30%.
    // Failures always penalize (-0.7 at default mix), avoiding the trap of
    // optimizing for speed while tolerating correctness failures.
    const qualityWeight = parseFloat(process.env.MONAD_LEARNING_QUALITY_WEIGHT ?? "0.7");
    const rewardQuality = ok ? 1.0 : -1.0;
    const rewardLatency = ok ? Math.max(0, 1 - latencyMs / 5000) : 0;
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
function appendToLog(entry) {
    const logPath = process.env.MONAD_DECISION_LOG;
    if (!logPath)
        return;
    try {
        fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
    }
    catch {
        // best-effort: never crash the server on log write failure
    }
}
export function resetDecisionLogForTests() {
    pending.clear();
}
