// packages/type-ir/src/from-standard-schema.ts — @rhi-zone/fractal-type-ir/from-standard-schema
//
// FROM-direction ingester: any object implementing the Standard Schema spec
// (https://standardschema.dev/) -> TypeRef. Standard Schema is a thin,
// vendor-neutral validation interface (`~standard.validate`) that Zod,
// Valibot, ArkType, and others implement; a growing subset additionally
// implement StandardJSONSchemaV1 (`~standard.jsonSchema.input`/`.output`),
// which exports a real JSON Schema we can hand straight to
// fromJsonSchema() — the richest of the three paths here, since it is the
// vendor's own structural description rather than a guess. "Richest of
// what is available", not "lossless": see the caveat on tier 1 below.
//
// Strategy, in priority order:
//   1. StandardJSONSchemaV1 present -> export JSON Schema (target
//      "draft-2020-12", falling back to "draft-07" if the vendor doesn't
//      support 2020-12 — both are the spec's "strongly recommended"
//      targets) and delegate to fromJsonSchema().
//
//      Best of the three paths, but NOT lossless. Two different losses,
//      worth separating because only one is inherent:
//
//      (a) Inherent to JSON Schema. Arbitrary `.refine()` predicates and
//          `.transform()` bodies are code; nothing declarative represents
//          them, and they are gone before we see the export.
//
//      (b) NOT inherent, and now FIXED. TypeRef has a first-class nominal
//          `instance` kind (className/declarationFile) and `json-schema.ts`
//          serializes it as `{type:"object", "x-class-name": Name,
//          "x-declaration-file": File}`. fromJsonSchema() used to drop that,
//          degrading `instance("Date")` -> JSON Schema -> `object{}`; it now
//          reads it back, so the round trip is exact and a vendor exporting
//          `z.instanceof(Date)` under that convention keeps its identity.
//          Other `x-` extensions (`x-brand`, OAS `x-*`) are likewise carried
//          into meta rather than dropped.
//
//      Standard keywords do survive: `{type:"string", pattern, minLength}`
//      lands as `string` with `meta.pattern`/`meta.minLength`, and
//      `format: "date-time"` becomes the `datetime` domain kind.
//   2. No JSON Schema export -> fall back to whatever `~standard.types`
//      offers. Per spec this property exists purely to drive TypeScript's
//      `InferInput`/`InferOutput` — implementations are not required to
//      (and typically don't) populate it at runtime — so this path
//      degrades to `unknown` unless a vendor actually attaches a runtime
//      sample value, in which case fromJsonCorpus([sample]) infers a structural TypeRef
//      from that sample the same way it would from any other JSON value.
//
// The originating vendor name (`~standard.vendor`) is always preserved in
// `meta.vendor` on both paths, so downstream consumers can recover which
// library produced the schema even once it's flattened to a TypeRef.

import type { StandardJSONSchemaV1, StandardSchemaV1, StandardTypedV1 } from "@standard-schema/spec"
import { t, types, type TypeRef } from "./index.ts"
import { fromJsonSchema, type JsonSchema } from "./from-json-schema.ts"
import { fromJsonCorpus } from "./from-json-corpus.ts"

export type { StandardJSONSchemaV1, StandardSchemaV1, StandardTypedV1 }

function withMeta(ref: TypeRef, extra: Record<string, unknown>): TypeRef {
  if (Object.keys(extra).length === 0) return ref
  return { shape: ref.shape, meta: { ...ref.meta, ...extra } }
}

// StandardJSONSchemaV1 isn't distinguishable from plain StandardSchemaV1 by
// `~standard.version`/`vendor` alone — the presence of a callable
// `jsonSchema.input` is the actual discriminator the spec defines for
// "this schema also exports JSON Schema."
function hasJsonSchemaExport(
  props: StandardSchemaV1.Props,
): props is StandardSchemaV1.Props & StandardJSONSchemaV1.Props {
  const jsonSchema = (props as Partial<StandardJSONSchemaV1.Props>).jsonSchema
  return typeof jsonSchema?.input === "function"
}

function exportJsonSchema(converter: StandardJSONSchemaV1.Converter): JsonSchema {
  try {
    return converter.input({ target: "draft-2020-12" })
  } catch {
    return converter.input({ target: "draft-07" })
  }
}

/**
 * Converts any Standard Schema (https://standardschema.dev/) implementation
 * to a TypeRef.
 *
 * Prefers the schema's own JSON Schema export (StandardJSONSchemaV1) when
 * available, piping it through fromJsonSchema(). When no JSON Schema export
 * exists, falls back to inferring from a runtime `~standard.types` sample
 * if the vendor happens to provide one, and otherwise degrades to
 * `types.unknown` — in every case preserving `~standard.vendor` in
 * `meta.vendor`.
 *
 * The tiers are mutually exclusive — tier 2 is only reached when the vendor
 * exports no JSON Schema — so which is "richer" never arbitrates anything at
 * runtime. Recorded for accuracy: neither tier dominates the other in general.
 *
 * Tier 1 wins in two distinct ways.
 *
 *   Declared structure the sample cannot show. A real export carries
 *   optionality (a `note?: string` a single sample simply does not exhibit)
 *   and constraints (`minLength` -> meta), and avoids tier 2's one-sample
 *   artifacts — `tags: ["a"]` infers a 1-`tuple`, not an `array`, because one
 *   observation cannot distinguish fixed arity from variable.
 *
 *   Values outside the JSON-corpus importer's input domain. TypeRef itself
 *   represents plenty that JSON has no notion of — `instance` is nominal,
 *   there are `function`/`method`/`interface`/`stream`/`page` kinds — but
 *   `fromJsonCorpus`/`inferValueShape` specifically infer structure from JSON
 *   *values*, so that importer's input domain is JSON-shaped data. That is a
 *   fact about this one inference path, not about the IR.
 *
 *   It matters here because tier 2 feeds it something that need not be JSON.
 *   `~standard.types.output` is an example of the schema's OUTPUT type, and
 *   for validators like Zod that is not restricted to JSON-safe values —
 *   `z.instanceof(Date)` produces a live `Date`. Fed that, inference does
 *   typeof dispatch with no class-instance awareness and yields `object{}`
 *   (a Date has no own enumerable keys); `new Map([["a",1]])` likewise. The
 *   ideal answer, `instance("Date")`, is representable in the IR, and tier 1
 *   now reaches it when the vendor emits `x-class-name` (see (b) above).
 *   Tier 2 still cannot: nothing in a live `Date`'s JSON-shaped projection
 *   says "Date".
 *
 * Tier 2 wins when the vendor CANNOT express the construct at all
 * (`z.custom<T>()`, instanceof-style checks) and degrades to a permissive
 * schema: `{}` and `true` both infer `unknown` and `{type:"object"}` infers an
 * empty object, while a JSON-serializable sample still yields the real field
 * shape. Unreachable given the mutual exclusivity above, but it means the
 * ordering is a property of the inputs, not a law.
 */
export function fromStandardSchema(schema: StandardSchemaV1): TypeRef {
  const props = schema["~standard"]
  const vendor = props.vendor

  if (hasJsonSchemaExport(props)) {
    const jsonSchema = exportJsonSchema(props.jsonSchema)
    return withMeta(fromJsonSchema(jsonSchema), { vendor })
  }

  const sample = props.types?.output ?? props.types?.input
  if (sample !== undefined) {
    return withMeta(fromJsonCorpus([sample]), { vendor })
  }

  return withMeta(t(types.unknown), { vendor })
}
