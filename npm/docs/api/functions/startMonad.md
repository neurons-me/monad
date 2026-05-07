[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / startMonad

# Function: startMonad()

> **startMonad**(`options?`): `Promise`\<[`StartMonadResult`](../interfaces/StartMonadResult.md)\>

Defined in: [index.ts:98](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/index.ts#L98)

Boots the monad runtime, creates the Express app, starts listening, and
schedules the local monad heartbeat.

## Parameters

### options?

[`StartMonadOptions`](../interfaces/StartMonadOptions.md) = `{}`

## Returns

`Promise`\<[`StartMonadResult`](../interfaces/StartMonadResult.md)\>
