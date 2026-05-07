[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / getWeightReport

# Function: getWeightReport()

> **getWeightReport**(`namespace?`): [`WeightReport`](../type-aliases/WeightReport.md)

Defined in: [kernel/adaptiveWeights.ts:258](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/adaptiveWeights.ts#L258)

Returns a full weight report: current values, defaults, per-scorer delta,
update metadata, stability flag, and runtime health signals.

Used by `GET /.mesh/weights` and `MONAD_DEBUG_WEIGHTS=1` logging.

When `namespace` is provided, the report includes namespace-local weights
and the blended weights used by `selectMeshClaimant`.

## Parameters

### namespace?

`string`

## Returns

[`WeightReport`](../type-aliases/WeightReport.md)
