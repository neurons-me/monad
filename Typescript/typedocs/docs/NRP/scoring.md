# NRP Scoring Engine
`src/kernel/scoring.ts` — monad.ai v2.1+

**Related guides:**
- [learning-loop.md](./learning-loop.md) — entry-level guide: what the loop is, how weights update, complete architecture diagram
- [learning-observability.md](./learning-observability.md) — operator reference: watch-weights.ts, health signals, smoke tests

---

## Contract

```
computeScore(m, meta, ctx) → number
```

**Normalized mode (default, production):**
- Score ∈ [0, 1] always
- Same inputs → same output (deterministic)
- Scaling all weights by any constant → identical score
- NaN / Infinity in any field → treated as 0 / 1, never propagates

**Raw mode** (`ctx.mode = "raw"`): weights used as-is, score unbounded. For debugging and experimentation only.

---

## Two-phase resolution
The scoring engine operates after the structural filter, not before.

```
Phase 1 — structural   findMonadsForNamespace()     O(index)   local, sync
Phase 2 — scoring      computeScore() per claimant  O(N)       local, sync
Phase 3 — value        fetch(origin, path)           O(network) remote, async
```

Phase 1 answers: *who could answer?*
Phase 2 answers: *who should answer?*
Phase 3 answers: *what is the answer?*

---

## ClaimMeta — open schema
The `_.mesh.monads.<id>.claimed.<namespace>` sub-tree in `.me`.
No fixed schema. The engine reads only what scorers ask for. Any field is valid.
**Common fields (all optional):**
| Field | Type | Set by | Used by |
|-------|------|--------|---------|
| `resonance` | number | `recordForwardResult` | resonance scorer |
| `effectiveResonance` | number | `recordForwardResult` | resonance scorer (preferred) |
| `avgLatencyMs` | number | `recordForwardResult` | latency scorer |
| `forwardCount` | number | `recordForwardResult` | internal |
| `failureCount` | number | `recordForwardResult` | `effectiveResonance` calc |
| `lastForwardedAt` | number | `recordForwardResult` | observability |

**Weight overrides (per-claim, per-scorer):**

```ts
// Any of these override a scorer's defaultWeight for this claim only:
_weight_recency: 0.1
_weight_resonance: 0.8
_weight_latency: 0.1
// or camelCase:
resonanceWeight: 0.8
```

**Arbitrary fields — add anything:**

```ts
_.mesh.monads.frank.claimed.suis-macbook-air.local = {
  geopoliticalZone: "mx-east",
  energyProfile: "low-power",
  costPerRequest: 0.0012,
  customExperimentScore: 0.77,
}
```

These are ignored by built-in scorers unless you write a custom scorer that reads them.

---

## Built-in scorers
Three scorers, alphabetical order (order is part of the determinism guarantee).
| Name | Default weight | Input | Range |
|------|---------------|-------|-------|
| `latency` | 0.25 | `meta.avgLatencyMs` (default 200ms) | 1.0 @ 0ms → 0 @ 2000ms |
| `recency` | 0.35 | `m.last_seen` | 1.0 @ 0s ago → 0 @ 5min |
| `resonance` | 0.40 | `meta.effectiveResonance` or `meta.resonance` | saturates at 100 interactions |

All three weights sum to 1.0 by default → normalized mode is a no-op at default config.

---

## Patch bay — declarative feature composition

`src/kernel/patchBay.ts` — Phase 8

The patch bay lets you declare **connections between signals** without writing scorer code. Think of it as a patch cable routing layer that sits below the adaptive weights layer:

- **Patch bay** (you control) — what signals connect to what
- **Adaptive weights** (system learns) — how much each connection matters

Registered patches are stored in `_.mesh.patchBay` (same free-form kernel tree as `.me`) and automatically included in every `selectMeshClaimant` call.

### Operations

| Op | Signature | Effect |
|----|-----------|--------|
| `multiply` | `inputs[0] × inputs[1] × ...` | AND-like: all must be high |
| `add` | `min(1, inputs[0] + inputs[1] + ...)` | OR-like: any being high is enough |
| `min` | `min(inputs)` | Bottleneck — weakest signal wins |
| `max` | `max(inputs)` | Union — strongest signal wins |
| `gate` | `inputs[0] ≥ threshold ? inputs[1] : 0` | Conditional pass-through |
| `power` | `inputs[0] ^ exp` | Sharpen (`exp > 1`) or soften (`exp < 1`) a curve |

### Registering patches

```ts
import { registerPatch, unregisterPatch } from "./src/kernel/patchBay.js";

// x → b: latency × recency (strong only when both are high)
registerPatch({ inputs: ["latency", "recency"], op: "multiply", out: "lat_rec" });

// a → b → c: resonance gated by recency (ignore resonance from stale nodes)
registerPatch({ inputs: ["recency", "resonance"], op: "gate", params: { threshold: 0.5 }, out: "fresh_resonance" });

// x² → c: latency squared (punishes high latency more aggressively)
registerPatch({ inputs: ["latency"], op: "power", params: { exp: 2 }, out: "lat_squared" });

// a × b × c: three-way interaction
registerPatch({ inputs: ["latency", "recency", "resonance"], op: "multiply", out: "all_three" });

// Remove a patch
unregisterPatch("lat_rec");
```

Each patch automatically gets an adaptive weight starting at `defaultWeight` (default `0.1`). The learning loop then raises it if the derived feature predicts good outcomes and lowers it toward `WEIGHT_MIN` if it's noise.

### How it integrates

```
raw signals: latency, recency, resonance
     ↓ patch bay (you decide connections)
derived: lat_rec, fresh_resonance, lat_squared
     ↓ adaptive weights (system learns importance)
score = Σ(w_i × v_i) across all scorers
```

`computeScore` and `computeScoreDetailed` are unaffected — patch scorers only appear automatically when routing through `selectMeshClaimant`. For direct score computation with patches:

```ts
const patchScorers = getPatchScorers(BUILT_IN_SCORERS);
computeScoreDetailed(m, meta, ctx, patchScorers);
```

**Constraints (Phase 8):**
- Inputs must name built-in scorers (`latency`, `recency`, `resonance`) or `extraScorers` passed to `selectMeshClaimant`. Patch-of-patch chaining is not yet supported.
- Output name must be unique across built-ins and all registered patches.
- Adaptive weights handles the rest — you never set patch weights manually.

---

## Adding a scorer

```ts
const geoScorer: Scorer = {
  name: "geo",               // unique, used as _weight_geo key
  defaultWeight: 0.2,        // relative to built-in weights
  fn: (_m, meta, _ctx) => {
    if (meta.geopoliticalZone === "mx-east") return 1;
    return 0;
  },
};

// Pass to selectMeshClaimant:
selectMeshClaimant({ ..., extraScorers: [geoScorer] });

// Or to computeScore directly:
computeScore(m, meta, ctx, [geoScorer]);
```

Rules:
- `fn` must return a value that makes sense in [0, 1]. Values outside are clamped.
- `name` must be unique across built-ins and extras.
- In normalized mode, weight is relative — a `defaultWeight: 10` scorer dominates but the total score still stays in [0, 1].

---

## Learning loop
`recordForwardResult(monadId, namespace, elapsedMs, ok)` is called by the bridge after every forwarded request.
**Resonance** uses exponential decay so historical wins don't last forever:

```
resonance = clamp(prev * 0.97 + (ok ? 1 : -0.7), 0, 1000)
```

**effectiveResonance** penalizes high failure rates:

```
effectiveResonance = resonance * (1 - failureRate)
```

A node with resonance=100 but 50% failure rate gets effectiveResonance=50.
**avgLatencyMs** uses EWMA (80% past, 20% current):
```
avgLatencyMs = round(prev * 0.8 + current * 0.2)
```

---

## Scoring modes

| Mode | Weights | Score range | Use |
|------|---------|-------------|-----|
| `normalized` (default) | divided by sum | [0, 1] | production |
| `raw` | used as-is | [0, ∞) | debugging, A/B experiments |

```ts
// Production (default):
computeScore(m, meta, { namespace, requestedAt: Date.now() })

// Debug / experiment:
computeScore(m, meta, { namespace, requestedAt: Date.now(), mode: "raw" })
```

---

## Observability
Every forwarded response includes `_mesh`:

```json
{
  "_mesh": {
    "origin": "http://localhost:8282",
    "monad_id": "cli:frank",
    "monad_name": "frank",
    "reason": "mesh-claim",
    "selector": "device:macbook",
    "hops": 1,
    "forwardedAt": 1746412800000
  }
}
```

To see why a specific monad won, read its claim meta directly:

```bash
curl http://localhost:8161/.mesh/resolve?monad=frank
# → MonadIndexEntry with all fields

# Claim meta lives in the .me kernel (not exposed via HTTP yet)
```

---

## Introspection
`computeScoreDetailed` is the primary implementation. `computeScore` delegates to it.

```ts
const { total, mode, breakdown } = computeScoreDetailed(m, meta, ctx);

// breakdown per scorer:
// {
//   recency:   { value: 0.99, weight: 0.35, contribution: 0.347 },
//   resonance: { value: 0.80, weight: 0.40, contribution: 0.320 },
//   latency:   { value: 0.95, weight: 0.25, contribution: 0.238 }
// }
```

`MeshSelection` (returned by `selectMeshClaimant`) always carries `score`, `breakdown`, and `runnerUp` for `mesh-claim` results when more than one claimant exists. The entire top-2 is captured in the same O(N) pass — no second read.

```ts
const r = await selectMeshClaimant({ ... });
// r.score      → number (total)
// r.breakdown  → ScoreBreakdown with per-scorer contributions
// r.runnerUp   → { entry, score, breakdown } | undefined
```

**Winner/runner-up diff** — the margin between the winner and the next best node. A tight margin (< 0.05) suggests the selection is fragile; a wide margin suggests a clear winner.

```ts
if (r.runnerUp) {
  const margin = r.score - r.runnerUp.score;
  // margin near 0 → nearly tied; may flip on next request if learning loop updates
}
```

---

## Logging and sampling
Two env vars control scoring output:
| Var | Default | Effect |
|-----|---------|--------|
| `MONAD_DEBUG_SCORING=1` | off | Logs every forwarded request |
| `MONAD_SCORE_SAMPLE_RATE=0.01` | 0 | Logs ~1% of requests randomly |
Log format (structured JSON, one line per forward):

```bash
MONAD_DEBUG_SCORING=1 npm run dev
# [scoring] {
#   "winner":  { "monad_id": "frank", "score": 0.847, "breakdown": {...} },
#   "runnerUp": { "monad_id": "alice", "score": 0.801 },
#   "margin":  0.046
# }
```

`score` is also included in every forwarded `_mesh` response field.

---

## Decision log (Phase 5.6)
`decisionLog.ts` — correlates each mesh-claim selection with its actual outcome.
Every forwarded request produces a `DecisionEntry` written to JSONL when `MONAD_DECISION_LOG` is set:

```json
{
  "decisionId": "1746412800000:frank",
  "timestamp": 1746412800000,
  "namespace": "suis-macbook-air.local",
  "monadId": "frank",
  "score": 0.847,
  "margin": 0.046,
  "breakdown": { "recency": {...}, "resonance": {...}, "latency": {...} },
  "runnerUp": { "monad_id": "alice", "score": 0.801 },
  "outcome": "success",
  "latencyMs": 42,
  "reward": 0.9916
}
```

`outcome` and `latencyMs` are added by `correlateOutcome`, called after every `recordForwardResult`. Uncorrelated entries (where the request crashed before the bridge recorded the result) have no `outcome` field and are excluded from analysis.

**Env vars:**

| Var | Effect |
|-----|--------|
| `MONAD_DECISION_LOG=/path/to/decisions.jsonl` | Enable log. No-op if unset. |
| `MONAD_DEBUG_SCORING=1` | Log every decision to console |
| `MONAD_SCORE_SAMPLE_RATE=0.01` | Sample ~1% to console |
| `MONAD_SCORE_MARGIN_THRESHOLD=0.05` | Always log fragile decisions (default: 0.05) |
| `MONAD_EXPLORATION_RATE=0.15` | Explore runner-up for ~15% of fragile decisions |

**Biased sampling** — fragile decisions (margin < threshold) are always logged regardless of sample rate. Non-fragile decisions are logged only by `MONAD_DEBUG_SCORING` or probabilistic sampling.

---

## Offline analyzer

```bash
tsx scripts/analyze-decisions.ts ~/.monad/decisions.jsonl
```

Output sections:
1. **Outcome breakdown** — success/failure counts and rates
2. **Scorer contribution by outcome** — mean contribution per scorer for successful vs failed decisions. Negative delta → that scorer is weaker on failures and may need its weight reduced.
3. **Margin distribution** — what fraction of decisions are fragile, and how success rate differs between fragile and normal decisions.
4. **Runner-up on failure** — how often there was an alternative when the winner failed, and the average margin in those cases. A low margin here means failures were nearly-tied decisions, not overconfident ones.
5. **Latency** — average latency on successful vs failed forwards.

---

## Continuous reward signal

Every correlated decision carries a `reward` field computed from two signals:

```
rewardQuality = ok ? 1.0 : −1.0
rewardLatency = ok ? max(0, 1 − latencyMs / 5000) : 0

reward = qualityWeight × rewardQuality + (1 − qualityWeight) × rewardLatency
```

Default `qualityWeight = 0.7` (set via `MONAD_LEARNING_QUALITY_WEIGHT`):

| Outcome | Latency | reward |
|---------|---------|--------|
| success | 0 ms    | 1.000  |
| success | 2 500 ms | 0.850 |
| success | 5 000 ms | 0.700 |
| success | > 5 000 ms | 0.700 (floor — quality term dominates) |
| failure | any     | −0.700 |

Failures penalize at −0.7 (not the old −0.3) so correctness errors drive weight shifts more decisively than latency variance. The range is `[−0.7, 1.0]` at default quality weight.

The `reward` field in `DecisionEntry` is the input to `updateAdaptiveWeights`.

---

## Epsilon-greedy exploration
When a decision is fragile (margin < 0.05) and `MONAD_EXPLORATION_RATE > 0`, the runner-up is selected instead of the winner with probability `explorationRate`. The returned `MeshSelection` has `reason = "exploration"` and the original winner appears as `runnerUp`.

```bash
MONAD_EXPLORATION_RATE=0.15 npm run dev
# 15% of fragile decisions route to the runner-up instead of the top scorer
```

Exploration only fires when there is a runner-up (requires ≥ 2 claimants) and the margin is below threshold. High-margin decisions are never explored — they are cheap to predict correctly.

**Why this matters:** a fragile decision will flip on the next learning loop update anyway. Routing to the runner-up occasionally generates comparative outcome data — the learning loop then receives signal for both candidates rather than only the winner.

---

## Overconfidence detection
The offline analyzer flags **high-confidence failures** — decisions where `margin ≥ 0.20` but the forward still failed:

```
── Overconfidence (margin ≥ 0.2 + failure) ─────────
  high-confidence failures : 1 / 3  (33.3%)
  ❗ system was certain but wrong — scorer bias likely
```

Interpretation:
- `margin < 0.05` + failure → expected noise, the system was nearly tied. Consider exploration.
- `margin ≥ 0.20` + failure → real scorer bias. One or more scorers are weighting the wrong dimension. Inspect the scorer delta table for which dimension drops most on failures.

---

## Adaptive scoring (Phase 7/9 — implemented)

`adaptiveWeights.ts` — online gradient-style weight updates, persisted in global and namespace-local stores:

```txt
_.mesh.adaptiveWeights          ← global prior
_.mesh.nsWeights.<namespace>    ← namespace-local posterior
```

**Update rule:**

```
Δweight = α × reward × contribution
new_weight = max(WEIGHT_MIN, old_weight + Δweight)
```

Constants: `α (LEARNING_RATE) = 0.01`, `WEIGHT_MIN = 0.01`.

**Weight resolution priority** (highest first):

| Priority | Source | Notes |
|----------|--------|-------|
| 1 | `meta._weight_<name>` | Per-claim explicit override |
| 2 | `ctx.adaptiveWeights[name]` | Pre-blended global/namespace adaptive weight |
| 3 | `scorer.defaultWeight` | Hardcoded fallback |

Learned weights are resolved once per request by `resolveAdaptiveWeights(namespace)` and injected into `ScoringContext.adaptiveWeights` before the claimant scoring loop. The hot path does **one blended lookup per request**, not one lookup per claimant.

**Attribution scope:** rewards are split between the global prior and the namespace-local store:

```ts
const maturity = Math.min(1, sampleCount / 200);
const globalShare = Math.max(0.05, 1 - maturity);
const nsShare = maturity;

applyDelta(global, delta * globalShare);
applyDelta(namespace, delta * nsShare);
```

The first samples mostly update the global prior. As the namespace gains evidence, local weights receive more of the gradient. At 140 samples, the read-side blend is naturally 70% namespace / 30% global. At 200+ samples, selection is fully namespace-local while global still receives 5% background signal.

---

## Weight observability

```bash
# Live endpoint — returns current weights + delta from defaults + health signals:
curl http://localhost:8161/.mesh/weights

# Namespace view — includes sampleCount, maturity, namespace weights, and blend:
curl "http://localhost:8161/.mesh/weights?namespace=suis-macbook-air.local"
```

```json
{
  "ok": true,
  "current":  { "latency": 0.228, "recency": 0.351, "resonance": 0.421 },
  "defaults": { "latency": 0.250, "recency": 0.350, "resonance": 0.400 },
  "delta":    { "latency": -0.022, "recency": 0.001, "resonance": 0.021 },
  "updateCount": 142,
  "lastUpdatedAt": 1746412800000,
  "stable": false,
  "health": {
    "dominantScorer": null,
    "deadScorer":     null,
    "oscillation":    false,
    "noLearning":     false
  },
  "namespace": {
    "namespace": "suis-macbook-air.local",
    "sampleCount": 140,
    "maturity": 0.7,
    "current": { "latency": 0.231, "recency": 0.352, "resonance": 0.438 },
    "delta": { "latency": -0.019, "recency": 0.002, "resonance": 0.038 },
    "blended": { "latency": 0.232, "recency": 0.352, "resonance": 0.433 }
  }
}
```

`stable = true` when all deltas are within 5% of the default weight — signals the system has not yet learned much.

**Health signals** (`health` object):
| Signal | Fires when | Interpretation |
|--------|-----------|----------------|
| `dominantScorer` | one scorer > 70% of total weight | May be correct or over-fitted — check scorer delta table |
| `deadScorer` | a scorer weight near `WEIGHT_MIN` (0.01) | Scorer effectively excluded — consider per-claim override |
| `oscillation` | > 40% sign changes in last 10 rewards | Contradictory signal — check exploration rate and node stability |
| `noLearning` | 10+ updates, max delta < 0.002 | Zero contributions reaching the loop — check bridge integration |

```bash
# Per-update console log:
MONAD_DEBUG_WEIGHTS=1 npm run dev
# [weights] latency: 0.228 (Δ-0.022), recency: 0.351 (Δ+0.001), resonance: 0.421 (Δ+0.021) — updates: 142 reward: 0.850

# Live polling monitor (colored table + health warnings):
tsx scripts/watch-weights.ts
tsx scripts/watch-weights.ts --port 8282 --interval 3000
tsx scripts/watch-weights.ts --namespace suis-macbook-air.local
```

For full observability documentation and remediation guidance see [learning-observability.md](./learning-observability.md).

**All env vars (complete list):**

| Var | Default | Effect |
|-----|---------|--------|
| `MONAD_DEBUG_SCORING=1` | off | Log every scoring decision to console |
| `MONAD_SCORE_SAMPLE_RATE=0.01` | 0 | Sample ~1% of decisions to console |
| `MONAD_SCORE_MARGIN_THRESHOLD=0.05` | 0.05 | Force-log fragile decisions |
| `MONAD_EXPLORATION_RATE=0.15` | 0 | Explore runner-up in ~15% of fragile decisions |
| `MONAD_DECISION_LOG=/path/decisions.jsonl` | unset | Enable JSONL decision log |
| `MONAD_LEARNING_QUALITY_WEIGHT=0.7` | 0.7 | Quality vs latency blend in reward |
| `MONAD_DEBUG_WEIGHTS=1` | off | Log weight update after every forward |
| `MONAD_MESH_STALE_MS=300000` | 300000 | Staleness cutoff for claimants |

---

## Phase 9 — namespace-maturity blending (implemented)

Graduated transition from global prior to per-namespace weights, controlled by sample count:

```typescript
const maturity = Math.min(1, nsSamples / 200);
selectionWeights = global * (1 - maturity) + namespace * maturity;

// Learning attribution: shared gradient, split by maturity
applyDelta(global,    delta * Math.max(0.05, 1 - maturity));
applyDelta(namespace, delta * maturity);
```

- `samples = 0`   → 100% global selection, 100% global learning
- `samples = 100`  → 50% blend; namespace learning accelerates
- `samples = 200+` → 100% namespace selection; global still receives 5% background signal
- Global is never turned off — cross-namespace trends (e.g., latency universally predicting failures) must still reach the prior.
