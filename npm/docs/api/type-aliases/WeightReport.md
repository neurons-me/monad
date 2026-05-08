[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / WeightReport

# Type Alias: WeightReport

> **WeightReport** = `object`

Defined in: [kernel/adaptiveWeights.ts:101](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/adaptiveWeights.ts#L101)

A point-in-time snapshot of learned scorer weights with change context.

Returned by [getWeightReport](../functions/getWeightReport.md) and exposed via `GET /.mesh/weights`.

## Properties

### current

> **current**: `Record`\<`string`, `number`\>

Defined in: [kernel/adaptiveWeights.ts:103](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/adaptiveWeights.ts#L103)

Current learned weights (same keys as [DEFAULT\_WEIGHTS](../variables/DEFAULT_WEIGHTS.md) plus any custom scorers).

***

### defaults

> **defaults**: `Record`\<`string`, `number`\>

Defined in: [kernel/adaptiveWeights.ts:105](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/adaptiveWeights.ts#L105)

Baseline values the system started from (hard-coded defaults).

***

### delta

> **delta**: `Record`\<`string`, `number`\>

Defined in: [kernel/adaptiveWeights.ts:107](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/adaptiveWeights.ts#L107)

`current - defaults` per scorer; positive = reinforced, negative = penalized.

***

### health

> **health**: [`WeightHealth`](WeightHealth.md)

Defined in: [kernel/adaptiveWeights.ts:121](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/adaptiveWeights.ts#L121)

Diagnostic health signals for the learning loop. See [WeightHealth](WeightHealth.md).

***

### lastUpdatedAt

> **lastUpdatedAt**: `number` \| `null`

Defined in: [kernel/adaptiveWeights.ts:111](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/adaptiveWeights.ts#L111)

Unix millisecond timestamp of the most recent weight update, or null if never updated.

***

### namespace?

> `optional` **namespace?**: `object`

Defined in: [kernel/adaptiveWeights.ts:123](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/adaptiveWeights.ts#L123)

Namespace-local report when `getWeightReport(namespace)` is requested.

#### blended

> **blended**: `Record`\<`string`, `number`\>

#### current

> **current**: `Record`\<`string`, `number`\>

#### delta

> **delta**: `Record`\<`string`, `number`\>

#### maturity

> **maturity**: `number`

#### namespace

> **namespace**: `string`

#### sampleCount

> **sampleCount**: `number`

***

### stable

> **stable**: `boolean`

Defined in: [kernel/adaptiveWeights.ts:119](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/adaptiveWeights.ts#L119)

True when no delta exceeds 5% of its default weight.

A stable system has not yet learned much, or has converged back to
near-default weights after a period of learning. Not necessarily a
problem — a homogeneous mesh naturally converges to defaults.

***

### updateCount

> **updateCount**: `number`

Defined in: [kernel/adaptiveWeights.ts:109](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/adaptiveWeights.ts#L109)

Total number of gradient steps applied since the daemon started (or since last reset).
