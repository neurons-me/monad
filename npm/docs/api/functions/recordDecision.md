[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / recordDecision

# Function: recordDecision()

> **recordDecision**(`entry`): `void`

Defined in: [kernel/decisionLog.ts:37](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/decisionLog.ts#L37)

Stores a decision snapshot until the bridge knows the outcome.

This is intentionally in-memory and best-effort. Durable output happens only
after `correlateOutcome`, when success/failure and latency are known.

## Parameters

### entry

`Omit`\<[`DecisionEntry`](../type-aliases/DecisionEntry.md), `"outcome"` \| `"latencyMs"` \| `"reward"`\>

## Returns

`void`
