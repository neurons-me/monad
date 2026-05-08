[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / startMonad

# Function: startMonad()

> **startMonad**(`options?`): `Promise`\<[`StartMonadResult`](../interfaces/StartMonadResult.md)\>

Defined in: [index.ts:102](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/index.ts#L102)

Boots the monad runtime, creates the Express app, starts listening, and
schedules the local monad heartbeat.

## Parameters

### options?

[`StartMonadOptions`](../interfaces/StartMonadOptions.md) = `{}`

## Returns

`Promise`\<[`StartMonadResult`](../interfaces/StartMonadResult.md)\>
