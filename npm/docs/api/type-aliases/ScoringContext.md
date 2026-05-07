[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / ScoringContext

# Type Alias: ScoringContext

> **ScoringContext** = `object`

Defined in: [kernel/scoring.ts:31](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/kernel/scoring.ts#L31)

Per-request context supplied to scoring.

`namespace` and `requestedAt` make scoring deterministic for a request. Future
scorers may also use `pathPrefix` for workload-specific policy.

## Properties

### adaptiveWeights?

> `optional` **adaptiveWeights?**: `Record`\<`string`, `number`\>

Defined in: [kernel/scoring.ts:47](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/kernel/scoring.ts#L47)

Globally learned scorer weights (Phase 7).

Injected by `selectMeshClaimant` from `_.mesh.adaptiveWeights`. Overrides
`scorer.defaultWeight` but yields to per-claim `_weight_<name>` values.

Weight resolution order (highest priority first):
  1. `meta._weight_<name>` — per-claim explicit override
  2. `ctx.adaptiveWeights[name]` — this field (online-learned prior)
  3. `scorer.defaultWeight` — hardcoded fallback

***

### mode?

> `optional` **mode?**: [`ScoringMode`](ScoringMode.md)

Defined in: [kernel/scoring.ts:35](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/kernel/scoring.ts#L35)

***

### namespace

> **namespace**: `string`

Defined in: [kernel/scoring.ts:32](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/kernel/scoring.ts#L32)

***

### pathPrefix?

> `optional` **pathPrefix?**: `string`

Defined in: [kernel/scoring.ts:34](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/kernel/scoring.ts#L34)

***

### requestedAt

> **requestedAt**: `number`

Defined in: [kernel/scoring.ts:33](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/kernel/scoring.ts#L33)
