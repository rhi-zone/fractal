// packages/type-ir/src/from-standard-schema.ts — @rhi-zone/fractal-type-ir/from-standard-schema
//
// FROM-direction ingester: any object implementing the Standard Schema spec
// (https://standardschema.dev/) -> TypeRef. Standard Schema is a thin,
// vendor-neutral validation interface (`~standard.validate`) that Zod,
// Valibot, ArkType, and others implement; a growing subset additionally
// implement StandardJSONSchemaV1 (`~standard.jsonSchema.input`/`.output`),
// which exports a real JSON Schema we can hand straight to
// fromJsonSchema() — the richest and most accurate path available, since
// it reflects the vendor's own structural description rather than a guess.
//
// Strategy, in priority order:
//   1. StandardJSONSchemaV1 present -> export JSON Schema (target
//      "draft-2020-12", falling back to "draft-07" if the vendor doesn't
//      support 2020-12 — both are the spec's "strongly recommended"
//      targets) and delegate to fromJsonSchema().
//   2. No JSON Schema export -> fall back to whatever `~standard.types`
//      offers. Per spec this property exists purely to drive TypeScript's
//      `InferInput`/`InferOutput` — implementations are not required to
//      (and typically don't) populate it at runtime — so this path
//      degrades to `unknown` unless a vendor actually attaches a runtime
//      sample value, in which case fromJson() infers a structural TypeRef
//      from that sample the same way it would from any other JSON value.
//
// The originating vendor name (`~standard.vendor`) is always preserved in
// `meta.vendor` on both paths, so downstream consumers can recover which
// library produced the schema even once it's flattened to a TypeRef.

import type { StandardJSONSchemaV1, StandardSchemaV1, StandardTypedV1 } from "@standard-schema/spec"
import { t, types, type TypeRef } from "./index.ts"
import { fromJsonSchema, type JsonSchema } from "./from-json-schema.ts"
import { fromJson } from "./from-json.ts"

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
    return withMeta(fromJson(sample), { vendor })
  }

  return withMeta(t(types.unknown), { vendor })
}
