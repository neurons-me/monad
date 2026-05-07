[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / listMonadIndex

# Function: listMonadIndex()

> **listMonadIndex**(): [`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)[]

Defined in: [kernel/monadIndex.ts:63](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/monadIndex.ts#L63)

Lists local-kernel index entries ordered by freshness.

This does not include the CLI record store; use `listMonadIndexAsync` when
discovering sibling monads running in other processes on the same machine.

## Returns

[`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)[]
