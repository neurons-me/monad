[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / Scorer

# Type Alias: Scorer

> **Scorer** = `object`

Defined in: [kernel/scoring.ts:56](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/kernel/scoring.ts#L56)

A pluggable scorer in the mesh decision pipeline.

Scorers should return a value in `[0, 1]`. The engine clamps invalid or
out-of-range values, so custom scorers cannot corrupt normalized mode.

## Properties

### defaultWeight

> **defaultWeight**: `number`

Defined in: [kernel/scoring.ts:58](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/kernel/scoring.ts#L58)

***

### fn

> **fn**: (`m`, `meta`, `ctx`) => `number`

Defined in: [kernel/scoring.ts:59](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/kernel/scoring.ts#L59)

#### Parameters

##### m

[`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)

##### meta

[`ClaimMeta`](ClaimMeta.md)

##### ctx

[`ScoringContext`](ScoringContext.md)

#### Returns

`number`

***

### name

> **name**: `string`

Defined in: [kernel/scoring.ts:57](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/kernel/scoring.ts#L57)
