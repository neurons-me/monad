# NRP Learning Observability
`src/kernel/adaptiveWeights.ts` — monad.ai v2.1+

---

## Start here

If you are new to the learning loop, read [learning-loop.md](./learning-loop.md) first. It explains what the loop does, how the weight update formula works, and how to interpret the numbers you see here.

This document is the **operator reference** — what to run, what to watch, and what to do when something looks wrong.

---

## Overview

The NRP adaptive scoring system learns scorer weights from live request outcomes. The learning loop is intentionally slow (α = 0.01) so it takes hundreds of requests before weights shift meaningfully. This guide covers how to observe the learning system in production, interpret health signals, and diagnose problems.

## Running the smoke tests

Before reading live weights in production, verify the learning pipeline is wired correctly by running the smoke tests:

```bash
# All NRP tests (22 files, 235 tests):
npm test

# Only the learning loop smoke tests:
npx vitest run tests/NRP/learningLoop.test.ts
```

The smoke tests verify 7 properties of the learning pipeline without requiring a live server. If they pass, the pipeline from `recordDecision → correlateOutcome → updateAdaptiveWeights` is correctly wired. See [learning-loop.md § Running the smoke tests](./learning-loop.md#running-the-smoke-tests) for what each section proves.

---

## Live weight monitor

```bash
tsx scripts/watch-weights.ts
tsx scripts/watch-weights.ts --port 8282 --interval 3000
MONAD_PORT=8282 tsx scripts/watch-weights.ts
```

The monitor polls `GET /.mesh/weights` and renders a color-coded table:

```
NRP Adaptive Weights  2026-05-05T12:00:00.000Z
http://localhost:8161/.mesh/weights  updates: 142  stable: false

Scorer       Current    Default    Delta
───────────────────────────────────────────────
latency      0.2280     0.2500     -0.0220
recency      0.3510     0.3500     +0.0010
resonance    0.4210     0.4000     +0.0210

last update: 3s ago

✓  learning loop healthy
```

Color key:
- **Green delta** — scorer is being reinforced by successful outcomes
- **Red delta** — scorer was associated with failed decisions
- **Dim delta** — movement < 0.002 (essentially unchanged)
- **Bold current** — weight has moved from default

---

## HTTP endpoint

```bash
curl http://localhost:8161/.mesh/weights | jq
```

```json
{
  "ok": true,
  "current":       { "latency": 0.228, "recency": 0.351, "resonance": 0.421 },
  "defaults":      { "latency": 0.250, "recency": 0.350, "resonance": 0.400 },
  "delta":         { "latency": -0.022, "recency": 0.001, "resonance": 0.021 },
  "updateCount":   142,
  "lastUpdatedAt": 1746412800000,
  "stable":        false,
  "health": {
    "dominantScorer": null,
    "deadScorer":     null,
    "oscillation":    false,
    "noLearning":     false
  },
  "_hint": "delta = current − defaults. Positive: scorer reinforced by good outcomes. Negative: penalized by failures."
}
```

---

## Console logging

```bash
# Log every weight update to console after each forwarded request:
MONAD_DEBUG_WEIGHTS=1 npm run dev
# [weights] latency: 0.228 (Δ-0.022), recency: 0.351 (Δ+0.001), resonance: 0.421 (Δ+0.021) — updates: 142 reward: 0.850
```

---

## Health signals

The `health` object in the weight report contains four diagnostic flags. None triggers an automatic action — they are informational.

### `stable: true`

All deltas are within 5% of their default weight. This is expected at startup and on homogeneous meshes (all nodes behave identically, so no scorer is consistently better than another).

**Not a problem unless** `updateCount > 100` and you expected the system to learn something. In that case, check `noLearning`.

---

### `dominantScorer: "resonance"` (example)

One scorer has captured more than 70% of the total weight. The other scorers are nearly ignored.

**Interpretation:**
- Could be correct: if one signal (e.g., resonance) is genuinely the strongest predictor of success in your mesh, the learning loop will correctly up-weight it.
- Could be overfitting: if the mesh went through a period where all failures came from low-resonance nodes, resonance gets over-rewarded even if latency or recency also correlates.

**Diagnosis:** run `tsx scripts/analyze-decisions.ts ~/.monad/decisions.jsonl` and look at the **scorer contribution by outcome** table. If the delta is negative for the dominant scorer on failures, the system is self-correcting. If the delta is consistently positive for both success and failure, there may be confounding.

**Remediation:** use per-claim weight overrides to cap the scorer temporarily:
```ts
_.mesh.monads.frank.claimed["suis-macbook-air.local"]._weight_resonance = 0.4
```

---

### `deadScorer: "latency"` (example)

A scorer's learned weight has dropped to `WEIGHT_MIN * 2` (0.02) or below — it is barely contributing to selection.

**Interpretation:** The scorer was consistently associated with failures. This can be correct (latency is not predictive for a CPU-bound workload) or incorrect (an early burst of timeouts caused the learning loop to penalize latency forever).

**Remediation:**
- Inject a per-claim floor: `_weight_latency: 0.1` in the claim metadata
- Reset learned weights and let the system relearn from a clean state:
  ```bash
  # No HTTP reset endpoint exists yet — restart the daemon to clear in-memory weights.
  # Stored weights in _.mesh.adaptiveWeights persist across restarts.
  ```
- Raise `LEARNING_RATE` temporarily to accelerate recovery (requires restart)

---

### `oscillation: true`

The recent reward signal alternates sign more than 40% of the time across the last 10 rewards.

**Interpretation:** The system is receiving contradictory signal — successful and failed requests are alternating. This makes weight learning unstable (each update partially cancels the previous one).

**Common causes:**
- Two similarly-scored nodes with opposite reliability: the learning loop wins with node A, then loses with node B, then wins with A again
- `MONAD_EXPLORATION_RATE` is too high relative to mesh size: forced exploration through the runner-up triggers failures which flip sign
- Transient infrastructure instability (nodes rebooting, network flapping)

**Remediation:**
- Reduce `MONAD_EXPLORATION_RATE` temporarily
- Check `scripts/analyze-decisions.ts` — "runner-up on failure" section shows if alternating node selection is the source
- If infrastructure is the cause, wait for stability before drawing conclusions

---

### `noLearning: true`

More than 10 gradient updates have been applied but no weight has moved more than 0.002 from its default.

**Interpretation:** The bridge is calling `updateAdaptiveWeights` but the breakdown contributions are all near zero. This usually means:

1. **No mesh-claim selections**: all requests are resolved via name-selector, not scored claimants. Check `MONAD_DEBUG_SCORING=1` output — if you see no `[scoring]` lines, no scored decisions are being made.
2. **Zero scorer values**: all claimants have zero latency, recency, and resonance scores (fresh nodes with no history). Contributions = value × weight; if value is 0, delta is 0.
3. **Bridge integration gap**: `correlateOutcome` is not being called after forwards. Check `bridgeHandler.ts` for the `if (decisionId)` guard.

**Verification:**
```bash
MONAD_DEBUG_WEIGHTS=1 npm run dev
# Should print [weights] lines after each forwarded mesh-claim request
```

---

## Reward formula

Every forwarded request produces a reward that drives the weight update:

```
rewardQuality = ok ? 1.0 : −1.0
rewardLatency = ok ? max(0, 1 − latencyMs / 5000) : 0

reward = 0.7 × rewardQuality + 0.3 × rewardLatency
```

| Outcome  | Latency   | reward  |
|----------|-----------|---------|
| success  | 0 ms      | 1.000   |
| success  | 2 500 ms  | 0.850   |
| success  | 5 000 ms  | 0.700   |
| failure  | any       | −0.700  |

The 0.7/0.3 split ensures correctness errors move weights more decisively than latency variance. Override with `MONAD_LEARNING_QUALITY_WEIGHT`:

```bash
# Weight quality at 90%, latency at 10%:
MONAD_LEARNING_QUALITY_WEIGHT=0.9 npm run dev
```

---

## Weight update rule

```
Δweight = α × reward × contribution
new_weight = max(WEIGHT_MIN, old_weight + Δweight)
```

- `α = LEARNING_RATE = 0.01` — controls convergence speed
- `WEIGHT_MIN = 0.01` — no scorer falls below 1% influence
- `contribution = scorer_value × normalized_weight` — how much this scorer influenced the winning selection

**Weight resolution priority** (highest first):

| Priority | Source | Notes |
|----------|--------|-------|
| 1 | `meta._weight_<name>` | Per-claim explicit override |
| 2 | `ctx.adaptiveWeights[name]` | Globally learned prior |
| 3 | `scorer.defaultWeight` | Hardcoded fallback |

---

## Environment variables

| Variable | Default | Effect |
|----------|---------|--------|
| `MONAD_DEBUG_WEIGHTS=1` | off | Log weight update after every forward |
| `MONAD_DEBUG_SCORING=1` | off | Log every scoring decision to console |
| `MONAD_SCORE_SAMPLE_RATE=0.01` | 0 | Sample ~1% of decisions to console |
| `MONAD_SCORE_MARGIN_THRESHOLD=0.05` | 0.05 | Always log fragile decisions |
| `MONAD_EXPLORATION_RATE=0.15` | 0 | Route ~15% of fragile decisions to runner-up |
| `MONAD_DECISION_LOG=/path/decisions.jsonl` | unset | Enable JSONL decision log |
| `MONAD_LEARNING_QUALITY_WEIGHT=0.7` | 0.7 | Quality vs latency blend in reward |
| `MONAD_MESH_STALE_MS=300000` | 300000 | Staleness cutoff for claimants |

---

## Offline analysis

```bash
MONAD_DECISION_LOG=~/.monad/decisions.jsonl npm run dev

# After accumulating traffic:
tsx scripts/analyze-decisions.ts ~/.monad/decisions.jsonl
```

The analyzer complements the live weight monitor: the monitor shows the current weight state, the analyzer explains *why* weights moved (which scorer dimensions correlate with success vs failure).

See [scoring.md](./scoring.md#offline-analyzer) for full analyzer output documentation.

---

## Phase 9 — namespace-maturity blending (implemented)

The adaptive learner now uses a global prior plus namespace-local posterior weights:

```txt
_.mesh.adaptiveWeights          global prior
_.mesh.nsWeights.<namespace>    namespace-local posterior
```

Reads use a maturity blend:

```
maturity = min(1, nsSamples / 200)
selectionWeights = global × (1 − maturity) + namespace × maturity
```

- `samples = 0`   → 100% global (bootstrap)
- `samples = 100`  → 50% blend
- `samples = 200+` → 100% namespace for selection; global still receives 5% background signal during attribution

The global prior is never fully disabled so cross-namespace trends (e.g., a latency regression affecting all routes) still propagate upward.

Observe a namespace-specific blend:

```bash
curl "http://localhost:8161/.mesh/weights?namespace=suis-macbook-air.local" | jq
tsx scripts/watch-weights.ts --namespace suis-macbook-air.local
```
