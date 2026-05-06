#!/usr/bin/env tsx
/**
 * watch-weights.ts — live polling monitor for NRP adaptive scorer weights.
 *
 * Polls GET /.mesh/weights on the local monad daemon and renders a colored
 * table showing current weights, deltas from defaults, and health warnings.
 *
 * Usage:
 *   tsx scripts/watch-weights.ts
 *   tsx scripts/watch-weights.ts --port 8161 --interval 2000
 *   tsx scripts/watch-weights.ts --namespace suis-macbook-air.local
 *   MONAD_PORT=8282 tsx scripts/watch-weights.ts
 *
 * Health signals displayed:
 *   ⚠ dominant scorer  — one scorer holds > 70% of total weight
 *   ⚠ dead scorer      — a scorer is near the WEIGHT_MIN floor (0.01)
 *   ⚠ oscillation      — reward signal alternating sign > 40% of the time
 *   ⚠ no learning      — 10+ updates applied, weights haven't moved
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port:     { type: "string", default: process.env.MONAD_PORT ?? "8161" },
    interval: { type: "string", default: "2000" },
    host:     { type: "string", default: "localhost" },
    namespace:{ type: "string", default: process.env.MONAD_NAMESPACE ?? "" },
  },
  strict: false,
});

const BASE     = `http://${values.host}:${values.port}`;
const INTERVAL = parseInt(values.interval!, 10);

// ANSI escape sequences
const R  = "\x1b[0m";
const B  = "\x1b[1m";
const DM = "\x1b[2m";
const RD = "\x1b[31m";
const GR = "\x1b[32m";
const YL = "\x1b[33m";
const CY = "\x1b[36m";
const MG = "\x1b[35m";

function fmtDelta(d: number, def: number): string {
  const s = `${d >= 0 ? "+" : ""}${d.toFixed(4)}`;
  if (Math.abs(d) < 0.002) return DM + s + R;
  if (d > 0) return GR + s + R;
  return RD + s + R;
}

function fmtWeight(v: number, isDefault: boolean): string {
  const s = v.toFixed(4);
  return isDefault ? DM + s + R : B + s + R;
}

function healthLines(health: {
  dominantScorer: string | null;
  deadScorer: string | null;
  oscillation: boolean;
  noLearning: boolean;
}): string[] {
  const out: string[] = [];
  if (health.dominantScorer)
    out.push(`${YL}⚠  dominant scorer: ${B}${health.dominantScorer}${R}${YL} is holding >70% of total weight — may be over-fitted${R}`);
  if (health.deadScorer)
    out.push(`${MG}⚠  dead scorer: ${B}${health.deadScorer}${R}${MG} is near the WEIGHT_MIN floor and barely contributing${R}`);
  if (health.oscillation)
    out.push(`${RD}⚠  oscillation — reward signal alternating sign frequently, learning may be contradictory${R}`);
  if (health.noLearning)
    out.push(`${DM}⚠  no learning — 10+ updates applied but weights haven't moved (check bridge integration)${R}`);
  return out;
}

async function poll(): Promise<void> {
  process.stdout.write("\x1b[2J\x1b[H"); // clear + home
  const now = new Date().toISOString();
  const url = new URL("/.mesh/weights", BASE);
  if (values.namespace) url.searchParams.set("namespace", values.namespace);

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as {
      current: Record<string, number>;
      defaults: Record<string, number>;
      delta: Record<string, number>;
      updateCount: number;
      lastUpdatedAt: number | null;
      stable: boolean;
      health: {
        dominantScorer: string | null;
        deadScorer: string | null;
        oscillation: boolean;
        noLearning: boolean;
      };
      namespace?: {
        namespace: string;
        sampleCount: number;
        maturity: number;
        current: Record<string, number>;
        delta: Record<string, number>;
        blended: Record<string, number>;
      };
    };

    const { current, defaults, delta, updateCount, lastUpdatedAt, stable, health } = data;

    console.log(`${B}${CY}NRP Adaptive Weights${R}  ${DM}${now}${R}`);
    console.log(`${DM}${url.toString()}  updates: ${updateCount}  stable: ${stable}${R}`);
    if (data.namespace) {
      console.log(`${DM}namespace: ${data.namespace.namespace}  samples: ${data.namespace.sampleCount}  maturity: ${(data.namespace.maturity * 100).toFixed(1)}%${R}`);
    }
    console.log();

    const header = `${"Scorer".padEnd(13)}${"Current".padEnd(11)}${"Default".padEnd(11)}Delta`;
    console.log(B + header + R);
    console.log("─".repeat(47));

    for (const [name, cur] of Object.entries(current)) {
      const def   = defaults[name] ?? 0;
      const d     = delta[name] ?? 0;
      const atDef = Math.abs(cur - def) < 0.0001;
      const nsBlend = data.namespace?.blended?.[name];
      const suffix = nsBlend !== undefined ? `  blend=${nsBlend.toFixed(4)}` : "";
      console.log(
        `${name.padEnd(13)}${fmtWeight(cur, atDef).padEnd(atDef ? 14 : 22)}${(def.toFixed(4)).padEnd(11)}${fmtDelta(d, def)}${suffix}`,
      );
    }

    console.log();
    if (lastUpdatedAt) {
      const ago = Math.round((Date.now() - lastUpdatedAt) / 1000);
      console.log(`${DM}last update: ${ago}s ago${R}`);
    } else {
      console.log(`${DM}no updates yet — forward some mesh requests to begin learning${R}`);
    }

    const warnings = healthLines(health);
    console.log();
    if (warnings.length === 0) {
      console.log(`${GR}✓  learning loop healthy${R}`);
    } else {
      for (const w of warnings) console.log(w);
    }
  } catch (err: any) {
    console.log(`${B}${CY}NRP Adaptive Weights${R}  ${DM}${now}${R}`);
    console.log();
    console.log(`${RD}✗  Cannot reach ${url.toString()}${R}`);
    console.log(`${DM}   ${err?.message ?? String(err)}${R}`);
    console.log();
    console.log(`${DM}Is the monad daemon running?  Try: npm run dev${R}`);
  }

  console.log();
  console.log(`${DM}Refreshing every ${INTERVAL / 1000}s — Ctrl+C to exit${R}`);
}

await poll();
setInterval(poll, INTERVAL);
