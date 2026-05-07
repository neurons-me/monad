[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / resolveAdaptiveWeights

# Function: resolveAdaptiveWeights()

> **resolveAdaptiveWeights**(`namespace?`): `Record`\<`string`, `number`\>

Defined in: [kernel/adaptiveWeights.ts:312](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/adaptiveWeights.ts#L312)

Resolves the adaptive weights for one request.

This is the read-side blend used by the hot path. It performs at most two
kernel reads: global weights plus namespace-local weights if they exist.
Namespaces are never initialized on read.

## Parameters

### namespace?

`string`

## Returns

`Record`\<`string`, `number`\>
