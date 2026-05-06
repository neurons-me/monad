# NRP Test Documentation

The NRP tests are grouped under `tests/NRP`. They protect the mesh resolver,
scoring engine, observability loop, and the parser compatibility fixes that make
the bridge work with `cleaker` v3.

This document mirrors the exported `NRP_TEST_CATALOG`, so TypeDoc also includes
the test taxonomy.

---

## Test Groups

| File | Category | Purpose |
|------|----------|---------|
| `tests/NRP/bridge.parse.test.ts` | parsing | Verifies `me://` parsing through `cleaker` v3 `__ptr.target`, including dot paths like `.mesh/monads` |
| `tests/NRP/monadIndex.test.ts` | index | Verifies local monad index read/write/list, claimed namespace lookup, name lookup, and ordering |
| `tests/NRP/meshSelect.test.ts` | selection | Verifies selector matching, stale filtering, self-exclusion, runner-up tracking, and exploration |
| `tests/NRP/scoring.test.ts` | scoring | Verifies score invariants, learning loop, introspection breakdowns, and scoring integration |
| `tests/NRP/decisionLog.test.ts` | observability | Verifies decisionId correlation, reward calculation, JSONL output, and failure isolation |
| `tests/NRP/adaptiveWeights.test.ts` | learning | Verifies global/namespace weight updates, maturity blending, and learning-loop integration |

---

## Hard Invariants

The scoring suite explicitly protects these invariants:

- normalized scores stay in `[0, 1]`
- identical inputs produce identical scores
- NaN and Infinity do not propagate
- scaling all weights by the same constant does not change the score
- `computeScore` and `computeScoreDetailed.total` stay identical
- runner-up is present only when more than one claimant exists
- decision correlation uses `decisionId`, not `monadId:namespace`
- reward stays in `[-0.7, 1]`
- namespace weights are not created on read
- namespace maturity reaches 70% blend at 140 samples
- global prior still receives 5% background learning at full maturity

---

## Why Tests Are Also in TypeDoc

Runtime test files are not exported as public API. Instead, the production module
exports `NRP_TEST_CATALOG`, a typed catalog of the NRP test groups. This keeps the
package runtime clean while letting generated API docs show the coverage map.

See:

```ts
import { NRP_TEST_CATALOG } from "monad.ai";
```

---

## Commands

```bash
# Full suite
npm test

# Focus a test group
npx vitest run tests/NRP/scoring.test.ts
npx vitest run tests/NRP/decisionLog.test.ts
npx vitest run tests/NRP/adaptiveWeights.test.ts

# Build docs API
npm run docs:api
```

---

## Legacy/Non-NRP Tests

The older tests are still relevant. They protect the base semantic runtime:

| File | Area |
|------|------|
| `appFactory.test.ts` | app bootstrap and env isolation |
| `claimSemanticSeeds.test.ts` | claim semantic seeding |
| `claimsOpenProfile.test.ts` | opened claim profile hydration |
| `commitsync.test.ts` | memory ledger and replay smoke tests |
| `hostProjection.test.ts` | host memory projection |
| `hostResolver.test.ts` | canonical host-to-namespace projection |
| `observerRelation.test.ts` | observer relation and disclosure envelopes |
| `persistentClaim.test.ts` | claim persistence and verification |
| `replayCanonicalization.test.ts` | replay payload normalization |
| `rootUsersProjection.test.ts` | root namespace user projection |
| `selfMapping.test.ts` | self identity, selector parsing, and surface entries |
| `semanticBootstrap.test.ts` | semantic bootstrap idempotency |
| `semanticBranchReader.test.ts` | semantic branch prefix isolation |

`tests/claim_test_verification.ts` remains a manual script invoked by
`npm run test:claims`.
