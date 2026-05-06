[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / DEFAULT\_WEIGHTS

# Variable: DEFAULT\_WEIGHTS

> `const` **DEFAULT\_WEIGHTS**: `Record`\<`string`, `number`\>

Defined in: kernel/adaptiveWeights.ts:11

Starting weights for the three built-in scorers.

These are the values used until the learning loop has accumulated enough
evidence to shift them. They match the `defaultWeight` fields in scoring.ts
exactly; keeping them in sync is a semantic constraint, not a mechanical one.
