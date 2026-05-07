[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / announceClaimedNamespaces

# Function: announceClaimedNamespaces()

> **announceClaimedNamespaces**(`monadId`, `namespaces`): `void`

Defined in: [kernel/monadIndex.ts:173](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/kernel/monadIndex.ts#L173)

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
