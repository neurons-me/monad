[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / findMonadsForNamespaceAsync

# Function: findMonadsForNamespaceAsync()

> **findMonadsForNamespaceAsync**(`targetNs`): `Promise`\<[`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)[]\>

Defined in: [kernel/monadIndex.ts:206](https://github.com/neurons-me/monad/blob/1dffe04df49d5516da9e82882037ae2ce346a55c/npm/src/kernel/monadIndex.ts#L206)

Finds namespace claimants across the local kernel and CLI record store.

This is the bridge-facing discovery function. It sees sibling monad processes
because the CLI `monad.json` records are shared across processes.

## Parameters

### targetNs

`string`

## Returns

`Promise`\<[`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)[]\>
