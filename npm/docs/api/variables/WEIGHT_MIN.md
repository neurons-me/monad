[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / WEIGHT\_MIN

# Variable: WEIGHT\_MIN

> `const` **WEIGHT\_MIN**: `0.01` = `0.01`

Defined in: [kernel/adaptiveWeights.ts:33](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/kernel/adaptiveWeights.ts#L33)

Hard floor on any learned weight.

No scorer can drop below 1% influence regardless of how many negative
rewards it accumulates. This ensures every signal remains recoverable:
if a scorer later becomes genuinely useful, it can climb back up.
