[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / listMonadIndex

# Function: listMonadIndex()

> **listMonadIndex**(): [`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)[]

Defined in: [kernel/monadIndex.ts:63](https://github.com/neurons-me/monad/blob/1dffe04df49d5516da9e82882037ae2ce346a55c/npm/src/kernel/monadIndex.ts#L63)

Lists local-kernel index entries ordered by freshness.

This does not include the CLI record store; use `listMonadIndexAsync` when
discovering sibling monads running in other processes on the same machine.

## Returns

[`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)[]
