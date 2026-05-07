[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / ScoringMode

# Type Alias: ScoringMode

> **ScoringMode** = `"normalized"` \| `"raw"`

Defined in: [kernel/scoring.ts:21](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/kernel/scoring.ts#L21)

Controls how scorer weights are interpreted.

- `normalized`: production default; weights are divided by their sum, so
  totals stay in `[0, 1]`.
- `raw`: experimental/debug mode; weights are used as provided and totals may
  exceed `1`.
