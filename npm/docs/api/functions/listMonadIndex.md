[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / listMonadIndex

# Function: listMonadIndex()

> **listMonadIndex**(): [`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)[]

Defined in: [kernel/monadIndex.ts:65](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/monadIndex.ts#L65)

Lists local-kernel index entries ordered by freshness.

This does not include the CLI record store; use `listMonadIndexAsync` when
discovering sibling monads running in other processes on the same machine.

## Returns

[`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)[]
