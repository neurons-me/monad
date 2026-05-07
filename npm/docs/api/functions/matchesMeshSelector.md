[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / matchesMeshSelector

# Function: matchesMeshSelector()

> **matchesMeshSelector**(`entry`, `selectorRaw`): `boolean`

Defined in: [kernel/meshSelect.ts:52](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/meshSelect.ts#L52)

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
