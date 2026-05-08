[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / announceClaimedNamespaces

# Function: announceClaimedNamespaces()

> **announceClaimedNamespaces**(`monadId`, `namespaces`): `void`

Defined in: [kernel/monadIndex.ts:175](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/monadIndex.ts#L175)

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
