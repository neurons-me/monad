[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / readAdaptiveWeights

# Function: readAdaptiveWeights()

> **readAdaptiveWeights**(): `Record`\<`string`, `number`\>

Defined in: [kernel/adaptiveWeights.ts:245](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/adaptiveWeights.ts#L245)

Returns the current globally learned scorer weights.

Falls back to [DEFAULT\_WEIGHTS](../variables/DEFAULT_WEIGHTS.md) for any key missing or invalid in
the kernel. Custom scorer weights added by the learning loop are also
returned. The `_meta` internal field is always excluded.

## Returns

`Record`\<`string`, `number`\>
