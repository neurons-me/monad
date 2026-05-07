[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / computeScore

# Function: computeScore()

> **computeScore**(`m`, `meta`, `ctx`, `extraScorers?`): `number`

Defined in: [kernel/scoring.ts:241](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/kernel/scoring.ts#L241)

Computes only the normalized score for a claimant.

Use [computeScoreDetailed](computeScoreDetailed.md) when debugging or logging why a monad won.

## Parameters

### m

[`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)

### meta

[`ClaimMeta`](../type-aliases/ClaimMeta.md)

### ctx

[`ScoringContext`](../type-aliases/ScoringContext.md)

### extraScorers?

[`Scorer`](../type-aliases/Scorer.md)[] = `[]`

## Returns

`number`
