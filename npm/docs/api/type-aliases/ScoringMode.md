[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / ScoringMode

# Type Alias: ScoringMode

> **ScoringMode** = `"normalized"` \| `"raw"`

Defined in: [kernel/scoring.ts:21](https://github.com/neurons-me/monad/blob/8aad2ec6c211743f89c04d42c7e6fc170dfba59d/npm/src/kernel/scoring.ts#L21)

Controls how scorer weights are interpreted.

- `normalized`: production default; weights are divided by their sum, so
  totals stay in `[0, 1]`.
- `raw`: experimental/debug mode; weights are used as provided and totals may
  exceed `1`.
