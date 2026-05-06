[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / correlateOutcome

# Function: correlateOutcome()

> **correlateOutcome**(`decisionId`, `latencyMs`, `ok`): `void`

Defined in: kernel/decisionLog.ts:49

Closes a pending decision with its actual request outcome.

When `MONAD_DECISION_LOG` is set, the completed decision is appended as one
JSON object per line. Missing decision IDs are ignored.

## Parameters

### decisionId

`string`

### latencyMs

`number`

### ok

`boolean`

## Returns

`void`
