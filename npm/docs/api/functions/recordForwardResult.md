[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / recordForwardResult

# Function: recordForwardResult()

> **recordForwardResult**(`monadId`, `namespace`, `elapsedMs`, `ok`): `void`

Defined in: [kernel/scoring.ts:103](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/scoring.ts#L103)

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
