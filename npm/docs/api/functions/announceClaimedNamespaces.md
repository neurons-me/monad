[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / announceClaimedNamespaces

# Function: announceClaimedNamespaces()

> **announceClaimedNamespaces**(`monadId`, `namespaces`): `void`

Defined in: [kernel/monadIndex.ts:173](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/monadIndex.ts#L173)

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
