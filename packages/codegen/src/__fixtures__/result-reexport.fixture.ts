// packages/codegen/src/__fixtures__/result-reexport.fixture.ts
//
// A local barrel that re-exports Result from core. Used by tree.fixture.ts to
// exercise the nominal path for case (b): re-exported/barrel imports.
// TypeScript's aliasSymbol traces through re-exports to the original declaration
// site, so isNominalResult() should pass even through this indirection.

export type { Result } from "@rhi-zone/fractal-api-tree"
