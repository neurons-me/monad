[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / resolveAdaptiveWeights

# Function: resolveAdaptiveWeights()

> **resolveAdaptiveWeights**(`namespace?`): `Record`\<`string`, `number`\>

Defined in: kernel/adaptiveWeights.ts:312

Resolves the adaptive weights for one request.

This is the read-side blend used by the hot path. It performs at most two
kernel reads: global weights plus namespace-local weights if they exist.
Namespaces are never initialized on read.

## Parameters

### namespace?

`string`

## Returns

`Record`\<`string`, `number`\>
