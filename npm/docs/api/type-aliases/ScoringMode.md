[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / ScoringMode

# Type Alias: ScoringMode

> **ScoringMode** = `"normalized"` \| `"raw"`

Defined in: [kernel/scoring.ts:21](https://github.com/neurons-me/monad/blob/1dffe04df49d5516da9e82882037ae2ce346a55c/npm/src/kernel/scoring.ts#L21)

Controls how scorer weights are interpreted.

- `normalized`: production default; weights are divided by their sum, so
  totals stay in `[0, 1]`.
- `raw`: experimental/debug mode; weights are used as provided and totals may
  exceed `1`.
