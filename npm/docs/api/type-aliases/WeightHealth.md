[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / WeightHealth

# Type Alias: WeightHealth

> **WeightHealth** = `object`

Defined in: [kernel/adaptiveWeights.ts:51](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/adaptiveWeights.ts#L51)

Runtime health signals for the adaptive learning loop.

These are diagnostic, not prescriptive — they surface conditions that
warrant attention, not automatic corrections. All four can be false
simultaneously on a healthy, well-calibrated system.

## Properties

### deadScorer

> **deadScorer**: `string` \| `null`

Defined in: [kernel/adaptiveWeights.ts:74](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/adaptiveWeights.ts#L74)

Name of a scorer whose weight has dropped near the `WEIGHT_MIN` floor.

A dead scorer is effectively not participating in selection. If the
scorer encodes a signal that should matter (e.g., latency for a
latency-sensitive workload), the learning loop may have over-penalized
it from early failures. Consider raising its per-claim `_weight_<name>`
override to inject a floor above `WEIGHT_MIN`.

`null` if no scorer is near the floor.

***

### dominantScorer

> **dominantScorer**: `string` \| `null`

Defined in: [kernel/adaptiveWeights.ts:62](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/adaptiveWeights.ts#L62)

Name of a scorer that has captured more than 70% of total weight.

A dominant scorer means the other signals are largely ignored. This may
be correct (e.g., resonance is genuinely the best predictor) or a sign
of overfitting to a narrow workload. Inspect the scorer delta table in
the offline analyzer to distinguish the two.

`null` if no scorer exceeds the threshold.

***

### noLearning

> **noLearning**: `boolean`

Defined in: [kernel/adaptiveWeights.ts:93](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/adaptiveWeights.ts#L93)

True when 10 or more updates have been applied but no weight has moved
more than 0.002 from its default.

Possible causes: all requests are going to name-selector monads (no
mesh-claim decisions), zero-contribution breakdowns (scorer values are
all zero), or the bridge is not calling `correlateOutcome`. Check that
`MONAD_DEBUG_WEIGHTS=1` shows updates after forwarded requests.

***

### oscillation

> **oscillation**: `boolean`

Defined in: [kernel/adaptiveWeights.ts:83](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/adaptiveWeights.ts#L83)

True when the recent reward signal alternates sign frequently.

Computed over the last 10 rewards: if more than 40% of consecutive
pairs change sign, the learning loop is receiving contradictory signal.
Common causes: two claimants with similar scores and opposite reliability
profiles, or an exploration rate that is too high for the current mesh size.
