# NRP Scoring Engine

`src/kernel/scoring.ts` — monad.ai v2.1+

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

## Phase 6 (planned)

- Pipeline defined in `.me` (`_.scoring.pipeline = ["recency", "resonance", "geo"]`)
- Per-context weight profiles (`_.scoring.contextWeights.realtime.latency = 0.8`)
- Auto-tuning via A/B score comparison
