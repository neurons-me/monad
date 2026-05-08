[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / updateAdaptiveWeights

# Function: updateAdaptiveWeights()

> **updateAdaptiveWeights**(`reward`, `breakdown`, `optionsOrLearningRate?`): `void`

Defined in: [kernel/adaptiveWeights.ts:366](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/adaptiveWeights.ts#L366)

Applies one online gradient step to the globally learned weights.

```
Δweight = learningRate × reward × contribution
```

Scorers with high contribution to a good outcome get heavier; scorers
that pushed a bad decision get lighter. The update is idempotent with
respect to sign: a series of failures will keep driving a weight toward
`WEIGHT_MIN` but can never push it below that floor.

NaN and zero rewards are ignored (no-ops).

## Parameters

### reward

`number`

Continuous reward signal in [−1, 1]; from [correlateOutcome](correlateOutcome.md).

### breakdown

`Record`\<`string`, [`ScorerBreakdown`](../type-aliases/ScorerBreakdown.md)\>

Per-scorer contributions from the decision being evaluated.

### optionsOrLearningRate?

`number` \| [`AdaptiveWeightUpdateOptions`](../type-aliases/AdaptiveWeightUpdateOptions.md)

Either a legacy numeric learning rate, or an
options object with `namespace` and/or `learningRate`.

## Returns

`void`
