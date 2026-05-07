[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / MeshSelection

# Type Alias: MeshSelection

> **MeshSelection** = `object`

Defined in: [kernel/meshSelect.ts:29](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/meshSelect.ts#L29)

Result of selecting a monad for a namespace.

`mesh-claim` means the highest-scored eligible claimant won. `exploration`
means the decision margin was low and the runner-up was intentionally tried
to gather comparative feedback. `name-selector` means the caller bypassed
scoring by asking for a specific monad.

## Properties

### breakdown?

> `optional` **breakdown?**: [`ScoreBreakdown`](ScoreBreakdown.md)

Defined in: [kernel/meshSelect.ts:34](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/meshSelect.ts#L34)

***

### entry

> **entry**: [`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)

Defined in: [kernel/meshSelect.ts:30](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/meshSelect.ts#L30)

***

### reason

> **reason**: `"name-selector"` \| `"mesh-claim"` \| `"exploration"`

Defined in: [kernel/meshSelect.ts:32](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/meshSelect.ts#L32)

***

### runnerUp?

> `optional` **runnerUp?**: [`MeshRunnerUp`](MeshRunnerUp.md)

Defined in: [kernel/meshSelect.ts:35](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/meshSelect.ts#L35)

***

### score?

> `optional` **score?**: `number`

Defined in: [kernel/meshSelect.ts:33](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/meshSelect.ts#L33)
