// packages/type-ir/src/from-elasticsearch.ts — @rhi-zone/fractal-type-ir/from-elasticsearch
//
// Elasticsearch index mapping (the `mappings` value of an index definition,
// or a single mapping-properties object) -> TypeRef. No text parsing — an ES
// mapping is already a structured JSON object, so this is pure structural
// traversal, same shape as from-json-schema.ts.

import { t, types, type TypeRef } from "./index.ts"
import { bytes, datetime, float32, float64, int16, int32, int64, int8, uint64 } from "./kinds/common.ts"

/** A single field definition inside an ES mapping's `properties`. Every key
 * is optional/loosely-typed because ES mappings in the wild carry many
 * type-specific knobs this ingester doesn't need to fully enumerate — the
 * ones it reads are named explicitly below; everything else round-trips
 * silently (it simply isn't reflected in the TypeRef). */
export interface ElasticsearchField {
  readonly type?: string
  readonly properties?: Readonly<Record<string, ElasticsearchField>>
  readonly fields?: Readonly<Record<string, ElasticsearchField>>
  readonly enabled?: boolean
  readonly dynamic?: boolean | "strict" | "runtime"
  readonly format?: string
  readonly index?: boolean
  readonly analyzer?: string
  readonly search_analyzer?: string
  readonly scaling_factor?: number
  readonly null_value?: unknown
  // Not a native ES mapping keyword — ES mappings carry no notion of an
  // enumerated value set at all (that's application-level knowledge). Some
  // schema-generation pipelines annotate a `keyword` field's known values
  // this way before feeding a mapping through tooling like this ingester;
  // when present on a `keyword`-family field, it's read as the field's
  // closed value set (`types.enum`) rather than a bare `string`.
  readonly enum?: readonly string[]
  readonly [key: string]: unknown
}

/** The `mappings` value of an ES index definition — a mapping is itself
 * shaped like an `object`-typed field (top-level `properties`, `dynamic`,
 * `enabled`), so it's structurally an `ElasticsearchField` without a `type`. */
export type ElasticsearchMapping = ElasticsearchField

const stringTypes = new Set(["text", "keyword", "wildcard", "constant_keyword", "search_as_you_type", "match_only_text"])

// ES integer widths -> type-ir's fixed-width int kinds.
const integerKinds: Record<string, () => TypeRef> = {
  byte: int8,
  short: int16,
  integer: int32,
  long: int64,
  unsigned_long: uint64,
}

function withMeta(ref: TypeRef, extra: Record<string, unknown>): TypeRef {
  if (Object.keys(extra).length === 0) return ref
  return { shape: ref.shape, meta: { ...ref.meta, ...extra } }
}

// Multi-fields (`fields`) and a handful of ES-specific knobs that have no
// equivalent TypeRef shape are preserved verbatim in meta so a projector
// that understands ES can round-trip them, rather than being silently
// dropped on the floor.
function extractMeta(field: ElasticsearchField): Record<string, unknown> {
  const meta: Record<string, unknown> = {}

  if (field.fields !== undefined && Object.keys(field.fields).length > 0) {
    const multiFields: Record<string, TypeRef> = {}
    for (const [name, subField] of Object.entries(field.fields)) {
      multiFields[name] = fromElasticsearchField(subField)
    }
    meta.fields = multiFields
  }

  if (field.dynamic !== undefined) meta.dynamic = field.dynamic
  if (field.index === false) meta.index = false
  if (typeof field.analyzer === "string") meta.analyzer = field.analyzer
  if (typeof field.search_analyzer === "string") meta.searchAnalyzer = field.search_analyzer
  if (field.null_value !== undefined) meta.nullValue = field.null_value

  return meta
}

function fromObjectFields(field: ElasticsearchField): TypeRef {
  if (field.enabled === false) {
    // `enabled: false` — ES stores the field but never indexes or parses its
    // structure, so nothing about its shape is knowable; the honest
    // projection is an opaque value, not a (falsely precise) empty object.
    return t(types.unknown)
  }

  const properties = field.properties
  if (properties === undefined) return t(types.object({}))

  const fields: Record<string, TypeRef> = {}
  for (const [name, subField] of Object.entries(properties)) {
    fields[name] = fromElasticsearchField(subField)
  }
  return t(types.object(fields))
}

function fromGeoPoint(): TypeRef {
  return t(
    types.object({
      lat: t(types.number),
      lon: t(types.number),
    }),
  )
}

/** Converts a single field definition (one entry of a `properties` map, or
 * the mapping root itself) into a TypeRef. */
export function fromElasticsearchField(field: ElasticsearchField): TypeRef {
  const meta = extractMeta(field)
  const type = field.type

  if (type === undefined) {
    // No `type` on a field with `properties`/`enabled` is ES's implicit
    // `object` — the same convention the mapping root itself uses.
    return withMeta(fromObjectFields(field), meta)
  }

  if (stringTypes.has(type)) {
    if ((type === "keyword" || type === "constant_keyword") && Array.isArray(field.enum) && field.enum.length > 0) {
      return withMeta(t(types.enum(field.enum)), meta)
    }
    return withMeta(t(types.string), meta)
  }

  if (type in integerKinds) {
    return withMeta(integerKinds[type]!(), meta)
  }

  switch (type) {
    case "double":
      return withMeta(float64(), meta)
    case "float":
      return withMeta(float32(), meta)
    case "half_float":
      // No fixed-width float16 kind exists in the core vocabulary yet — same
      // fallback from-json-schema.ts uses for an unrecognized numeric
      // format: the closest kind (`number`) plus the format annotation.
      return withMeta(t(types.number, { format: "float16" }), meta)
    case "scaled_float":
      return withMeta(t(types.number, { format: "scaled_float", scalingFactor: field.scaling_factor }), meta)
    case "boolean":
      return withMeta(t(types.boolean), meta)
    case "date": {
      const extra = typeof field.format === "string" ? { format: field.format } : {}
      return withMeta(datetime(extra), meta)
    }
    case "binary":
      return withMeta(bytes(), meta)
    case "ip":
      return withMeta(t(types.string, { format: "ip" }), meta)
    case "geo_point":
      return withMeta(fromGeoPoint(), meta)
    case "geo_shape":
      return withMeta(t(types.unknown, { esType: "geo_shape" }), meta)
    case "flattened":
      return withMeta(t(types.unknown, { esType: "flattened" }), meta)
    case "object":
      return withMeta(fromObjectFields(field), meta)
    case "nested":
      // `nested` is `object` semantics (indexed as its own hidden document
      // per array entry) applied to what is always logically an array of
      // objects — the array is the structural fact this ingester preserves;
      // the "each entry gets its own Lucene document" indexing detail has no
      // TypeRef equivalent and is dropped (same honest-degrade convention as
      // page/stream elsewhere in the IR).
      return withMeta(t(types.array(fromObjectFields(field))), meta)
    default:
      // Unrecognized/future ES field type — degrade to unknown rather than
      // guessing at a shape, but keep the original type name so a caller can
      // see what was skipped.
      return withMeta(t(types.unknown, { esType: type }), meta)
  }
}

/** Converts an Elasticsearch index mapping (the `mappings` value of an index
 * definition — `{ properties: {...}, dynamic: ..., ... }`) into a TypeRef. */
export function fromElasticsearch(mapping: ElasticsearchMapping): TypeRef {
  return fromElasticsearchField(mapping)
}
