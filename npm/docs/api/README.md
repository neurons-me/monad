**monad.ai**

***

# monad.ai

## Interfaces

- [MonadBootstrapResult](interfaces/MonadBootstrapResult.md)
- [MonadIndexEntry](interfaces/MonadIndexEntry.md)
- [MonadOptions](interfaces/MonadOptions.md)
- [MonadRuntimeConfig](interfaces/MonadRuntimeConfig.md)
- [SelfNodeConfig](interfaces/SelfNodeConfig.md)
- [SelfSurfaceCapacity](interfaces/SelfSurfaceCapacity.md)
- [StartMonadOptions](interfaces/StartMonadOptions.md)
- [StartMonadResult](interfaces/StartMonadResult.md)

## Type Aliases

- [AdaptiveWeightUpdateOptions](type-aliases/AdaptiveWeightUpdateOptions.md)
- [ClaimMeta](type-aliases/ClaimMeta.md)
- [DecisionEntry](type-aliases/DecisionEntry.md)
- [MeshRunnerUp](type-aliases/MeshRunnerUp.md)
- [MeshSelection](type-aliases/MeshSelection.md)
- [MonadApp](type-aliases/MonadApp.md)
- [MonadLogger](type-aliases/MonadLogger.md)
- [NrpTestCatalogEntry](type-aliases/NrpTestCatalogEntry.md)
- [ScoreBreakdown](type-aliases/ScoreBreakdown.md)
- [Scorer](type-aliases/Scorer.md)
- [ScorerBreakdown](type-aliases/ScorerBreakdown.md)
- [ScoringContext](type-aliases/ScoringContext.md)
- [ScoringMode](type-aliases/ScoringMode.md)
- [SelfSurfaceTrust](type-aliases/SelfSurfaceTrust.md)
- [SelfSurfaceType](type-aliases/SelfSurfaceType.md)
- [WeightHealth](type-aliases/WeightHealth.md)
- [WeightReport](type-aliases/WeightReport.md)

## Variables

- [DEFAULT\_STALE\_MS](variables/DEFAULT_STALE_MS.md)
- [DEFAULT\_WEIGHTS](variables/DEFAULT_WEIGHTS.md)
- [GLOBAL\_BACKGROUND\_SHARE](variables/GLOBAL_BACKGROUND_SHARE.md)
- [LEARNING\_RATE](variables/LEARNING_RATE.md)
- [NAMESPACE\_MATURITY\_SAMPLES](variables/NAMESPACE_MATURITY_SAMPLES.md)
- [NRP\_TEST\_CATALOG](variables/NRP_TEST_CATALOG.md)
- [WEIGHT\_MIN](variables/WEIGHT_MIN.md)

## Functions

- [announceClaimedNamespaces](functions/announceClaimedNamespaces.md)
- [bootstrapMonad](functions/bootstrapMonad.md)
- [computeScore](functions/computeScore.md)
- [computeScoreDetailed](functions/computeScoreDetailed.md)
- [correlateOutcome](functions/correlateOutcome.md)
- [createMonadApp](functions/createMonadApp.md)
- [findMonadByName](functions/findMonadByName.md)
- [findMonadByNameAsync](functions/findMonadByNameAsync.md)
- [findMonadsForNamespace](functions/findMonadsForNamespace.md)
- [findMonadsForNamespaceAsync](functions/findMonadsForNamespaceAsync.md)
- [getWeightReport](functions/getWeightReport.md)
- [listMonadIndex](functions/listMonadIndex.md)
- [listMonadIndexAsync](functions/listMonadIndexAsync.md)
- [matchesMeshSelector](functions/matchesMeshSelector.md)
- [readAdaptiveWeights](functions/readAdaptiveWeights.md)
- [readClaimMeta](functions/readClaimMeta.md)
- [readMonadIndexEntry](functions/readMonadIndexEntry.md)
- [recordDecision](functions/recordDecision.md)
- [recordForwardResult](functions/recordForwardResult.md)
- [resolveAdaptiveWeights](functions/resolveAdaptiveWeights.md)
- [seedSelfMonadIndexEntry](functions/seedSelfMonadIndexEntry.md)
- [selectMeshClaimant](functions/selectMeshClaimant.md)
- [startMonad](functions/startMonad.md)
- [touchSelfMonadLastSeen](functions/touchSelfMonadLastSeen.md)
- [updateAdaptiveWeights](functions/updateAdaptiveWeights.md)
- [writeClaimMeta](functions/writeClaimMeta.md)
- [writeMonadIndexEntry](functions/writeMonadIndexEntry.md)
