[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / DecisionEntry

# Type Alias: DecisionEntry

> **DecisionEntry** = `object`

Defined in: kernel/decisionLog.ts:13

One correlated scoring decision, suitable for JSONL logging and offline
analysis.

`decisionId` is the primary correlation key and is unique per forwarded
request. `reward` is continuous: fast success approaches `1.0`, slow
success approaches `0.7`, and failure is `-0.7`.

## Properties

### breakdown

> **breakdown**: `Record`\<`string`, [`ScorerBreakdown`](ScorerBreakdown.md)\>

Defined in: kernel/decisionLog.ts:20

***

### decisionId

> **decisionId**: `string`

Defined in: kernel/decisionLog.ts:14

***

### latencyMs?

> `optional` **latencyMs?**: `number`

Defined in: kernel/decisionLog.ts:23

***

### margin

> **margin**: `number`

Defined in: kernel/decisionLog.ts:19

***

### monadId

> **monadId**: `string`

Defined in: kernel/decisionLog.ts:17

***

### namespace

> **namespace**: `string`

Defined in: kernel/decisionLog.ts:16

***

### outcome?

> `optional` **outcome?**: `"success"` \| `"failure"`

Defined in: kernel/decisionLog.ts:22

***

### reward?

> `optional` **reward?**: `number`

Defined in: kernel/decisionLog.ts:26

***

### runnerUp?

> `optional` **runnerUp?**: `object`

Defined in: kernel/decisionLog.ts:21

#### monad\_id

> **monad\_id**: `string`

#### score

> **score**: `number`

***

### score

> **score**: `number`

Defined in: kernel/decisionLog.ts:18

***

### timestamp

> **timestamp**: `number`

Defined in: kernel/decisionLog.ts:15
