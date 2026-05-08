[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / getWeightReport

# Function: getWeightReport()

> **getWeightReport**(`namespace?`): [`WeightReport`](../type-aliases/WeightReport.md)

Defined in: [kernel/adaptiveWeights.ts:258](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/adaptiveWeights.ts#L258)

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
