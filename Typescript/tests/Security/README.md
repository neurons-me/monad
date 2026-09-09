# Monad — Identity-Bound Secrets security battery (process/persistence half)

The canonical README for the full adversarial battery — attack model,
commands, requirement→test matrix, findings and fixes, and known
limitations — lives at
[`../../../../me/Typescript/tests/Security/README.md`](../../../../me/Typescript/tests/Security/README.md).
This file only exists so the two test files in this directory
(`snapshotDurability.test.ts`, `processInterruption.process.test.ts`) are
discoverable from here too.

Run just this directory plus the pre-existing process-lifecycle test:

```bash
npm run test:security   # vitest run tests/Security/ tests/Identity/
```
