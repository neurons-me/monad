[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / ScoringMode

# Type Alias: ScoringMode

> **ScoringMode** = `"normalized"` \| `"raw"`

Defined in: [kernel/scoring.ts:21](https://github.com/neurons-me/monad/blob/f6d0fb6d4d7c8661ca9f05a2c1b6bad00e861f5e/npm/src/kernel/scoring.ts#L21)

Controls how scorer weights are interpreted.

- `normalized`: production default; weights are divided by their sum, so
  totals stay in `[0, 1]`.
- `raw`: experimental/debug mode; weights are used as provided and totals may
  exceed `1`.
