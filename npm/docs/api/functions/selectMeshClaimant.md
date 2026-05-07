[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / selectMeshClaimant

# Function: selectMeshClaimant()

> **selectMeshClaimant**(`opts`): `Promise`\<[`MeshSelection`](../type-aliases/MeshSelection.md) \| `null`\>

Defined in: [kernel/meshSelect.ts:114](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/kernel/meshSelect.ts#L114)

Selects the best mesh claimant for a namespace request.

Selection proceeds in this order:
1. explicit `monadSelector` lookup, if present
2. namespace claim filtering
3. selector constraint filtering
4. scoring via `computeScoreDetailed`
5. optional epsilon-greedy exploration for low-margin decisions

## Parameters

### opts

#### explorationRate?

`number`

#### extraScorers?

[`Scorer`](../type-aliases/Scorer.md)[]

#### monadSelector

`string`

#### namespace

`string`

#### now?

`number`

#### selectorConstraint?

`string` \| `null`

#### selfEndpoint

`string`

#### selfMonadId

`string`

#### stalenessMs?

`number`

## Returns

`Promise`\<[`MeshSelection`](../type-aliases/MeshSelection.md) \| `null`\>
