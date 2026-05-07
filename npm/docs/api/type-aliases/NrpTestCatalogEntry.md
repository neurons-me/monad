[**monad.ai**](../README.md)

***

[monad.ai](../README.md) / NrpTestCatalogEntry

# Type Alias: NrpTestCatalogEntry

> **NrpTestCatalogEntry** = `object`

Defined in: [testing/nrpTestCatalog.ts:7](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/testing/nrpTestCatalog.ts#L7)

Describes one documented test group in the NRP suite.

The catalog is exported so TypeDoc can publish the test taxonomy alongside
the runtime APIs. It is not used by Vitest at runtime.

## Properties

### category

> **category**: `"parsing"` \| `"index"` \| `"selection"` \| `"scoring"` \| `"observability"` \| `"learning"`

Defined in: [testing/nrpTestCatalog.ts:11](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/testing/nrpTestCatalog.ts#L11)

Functional area covered by the file.

***

### covers

> **covers**: `string`[]

Defined in: [testing/nrpTestCatalog.ts:15](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/testing/nrpTestCatalog.ts#L15)

Short description of the behavior under test.

***

### file

> **file**: `string`

Defined in: [testing/nrpTestCatalog.ts:9](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/testing/nrpTestCatalog.ts#L9)

Test file path relative to the package root.

***

### invariant

> **invariant**: `boolean`

Defined in: [testing/nrpTestCatalog.ts:13](https://github.com/neurons-me/monad/blob/afb8a98bd7e97bb1630f11624b2f4c187b743f15/npm/src/testing/nrpTestCatalog.ts#L13)

Whether this test group protects a production invariant.
