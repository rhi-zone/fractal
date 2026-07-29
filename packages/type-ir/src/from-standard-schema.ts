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
//      Best of the three paths, but NOT lossless with respect to the
//      original validator schema. It is bounded by what JSON Schema can
//      express, which is strictly less than what Zod/Valibot/ArkType can:
//      `z.instanceof(SomeClass)`, nominal/branded types
//      (`string & {__brand}`), arbitrary `.refine()` predicates and
//      `.transform()` bodies have no JSON Schema representation and are
//      gone by the time we see the export. Standard keywords survive —
//      `{type:"string", pattern, minLength}` lands as
//      `string` with `meta.pattern`/`meta.minLength`, and
//      `format: "date-time"` becomes the `datetime` domain kind — but
//      vendor-specific keywords (`x-brand`, etc.) are dropped by
//      fromJsonSchema(), not carried into meta.
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
 * The tiers are mutually exclusive: tier 2 is only reached when the vendor
 * exports no JSON Schema, so the lossiness of tier 1 (see module doc) is
 * never a reason to prefer tier 2 — there is no case where both apply and
 * the sample would carry more information.
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
