[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / readAdaptiveWeights

# Function: readAdaptiveWeights()

> **readAdaptiveWeights**(): `Record`\<`string`, `number`\>

Defined in: [kernel/adaptiveWeights.ts:245](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/kernel/adaptiveWeights.ts#L245)

Returns the current globally learned scorer weights.

Falls back to [DEFAULT\_WEIGHTS](../variables/DEFAULT_WEIGHTS.md) for any key missing or invalid in
the kernel. Custom scorer weights added by the learning loop are also
returned. The `_meta` internal field is always excluded.

## Returns

`Record`\<`string`, `number`\>
