[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / writeMonadIndexEntry

# Function: writeMonadIndexEntry()

> **writeMonadIndexEntry**(`entry`, `persist?`): `void`

Defined in: [kernel/monadIndex.ts:45](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/monadIndex.ts#L45)

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
