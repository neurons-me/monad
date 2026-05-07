[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / recordForwardResult

# Function: recordForwardResult()

> **recordForwardResult**(`monadId`, `namespace`, `elapsedMs`, `ok`): `void`

Defined in: [kernel/scoring.ts:103](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/scoring.ts#L103)

Records the outcome of a forwarded mesh request.

This is the learning loop. It updates:
- decayed `resonance`
- failure-penalized `effectiveResonance`
- EWMA `avgLatencyMs`
- forward/failure counters

## Parameters

### monadId

`string`

### namespace

`string`

### elapsedMs

`number`

### ok

`boolean`

## Returns

`void`
