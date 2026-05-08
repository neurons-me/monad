[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / DEFAULT\_WEIGHTS

# Variable: DEFAULT\_WEIGHTS

> `const` **DEFAULT\_WEIGHTS**: `Record`\<`string`, `number`\>

Defined in: [kernel/adaptiveWeights.ts:11](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/adaptiveWeights.ts#L11)

Starting weights for the three built-in scorers.

These are the values used until the learning loop has accumulated enough
evidence to shift them. They match the `defaultWeight` fields in scoring.ts
exactly; keeping them in sync is a semantic constraint, not a mechanical one.
