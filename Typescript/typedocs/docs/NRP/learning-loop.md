# NRP Learning Loop — Complete Guide
`src/kernel/` — monad.ai v2.1+

---

## What is the learning loop?

When monad.ai routes a request to another node in your mesh, it makes a decision: **which node should answer this request?**

The learning loop is how the system gets better at making that decision over time.

Here is the simplest way to think about it:

> **The system watches what happens after every routing decision it makes. If the result was good, it learns to make similar decisions more often. If the result was bad, it learns to avoid them.**

No human intervention is required. The system learns by itself, one request at a time.

---

## The three numbers that control everything

At the core of the routing decision are three **scorer weights**. Think of them as dials on a mixing board — each one controls how much a particular signal influences the routing choice.

| Scorer | Default weight | What it measures |
|--------|---------------|-----------------|
| `resonance` | 0.40 (40%) | How many times this node has answered successfully in the past |
| `recency` | 0.35 (35%) | How recently this node checked in (is it still alive?) |
| `latency` | 0.25 (25%) | How fast this node responds on average |

These weights start at their defaults. As the system processes requests, it nudges the weights based on what it observes. A node that consistently responds fast and correctly will see `latency` and `resonance` increase. A node that times out will see those weights decrease.

The weights are stored in the kernel at `_.mesh.adaptiveWeights` and shared across all routing decisions.

---

## How a routing decision is made (step by step)

Suppose two nodes can answer your request: **alice** and **bob**.

**Step 1 — Score each candidate**

For each node, the system computes a score between 0 and 1:

```
alice_score = (recency_value × recency_weight)
            + (resonance_value × resonance_weight)
            + (latency_value × latency_weight)
```

```
alice_score = (0.99 × 0.35) + (0.80 × 0.40) + (0.90 × 0.25)
            = 0.347 + 0.320 + 0.225
            = 0.892
```

```
bob_score   = (0.80 × 0.35) + (0.60 × 0.40) + (0.70 × 0.25)
            = 0.280 + 0.240 + 0.175
            = 0.695
```

**Step 2 — Pick the winner**

Alice wins with score 0.892 vs Bob's 0.695. The margin is 0.197 (a comfortable gap — not a fragile decision).

**Step 3 — Record the decision**

Before forwarding the request, the system saves a snapshot:

```json
{
  "decisionId": "1746412800000:alice",
  "monadId": "alice",
  "score": 0.892,
  "margin": 0.197,
  "breakdown": {
    "resonance": { "value": 0.80, "weight": 0.40, "contribution": 0.320 },
    "recency":   { "value": 0.99, "weight": 0.35, "contribution": 0.347 },
    "latency":   { "value": 0.90, "weight": 0.25, "contribution": 0.225 }
  }
}
```

The `contribution` field is critical — it tells the learning loop **how much each scorer influenced this specific decision**.

**Step 4 — Forward the request and wait**

The HTTP request is sent to alice. The bridge waits for a response.

**Step 5 — Record the outcome and update weights**

Once alice responds (or times out), the bridge calls `correlateOutcome`:

```ts
correlateOutcome("1746412800000:alice", 42, true); // 42ms, success
```

The system then:
1. Computes a **reward** from the outcome
2. Updates each scorer weight using that reward

---

## The reward formula

The reward converts a request outcome into a single number that tells the system how good the decision was.

```
reward = qualityWeight × rewardQuality
       + (1 - qualityWeight) × rewardLatency
```

Where:
- `qualityWeight = 0.7` — success/failure matters 70% of the time; speed matters 30%
- `rewardQuality = success ? +1.0 : −1.0`
- `rewardLatency = success ? max(0, 1 − latencyMs / 5000) : 0`

**Concrete examples:**

| Outcome | Latency | reward | Explanation |
|---------|---------|--------|-------------|
| success | 0 ms    | **+1.000** | Perfect: fast and correct |
| success | 1000 ms | **+0.760** | Good: correct, a bit slow |
| success | 2500 ms | **+0.850** | Wait — slower, still positive |
| success | 5000 ms | **+0.700** | Just quality signal, no latency bonus |
| success | 10000 ms| **+0.700** | Same as 5000ms — floor kicks in |
| failure | any     | **−0.700** | Incorrect response — always penalized |

Notice that **failures always produce reward = −0.700**, regardless of latency. This is intentional: we don't want the system to optimize for speed at the expense of correctness.

The `0.7` quality weight is configurable:
```bash
MONAD_LEARNING_QUALITY_WEIGHT=0.9  # care 90% about correctness, 10% about speed
```

---

## The weight update formula

After computing the reward, the system updates each scorer weight:

```
Δweight = α × reward × contribution
new_weight = max(WEIGHT_MIN, old_weight + Δweight)
```

Where:
- `α (LEARNING_RATE) = 0.01` — a small step size to keep learning smooth
- `WEIGHT_MIN = 0.01` — no scorer can fall below 1% influence
- `contribution` — how much this scorer pushed the routing decision

**Example — alice succeeds in 42ms:**

```
reward = 0.7 × 1.0 + 0.3 × (1 − 42/5000) = 0.7 + 0.2975 ≈ 0.997

Δresonance = 0.01 × 0.997 × 0.320 = +0.00319  → resonance: 0.40 → 0.403
Δrecency   = 0.01 × 0.997 × 0.347 = +0.00346  → recency:   0.35 → 0.353
Δlatency   = 0.01 × 0.997 × 0.225 = +0.00224  → latency:   0.25 → 0.252
```

All three scorers that contributed to choosing alice get a small boost.

**Example — alice fails:**

```
reward = 0.7 × (−1.0) + 0 = −0.700

Δresonance = 0.01 × (−0.700) × 0.320 = −0.00224  → resonance: 0.40 → 0.398
Δrecency   = 0.01 × (−0.700) × 0.347 = −0.00243  → recency:   0.35 → 0.348
Δlatency   = 0.01 × (−0.700) × 0.225 = −0.00158  → latency:   0.25 → 0.248
```

All three scorers get a small reduction.

**Why such tiny steps?**

`α = 0.01` means a single outcome barely moves the weights. This is intentional:
- One bad result shouldn't undo good routing history
- The system needs to see consistent patterns before it changes behavior significantly
- It takes ~100 requests before the weights shift noticeably from their defaults

---

## Where the weights are stored

Global weights live in the kernel at `_.mesh.adaptiveWeights`:

```
_.mesh.adaptiveWeights = {
  latency:   0.228,
  recency:   0.351,
  resonance: 0.421,
  _meta: {
    lastUpdatedAt: 1746412800000,
    updateCount:   142,
    rewardHistory: [0.997, -0.700, 0.850, 0.700, ...]
  }
}
```

Namespace-local weights live under `_.mesh.nsWeights.<namespace>` and share the same shape:

```ts
_.mesh.nsWeights.suis-macbook-air.local = {
  latency:   0.231,
  recency:   0.352,
  resonance: 0.438,
  _meta: {
    sampleCount: 140,
    lastUpdatedAt: 1746412800000,
    updateCount: 140,
    rewardHistory: [0.997, 0.850, -0.700, ...]
  }
}
```

Reads blend global and namespace weights by maturity:

```ts
maturity = min(1, sampleCount / 200)
weights = global * (1 - maturity) + namespace * maturity
```

The `_meta` fields are internal. The weight keys are readable and writable from anywhere in the kernel tree.

---

## How to observe learning in real time

### Option 1 — Live terminal monitor

```bash
tsx scripts/watch-weights.ts
tsx scripts/watch-weights.ts --port 8282 --interval 3000
tsx scripts/watch-weights.ts --namespace suis-macbook-air.local
```

This polls `GET /.mesh/weights` every 2 seconds and shows a color-coded table:

```
NRP Adaptive Weights  2026-05-05T23:00:00.000Z
http://localhost:8161/.mesh/weights  updates: 142  stable: false

Scorer       Current    Default    Delta
───────────────────────────────────────────────
latency      0.2280     0.2500     -0.0220
recency      0.3510     0.3500     +0.0010
resonance    0.4210     0.4000     +0.0210

last update: 3s ago
✓  learning loop healthy
```

- **Green delta** = scorer is being reinforced (associated with successes)
- **Red delta** = scorer is being penalized (associated with failures)
- **Dim delta** = barely moved (< 0.002 from default)

### Option 2 — HTTP endpoint

```bash
curl http://localhost:8161/.mesh/weights | jq
```

```json
{
  "ok": true,
  "current":  { "latency": 0.228, "recency": 0.351, "resonance": 0.421 },
  "defaults": { "latency": 0.250, "recency": 0.350, "resonance": 0.400 },
  "delta":    { "latency": -0.022, "recency": 0.001, "resonance": 0.021 },
  "updateCount": 142,
  "stable": false,
  "health": {
    "dominantScorer": null,
    "deadScorer":     null,
    "oscillation":    false,
    "noLearning":     false
  }
}
```

### Option 3 — Console log after every request

```bash
MONAD_DEBUG_WEIGHTS=1 npm run dev
# [weights] latency: 0.228 (Δ-0.022), recency: 0.351 (Δ+0.001), resonance: 0.421 (Δ+0.021) — updates: 142 reward: 0.997
```

---

## Running the smoke tests

The smoke tests in `tests/NRP/learningLoop.test.ts` verify the complete learning pipeline without requiring a live server. They are organized into 7 sections:

```bash
# Run only the learning loop tests:
npx vitest run tests/NRP/learningLoop.test.ts

# Run all NRP tests:
npx vitest run tests/NRP/
```

**What each section proves:**

| Section | What it verifies |
|---------|-----------------|
| 1 — Gradient step formula | The math: `Δw = α × reward × contribution` is exact |
| 2 — Weight boundaries | `WEIGHT_MIN` floor is enforced; recovery from floor works |
| 3 — updateCount accounting | Exact count of applied updates |
| 4 — Reward formula | Each latency/outcome combination produces the documented reward |
| 5 — Full pipeline | `recordDecision → correlateOutcome → weight shift` works end-to-end |
| 6 — Convergence | Repeated signals accumulate correctly; direction matches theory |
| 7 — Health signals | `noLearning` and `oscillation` fire at the right time |

**How to interpret a failure:**

If section 4 fails: the reward formula in `decisionLog.ts` does not match the documented formula.

If section 5 fails: the pipeline connection between `correlateOutcome` and `updateAdaptiveWeights` is broken.

If section 6 fails: the cumulative update math has a bug (likely off-by-one or incorrect floor enforcement).

---

## What "healthy" learning looks like

After generating 50–200 requests through a real mesh:

| Signal | Healthy value | What it means |
|--------|--------------|---------------|
| `updateCount` | Rising steadily | Outcomes are being correlated |
| `stable` | `false` | Weights have moved from their defaults |
| `delta.resonance` | Small positive | Nodes with history are being preferred |
| `delta.recency` | Near zero | Recency is behaving as a tiebreaker |
| `delta.latency` | Slightly negative | Faster nodes are slightly preferred |
| `health.noLearning` | `false` | Contributions are non-zero |
| `health.oscillation` | `false` | Signal is consistent, not alternating |
| `health.dominantScorer` | `null` | No single scorer has captured everything |
| `health.deadScorer` | `null` | All scorers still have meaningful influence |

---

## Common problems and what they mean

### `updateCount` is not rising

The bridge is not calling `correlateOutcome`. Check `bridgeHandler.ts` — the `if (decisionId)` guard requires the selection to have been a `mesh-claim` or `exploration`. If all requests are going to name-selector monads, no learning happens because there is no scoring decision to learn from.

### `stable = true` after 100+ requests

Either all requests went through name-selector (no scores computed), or the breakdown contributions are all zero (all scorer values are near zero — freshly registered nodes with no history). Wait for nodes to accumulate some history.

### `health.noLearning = true`

The update loop is running but weights are not moving. Most likely: all claimants have the same score, so contributions are near zero. Verify with `MONAD_DEBUG_SCORING=1` that the scoring is producing non-trivial values.

### `health.oscillation = true`

The reward signal is alternating between positive and negative. Usually means two nodes are closely matched but inconsistently reliable. Consider reducing `MONAD_EXPLORATION_RATE` to stop force-routing to the runner-up, or waiting for the resonance signal to separate the two nodes.

### A scorer hits `WEIGHT_MIN` (dead scorer)

Something caused that scorer to be consistently associated with failures. Either the scorer's signal is genuinely irrelevant for your workload (correct behavior), or there was an early burst of failures that over-penalized it (bad luck). Use a per-claim weight override to give it a floor:

```ts
_.mesh.monads.frank.claimed["your.namespace"]._weight_latency = 0.15
```

---

## The patch bay (extending the signal set)

The three built-in scorers can be extended with custom **feature combinations** using the patch bay:

```ts
import { registerPatch } from "./src/kernel/patchBay.js";

// AND: both latency and resonance must be high
registerPatch({ inputs: ["latency", "resonance"], op: "multiply", out: "lat_res" });

// GATE: only use resonance if the node is fresh
registerPatch({ inputs: ["recency", "resonance"], op: "gate", params: { threshold: 0.5 } });
```

Patch scorers receive adaptive weights automatically. The learning loop will raise their weight if the combination predicts success, and lower it toward `WEIGHT_MIN` if it is noise. See [scoring.md](./scoring.md#patch-bay--declarative-feature-composition) for the full reference.

---

## Architecture summary

```
┌─────────────────────────────────────────────────────────────────┐
│                         Patch Bay                               │
│  registerPatch({ inputs: ["latency","recency"], op: "multiply"})│
│  → stored in _.mesh.patchBay (free kernel subtree)             │
└────────────────────────────┬────────────────────────────────────┘
                             │ getPatchScorers(BUILT_IN_SCORERS)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Scorer Registry                            │
│  Built-ins: latency (0.25), recency (0.35), resonance (0.40)   │
│  + patch scorers with defaultWeight=0.10                        │
└────────────────────────────┬────────────────────────────────────┘
                             │ computeScoreDetailed()
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Scoring Engine                              │
│  score = Σ(weight_i × value_i)    [normalized, always ∈ [0,1]] │
│  Reads adaptiveWeights from ctx for learned weight overrides    │
└────────────────────────────┬────────────────────────────────────┘
                             │ best score wins
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                  MeshSelection + recordDecision                 │
│  Saves breakdown snapshot for correlation                       │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP forward
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                  correlateOutcome(id, ms, ok)                   │
│  Computes reward = 0.7 × quality + 0.3 × latency               │
│  Calls updateAdaptiveWeights(reward, breakdown)                 │
└────────────────────────────┬────────────────────────────────────┘
                             │ Δw = α × reward × contribution
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                  _.mesh.adaptiveWeights                         │
│  { latency, recency, resonance, ...patch_scorers, _meta }       │
│  Persists across requests — read on every selectMeshClaimant    │
└─────────────────────────────────────────────────────────────────┘
```
