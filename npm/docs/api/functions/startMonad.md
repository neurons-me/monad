[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / startMonad

# Function: startMonad()

> **startMonad**(`options?`): `Promise`\<[`StartMonadResult`](../interfaces/StartMonadResult.md)\>

Defined in: [index.ts:98](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/index.ts#L98)

Boots the monad runtime, creates the Express app, starts listening, and
schedules the local monad heartbeat.

## Parameters

### options?

[`StartMonadOptions`](../interfaces/StartMonadOptions.md) = `{}`

## Returns

`Promise`\<[`StartMonadResult`](../interfaces/StartMonadResult.md)\>
