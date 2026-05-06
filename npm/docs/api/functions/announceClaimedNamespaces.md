[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / announceClaimedNamespaces

# Function: announceClaimedNamespaces()

> **announceClaimedNamespaces**(`monadId`, `namespaces`): `void`

Defined in: [kernel/monadIndex.ts:173](https://github.com/neurons-me/monad/blob/1dffe04df49d5516da9e82882037ae2ce346a55c/npm/src/kernel/monadIndex.ts#L173)

Adds namespaces to a monad's claimed set.

This is the compatibility/fast-index layer. Rich per-namespace metadata lives
in `_.mesh.monads.<id>.claimed.<namespace>` and is read by the scoring engine.

## Parameters

### monadId

`string`

### namespaces

`string`[]

## Returns

`void`
