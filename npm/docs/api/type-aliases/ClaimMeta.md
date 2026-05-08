[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / ClaimMeta

# Type Alias: ClaimMeta

> **ClaimMeta** = `Record`\<`string`, `unknown`\>

Defined in: [kernel/scoring.ts:11](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/scoring.ts#L11)

Open claim metadata stored under `_.mesh.monads.<id>.claimed.<namespace>`.

This is intentionally an open schema. The built-in scorers read common fields
such as `effectiveResonance` and `avgLatencyMs`, while custom scorers may read
any additional field the `.me` tree learns over time.
