[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / DecisionEntry

# Type Alias: DecisionEntry

> **DecisionEntry** = `object`

Defined in: [kernel/decisionLog.ts:13](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/decisionLog.ts#L13)

One correlated scoring decision, suitable for JSONL logging and offline
analysis.

`decisionId` is the primary correlation key and is unique per forwarded
request. `reward` is continuous: fast success approaches `1.0`, slow
success approaches `0.7`, and failure is `-0.7`.

## Properties

### breakdown

> **breakdown**: `Record`\<`string`, [`ScorerBreakdown`](ScorerBreakdown.md)\>

Defined in: [kernel/decisionLog.ts:20](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/decisionLog.ts#L20)

***

### decisionId

> **decisionId**: `string`

Defined in: [kernel/decisionLog.ts:14](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/decisionLog.ts#L14)

***

### latencyMs?

> `optional` **latencyMs?**: `number`

Defined in: [kernel/decisionLog.ts:23](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/decisionLog.ts#L23)

***

### margin

> **margin**: `number`

Defined in: [kernel/decisionLog.ts:19](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/decisionLog.ts#L19)

***

### monadId

> **monadId**: `string`

Defined in: [kernel/decisionLog.ts:17](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/decisionLog.ts#L17)

***

### namespace

> **namespace**: `string`

Defined in: [kernel/decisionLog.ts:16](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/decisionLog.ts#L16)

***

### outcome?

> `optional` **outcome?**: `"success"` \| `"failure"`

Defined in: [kernel/decisionLog.ts:22](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/decisionLog.ts#L22)

***

### reward?

> `optional` **reward?**: `number`

Defined in: [kernel/decisionLog.ts:26](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/decisionLog.ts#L26)

***

### runnerUp?

> `optional` **runnerUp?**: `object`

Defined in: [kernel/decisionLog.ts:21](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/decisionLog.ts#L21)

#### monad\_id

> **monad\_id**: `string`

#### score

> **score**: `number`

***

### score

> **score**: `number`

Defined in: [kernel/decisionLog.ts:18](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/decisionLog.ts#L18)

***

### timestamp

> **timestamp**: `number`

Defined in: [kernel/decisionLog.ts:15](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/decisionLog.ts#L15)
