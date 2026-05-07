[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / writeClaimMeta

# Function: writeClaimMeta()

> **writeClaimMeta**(`monadId`, `namespace`, `patch`): `void`

Defined in: [kernel/scoring.ts:89](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/scoring.ts#L89)

Merges a patch into the open claim metadata subtree.

Existing fields are preserved unless overwritten by the patch. This keeps the
schema extensible while letting the bridge update operational metrics.

## Parameters

### monadId

`string`

### namespace

`string`

### patch

[`ClaimMeta`](../type-aliases/ClaimMeta.md)

## Returns

`void`
