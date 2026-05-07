[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / recordDecision

# Function: recordDecision()

> **recordDecision**(`entry`): `void`

Defined in: [kernel/decisionLog.ts:37](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/decisionLog.ts#L37)

Stores a decision snapshot until the bridge knows the outcome.

This is intentionally in-memory and best-effort. Durable output happens only
after `correlateOutcome`, when success/failure and latency are known.

## Parameters

### entry

`Omit`\<[`DecisionEntry`](../type-aliases/DecisionEntry.md), `"outcome"` \| `"latencyMs"` \| `"reward"`\>

## Returns

`void`
