[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / MeshSelection

# Type Alias: MeshSelection

> **MeshSelection** = `object`

Defined in: [kernel/meshSelect.ts:30](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/meshSelect.ts#L30)

Result of selecting a monad for a namespace.

`mesh-claim` means the highest-scored eligible claimant won. `exploration`
means the decision margin was low and the runner-up was intentionally tried
to gather comparative feedback. `name-selector` means the caller bypassed
scoring by asking for a specific monad.

## Properties

### breakdown?

> `optional` **breakdown?**: [`ScoreBreakdown`](ScoreBreakdown.md)

Defined in: [kernel/meshSelect.ts:35](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/meshSelect.ts#L35)

***

### entry

> **entry**: [`MonadIndexEntry`](../interfaces/MonadIndexEntry.md)

Defined in: [kernel/meshSelect.ts:31](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/meshSelect.ts#L31)

***

### reason

> **reason**: `"name-selector"` \| `"mesh-claim"` \| `"exploration"`

Defined in: [kernel/meshSelect.ts:33](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/meshSelect.ts#L33)

***

### runnerUp?

> `optional` **runnerUp?**: [`MeshRunnerUp`](MeshRunnerUp.md)

Defined in: [kernel/meshSelect.ts:36](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/meshSelect.ts#L36)

***

### score?

> `optional` **score?**: `number`

Defined in: [kernel/meshSelect.ts:34](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/meshSelect.ts#L34)
