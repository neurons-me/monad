[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / computeScoreDetailed

# Function: computeScoreDetailed()

> **computeScoreDetailed**(`m`, `meta`, `ctx`, `extraScorers?`): [`ScoreBreakdown`](../type-aliases/ScoreBreakdown.md)

Defined in: [kernel/scoring.ts:193](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/scoring.ts#L193)

Computes a claimant score and returns a full per-scorer explanation.

This is the primary implementation. [computeScore](computeScore.md) delegates here, so
the score and introspection path can never drift apart.

Contracts in normalized mode:
- `total` is always in `[0, 1]`
- same inputs produce the same output
- NaN/Infinity never propagate
- scaling every weight by the same constant does not change the result

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

[`ScoreBreakdown`](../type-aliases/ScoreBreakdown.md)
