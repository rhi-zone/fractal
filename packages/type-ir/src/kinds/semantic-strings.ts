// packages/type-ir/src/kinds/semantic-strings.ts — @rhi-zone/fractal-type-ir/kinds/semantic-strings
//
// Semantically-tagged string kinds (uuid, uri, email) — all subtype "string".

import { registerParent, t, type TypeRef } from "../index.ts"

declare module "../index.ts" {
  interface TypeKinds {
    uuid: { readonly kind: "uuid" }
    uri: { readonly kind: "uri" }
    email: { readonly kind: "email" }
  }
}

registerParent("uuid", "string")
registerParent("uri", "string")
registerParent("email", "string")

export const uuid = (meta?: Record<string, unknown>): TypeRef => t({ kind: "uuid" }, meta)
export const uri = (meta?: Record<string, unknown>): TypeRef => t({ kind: "uri" }, meta)
export const email = (meta?: Record<string, unknown>): TypeRef => t({ kind: "email" }, meta)

// ============================================================================
// Canonical brand types — for consumers authoring TS source that the
// api-tree extractor reads. A field typed as one of these brands (rather
// than plain `string`) round-trips through extraction as the matching IR
// kind (`types.uuid`/`types.uri`/`types.email`) instead of degrading to
// `t(types.string, { brand: "..." })` — see
// packages/api-tree/src/extract.ts's brand→kind promotion.
//
// The brand lives behind a shared `unique symbol` key (`BrandTag`) rather
// than a named string property (`__brand`/`__tag`) — phantom, structurally
// inaccessible at runtime, same shape as the refinement tags in
// `refinements.ts`. This is the "shared-symbol" branded-type pattern the
// extractor already recognizes (`brandNameFromSymbolKeyedProp` /
// `brandFromIntersection`'s literal-value-on-a-symbol-keyed-prop case): the
// tag's STRING LITERAL value (not the symbol's own declared name) is what
// carries the brand name, so `BrandTag` can be reused across all three
// (and any consumer-authored brand) without them colliding. `BrandTag` is
// exported type-only — there is no runtime value to export (the `declare
// const` has no emit) — so a consuming module can reference `[BrandTag]` in
// a computed property type position without importing a value.
//
// The brand tag's literal value is the kind name (lowercase, matching the
// `TypeKinds` key above) — the extractor's promotion lookup is
// case-insensitive, so `"UUID"`/`"Uuid"`/`"uuid"` all match, but the tag
// value here is written in the canonical lowercase form.
// ============================================================================

declare const BrandTag: unique symbol
export type { BrandTag }

export type Uuid = string & { readonly [BrandTag]: "uuid" }
export type Uri = string & { readonly [BrandTag]: "uri" }
export type Email = string & { readonly [BrandTag]: "email" }
