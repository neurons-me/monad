[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / findMonadsForNamespace

# Function: findMonadsForNamespace()

> **findMonadsForNamespace**(`targetNs`): [`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)[]

Defined in: [kernel/monadIndex.ts:148](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/monadIndex.ts#L148)

Finds local-kernel monads that claim a namespace.

Results are ordered by `last_seen`, with deterministic name/id tie-breaking.

## Parameters

### targetNs

`string`

## Returns

[`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)[]
