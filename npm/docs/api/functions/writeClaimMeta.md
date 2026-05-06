[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / writeClaimMeta

# Function: writeClaimMeta()

> **writeClaimMeta**(`monadId`, `namespace`, `patch`): `void`

Defined in: [kernel/scoring.ts:89](https://github.com/neurons-me/monad/blob/1dffe04df49d5516da9e82882037ae2ce346a55c/npm/src/kernel/scoring.ts#L89)

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
