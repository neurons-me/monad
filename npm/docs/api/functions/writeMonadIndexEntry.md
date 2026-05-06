[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / writeMonadIndexEntry

# Function: writeMonadIndexEntry()

> **writeMonadIndexEntry**(`entry`, `persist?`): `void`

Defined in: [kernel/monadIndex.ts:43](https://github.com/neurons-me/monad/blob/1dffe04df49d5516da9e82882037ae2ce346a55c/npm/src/kernel/monadIndex.ts#L43)

Writes or replaces a monad index entry in the local `.me` kernel.

The index is the fast structural layer: it answers "who could serve this
namespace?" before the scoring engine decides "who should serve it?"

## Parameters

### entry

[`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)

### persist?

`boolean` = `false`

## Returns

`void`
