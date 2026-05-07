[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / findMonadsForNamespace

# Function: findMonadsForNamespace()

> **findMonadsForNamespace**(`targetNs`): [`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)[]

Defined in: [kernel/monadIndex.ts:146](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/monadIndex.ts#L146)

Finds local-kernel monads that claim a namespace.

Results are ordered by `last_seen`, with deterministic name/id tie-breaking.

## Parameters

### targetNs

`string`

## Returns

[`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)[]
