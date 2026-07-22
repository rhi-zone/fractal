// packages/type-ir/src/kinds/refinements.ts — @rhi-zone/fractal-type-ir/kinds/refinements
//
// Branded refinement-tag types — for consumers authoring TS source that
// `from-typescript.ts`'s ingester reads. Intersecting a base type with one or
// more of these tags (`string & MinLength<2> & MaxLength<100>`) round-trips
// through extraction as the base kind carrying the matching `meta`
// refinement key(s) (`minLength`/`maxLength`/…) — the same keys `compile.ts`
// already validates and every projector (json-schema, effect-schema, sql, …)
// already reads. See `../from-typescript.ts`'s
// `typeRefFromBrandedIntersection`.
//
// All tags share ONE `unique symbol` key (`RefinementTag`) rather than each
// carrying its own distinct property name — same "phantom, structurally
// inaccessible at runtime" shape as a symbol-keyed brand (see
// `semantic-strings.ts`'s sibling doc comment and `../from-typescript.ts`'s
// `brandNameFromSymbolKeyedProp`), but with a STRUCTURED value
// (`{ minLength: N }`) instead of a single string literal, so intersecting
// several tags merges their value objects instead of colliding on one shared
// string. `RefinementTag` is exported type-only — there is no runtime value
// to export (the `declare const` has no emit) — so a consuming module can
// reference `[RefinementTag]` in a computed property type position without
// importing a value.
//
// No IR kind, no runtime constructor: this file is TS-type-only, read
// purely by the extractor's static analysis.

declare const RefinementTag: unique symbol
export type { RefinementTag }

export type MinLength<N extends number> = { readonly [RefinementTag]: { minLength: N } }
export type MaxLength<N extends number> = { readonly [RefinementTag]: { maxLength: N } }
export type Pattern<P extends string> = { readonly [RefinementTag]: { pattern: P } }
export type Format<F extends string> = { readonly [RefinementTag]: { format: F } }
export type Minimum<N extends number> = { readonly [RefinementTag]: { minimum: N } }
export type Maximum<N extends number> = { readonly [RefinementTag]: { maximum: N } }
export type ExclusiveMinimum<N extends number> = { readonly [RefinementTag]: { exclusiveMinimum: N } }
export type ExclusiveMaximum<N extends number> = { readonly [RefinementTag]: { exclusiveMaximum: N } }
export type MultipleOf<N extends number> = { readonly [RefinementTag]: { multipleOf: N } }
