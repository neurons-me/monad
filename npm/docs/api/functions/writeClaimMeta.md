[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / writeClaimMeta

# Function: writeClaimMeta()

> **writeClaimMeta**(`monadId`, `namespace`, `patch`): `void`

Defined in: [kernel/scoring.ts:89](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/scoring.ts#L89)

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
