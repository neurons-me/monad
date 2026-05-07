[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / findMonadsForNamespaceAsync

# Function: findMonadsForNamespaceAsync()

> **findMonadsForNamespaceAsync**(`targetNs`): `Promise`\<[`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)[]\>

Defined in: [kernel/monadIndex.ts:206](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/monadIndex.ts#L206)

Finds namespace claimants across the local kernel and CLI record store.

This is the bridge-facing discovery function. It sees sibling monad processes
because the CLI `monad.json` records are shared across processes.

## Parameters

### targetNs

`string`

## Returns

`Promise`\<[`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)[]\>
