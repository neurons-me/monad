[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / matchesMeshSelector

# Function: matchesMeshSelector()

> **matchesMeshSelector**(`entry`, `selectorRaw`): `boolean`

Defined in: [kernel/meshSelect.ts:53](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/meshSelect.ts#L53)

Tests whether a monad entry satisfies a selector constraint.

The selector uses the same DNF grammar as self mapping:
`device:macbook|host:edge;tag:primary`. Empty selectors always match.

## Parameters

### entry

[`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)

### selectorRaw

`string` \| `null`

## Returns

`boolean`
