[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / LEARNING\_RATE

# Variable: LEARNING\_RATE

> `const` **LEARNING\_RATE**: `0.01` = `0.01`

Defined in: [kernel/adaptiveWeights.ts:24](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/adaptiveWeights.ts#L24)

Gradient step size (α) applied per forward result.

Small by design: `Δweight = α × reward × contribution` at α = 0.01
produces sub-1% shifts per step, keeping the weight trajectory smooth and
preventing oscillation after a burst of unusual outcomes.
