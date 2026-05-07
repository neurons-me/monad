[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / findMonadsForNamespace

# Function: findMonadsForNamespace()

> **findMonadsForNamespace**(`targetNs`): [`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)[]

Defined in: [kernel/monadIndex.ts:146](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/kernel/monadIndex.ts#L146)

Finds local-kernel monads that claim a namespace.

Results are ordered by `last_seen`, with deterministic name/id tie-breaking.

## Parameters

### targetNs

`string`

## Returns

[`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)[]
