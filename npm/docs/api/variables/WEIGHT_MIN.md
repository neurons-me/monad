[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / WEIGHT\_MIN

# Variable: WEIGHT\_MIN

> `const` **WEIGHT\_MIN**: `0.01` = `0.01`

Defined in: [kernel/adaptiveWeights.ts:33](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/adaptiveWeights.ts#L33)

Hard floor on any learned weight.

No scorer can drop below 1% influence regardless of how many negative
rewards it accumulates. This ensures every signal remains recoverable:
if a scorer later becomes genuinely useful, it can climb back up.
