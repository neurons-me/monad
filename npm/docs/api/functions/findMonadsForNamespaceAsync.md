[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / findMonadsForNamespaceAsync

# Function: findMonadsForNamespaceAsync()

> **findMonadsForNamespaceAsync**(`targetNs`): `Promise`\<[`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)[]\>

Defined in: [kernel/monadIndex.ts:208](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/monadIndex.ts#L208)

Finds namespace claimants across the local kernel and CLI record store.

This is the bridge-facing discovery function. It sees sibling monad processes
because the CLI `monad.json` records are shared across processes.

## Parameters

### targetNs

`string`

## Returns

`Promise`\<[`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)[]\>
