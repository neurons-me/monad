#!/usr/bin/env tsx
/**
 * analyze-decisions — offline scorer analysis from decision log
 *
 * Usage:
 *   MONAD_DECISION_LOG=~/.monad/decisions.jsonl tsx scripts/analyze-decisions.ts
 *   tsx scripts/analyze-decisions.ts ~/.monad/decisions.jsonl
 *
 * Reads a JSONL file written by decisionLog.ts (one DecisionEntry per line).
 * Outputs a structured report to stdout.
 */

import fs from "fs";

// ── Types (inline to keep the script self-contained) ──────────────────────────

type ScorerBreakdown = { value: number; weight: number; contribution: number };
type DecisionEntry = {
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
};

// ── Load entries ──────────────────────────────────────────────────────────────

const logPath = process.argv[2] ?? process.env.MONAD_DECISION_LOG ?? "";
if (!logPath) {
  console.error("Usage: tsx scripts/analyze-decisions.ts <decisions.jsonl>");
  console.error("       or set MONAD_DECISION_LOG env var");
  process.exit(1);
}
if (!fs.existsSync(logPath)) {
  console.error(`File not found: ${logPath}`);
  process.exit(1);
}

const entries: DecisionEntry[] = fs
  .readFileSync(logPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .flatMap((line) => {
    try { return [JSON.parse(line) as DecisionEntry]; } catch { return []; }
  })
  .filter((e) => e.outcome !== undefined); // skip uncorrelated entries

if (entries.length === 0) {
  console.log("No correlated decision entries found in", logPath);
  process.exit(0);
}

// ── Aggregate ─────────────────────────────────────────────────────────────────

const successes = entries.filter((e) => e.outcome === "success");
const failures  = entries.filter((e) => e.outcome === "failure");
const total = entries.length;

function mean(vals: number[]): number {
  return vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length;
}

// Collect all scorer names across all entries
const scorerNames = new Set<string>();
for (const e of entries) Object.keys(e.breakdown).forEach((k) => scorerNames.add(k));

// Per-scorer mean contribution by outcome
function scorerMeans(subset: DecisionEntry[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const name of scorerNames) {
    result[name] = mean(subset.map((e) => e.breakdown[name]?.contribution ?? 0));
  }
  return result;
}

const successMeans = scorerMeans(successes);
const failureMeans = scorerMeans(failures);

// Margin distribution
const FRAGILE_THRESHOLD = 0.05;
const fragile = entries.filter((e) => e.margin < FRAGILE_THRESHOLD);
const normal  = entries.filter((e) => e.margin >= FRAGILE_THRESHOLD);
const fragileSuccessRate = fragile.length
  ? fragile.filter((e) => e.outcome === "success").length / fragile.length
  : null;
const normalSuccessRate = normal.length
  ? normal.filter((e) => e.outcome === "success").length / normal.length
  : null;

// Runner-up availability on failure
const failuresWithRunnerUp    = failures.filter((e) => e.runnerUp);
const failuresWithoutRunnerUp = failures.filter((e) => !e.runnerUp);

// Overconfidence: high margin + failure = the system was wrong AND certain
// Low margin + failure = expected noise (tied candidates)
const OVERCONFIDENCE_MARGIN = 0.20;
const overconfidentFailures = failures.filter((e) => e.margin >= OVERCONFIDENCE_MARGIN);

// Which scorer correlates most with failure?
// delta = successMean - failureMean; negative delta → lower in failures → correlated with failure
const scorerDeltas = [...scorerNames].map((name) => ({
  name,
  successMean: successMeans[name] ?? 0,
  failureMean: failureMeans[name] ?? 0,
  delta: (successMeans[name] ?? 0) - (failureMeans[name] ?? 0),
})).sort((a, b) => a.delta - b.delta); // most negative first

// ── Report ────────────────────────────────────────────────────────────────────

const pct = (n: number, d: number) => d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "n/a";
const fmt = (n: number) => n.toFixed(4);
const hr = (char = "─", n = 54) => char.repeat(n);

console.log("\nDECISION ANALYSIS");
console.log(hr("═"));

console.log(`\nTotal entries : ${total}`);
console.log(`  success     : ${successes.length} (${pct(successes.length, total)})`);
console.log(`  failure     : ${failures.length}  (${pct(failures.length, total)})`);

console.log(`\n── Scorer contribution by outcome ${hr("─", 20)}`);
const nameWidth = Math.max(...[...scorerNames].map((n) => n.length), 10);
console.log(
  `  ${"scorer".padEnd(nameWidth)}   success   failure     delta`,
);
console.log(`  ${hr("─", nameWidth + 36)}`);
for (const { name, successMean, failureMean, delta } of scorerDeltas) {
  const marker = Math.abs(delta) > 0.01 && delta < 0 ? "  ← correlated with failure" : "";
  console.log(
    `  ${name.padEnd(nameWidth)}   ${fmt(successMean)}   ${fmt(failureMean)}   ${delta >= 0 ? "+" : ""}${fmt(delta)}${marker}`,
  );
}

console.log(`\n── Margin distribution ${hr("─", 31)}`);
console.log(
  `  fragile decisions (margin < ${FRAGILE_THRESHOLD}) : ${fragile.length} / ${total}  (${pct(fragile.length, total)})`,
);
if (fragileSuccessRate !== null)
  console.log(`    success rate in fragile : ${(fragileSuccessRate * 100).toFixed(1)}%`);
if (normalSuccessRate !== null)
  console.log(`    success rate in normal  : ${(normalSuccessRate * 100).toFixed(1)}%`);

console.log(`\n── Runner-up on failure ${hr("─", 30)}`);
console.log(`  failures with runner-up    : ${failuresWithRunnerUp.length} / ${failures.length || 1}  (${pct(failuresWithRunnerUp.length, failures.length || 1)})`);
console.log(`  failures without runner-up : ${failuresWithoutRunnerUp.length} / ${failures.length || 1}  (${pct(failuresWithoutRunnerUp.length, failures.length || 1)})`);
if (failuresWithRunnerUp.length > 0) {
  const avgMarginOnFailure = mean(failuresWithRunnerUp.map((e) => e.margin));
  console.log(`  avg margin on failed decisions with alternative : ${fmt(avgMarginOnFailure)}`);
  if (avgMarginOnFailure < FRAGILE_THRESHOLD) {
    console.log(`  ← most failures were fragile (noise) — consider exploration to gather comparative data`);
  } else {
    console.log(`  ← failures were confident decisions — scorer bias likely needs adjustment`);
  }
}

console.log(`\n── Overconfidence (margin ≥ ${OVERCONFIDENCE_MARGIN} + failure) ${hr("─", 13)}`);
console.log(`  high-confidence failures : ${overconfidentFailures.length} / ${failures.length || 1}  (${pct(overconfidentFailures.length, failures.length || 1)})`);
if (overconfidentFailures.length > 0) {
  console.log(`  ❗ system was certain but wrong — these are the most dangerous failures`);
  console.log(`  recommended action: inspect scorer weights for the losing namespace`);
} else if (failures.length > 0) {
  console.log(`  ✓ no overconfident failures — all failures were near ties (expected noise)`);
}

console.log(`\n── Latency & reward ${hr("─", 34)}`);
const withLatency = entries.filter((e) => e.latencyMs !== undefined);
if (withLatency.length > 0) {
  const successLatency = mean(successes.filter((e) => e.latencyMs !== undefined).map((e) => e.latencyMs!));
  const failureLatency = mean(failures.filter((e) => e.latencyMs !== undefined).map((e) => e.latencyMs!));
  console.log(`  avg latency success : ${successLatency.toFixed(0)} ms    failure : ${failureLatency.toFixed(0)} ms`);
} else {
  console.log("  no latency data");
}
const withReward = entries.filter((e) => e.reward !== undefined);
if (withReward.length > 0) {
  const avgReward = mean(withReward.map((e) => e.reward!));
  const avgSuccessReward = mean(successes.filter((e) => e.reward !== undefined).map((e) => e.reward!));
  console.log(`  avg reward (all)    : ${fmt(avgReward)}`);
  console.log(`  avg reward (success): ${fmt(avgSuccessReward)}`);
  if (avgReward < 0.3) console.log("  ⚠ low average reward — high failure rate or consistently slow responses");
}

console.log();
