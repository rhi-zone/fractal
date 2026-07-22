import { t, types, type TypeRef } from "./index.ts"
import { bytes, date, datetime, duration, email, float32, float64, int32, int64, time, uri, uuid } from "./kinds/common.ts"

export type OpenApiSchema = Record<string, unknown>

// Mirrors openapi30.ts's/openapi20.ts's own `passthroughKeys` (the forward
// direction) — this is the reverse extraction of the same annotation
// keywords back into meta. Both OAS versions share this subset of the
// draft-04-derived numeric/string validation vocabulary (§4.7.4 in Swagger
// 2.0, §4.8.24 in OAS 3.0.3); the exclusiveMinimum/exclusiveMaximum
// boolean-modifier encoding is identical to json-schema-04.ts's, so no
// separate array-of-two-numbers handling is needed here.
const passthroughKeys = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "multipleOf",
  "readOnly",
  "writeOnly",
] as const

// Formatted-string kinds recognized by both OAS versions' Data Type Format
// tables (Swagger 2.0 §4.6, OAS 3.0.3 §4.8.24) — `byte` (base64-encoded
// string) is the OAS-specific format name for the same concept
// from-json-schema.ts recognizes via JSON Schema's `contentEncoding:
// "base64"` convention instead.
const stringFormats: Record<string, () => TypeRef> = {
  uuid: () => uuid(),
  uri: () => uri(),
  email: () => email(),
  "date-time": () => datetime(),
  date: () => date(),
  time: () => time(),
  duration: () => duration(),
  byte: () => bytes(),
}

function withMeta(ref: TypeRef, extra: Record<string, unknown>): TypeRef {
  if (Object.keys(extra).length === 0) return ref
  return { shape: ref.shape, meta: { ...ref.meta, ...extra } }
}

// Annotation keywords shared verbatim by both OAS versions' Schema Object
// (description/default) plus the singular `example` field (OAS 3.0.3
// §4.8.24.2 / Swagger 2.0 §4.7.4 both use singular `example`, unlike JSON
// Schema's plural `examples` array — from-json-schema.ts's `meta.examples`
// convention doesn't apply here). `deprecated` is native to OAS 3.0 only;
// Swagger 2.0's `x-deprecated` vendor-extension equivalent (see
// openapi20.ts's withMeta) is folded in by extractExtensions below, keyed
// to the same canonical `meta.deprecated`.
function extractMeta(schema: OpenApiSchema): Record<string, unknown> {
  const meta: Record<string, unknown> = {}

  if (typeof schema.description === "string") meta.description = schema.description
  if (schema.deprecated === true) meta.deprecated = true
  if (schema.default !== undefined) meta.default = schema.default
  if (schema.example !== undefined) meta.example = schema.example

  for (const key of passthroughKeys) {
    if (schema[key] !== undefined) meta[key] = schema[key]
  }

  return meta
}

// Vendor-extension (`x-*`) passthrough into the open metadata bag (see
// CLAUDE.md's "open metadata bag over fixed schema"), keyed verbatim by
// extension name. `exclude` names extensions this ingester interprets
// structurally elsewhere (x-nullable/x-deprecated fold into the canonical
// meta.nullable/meta.deprecated via the version-specific callers below;
// x-oneOf is consumed as the Swagger 2.0 union round-trip convention, not
// preserved as a literal meta key) so they aren't double-recorded here.
// Extensions this ingester has no special handling for (x-stream,
// x-page-style, x-function, x-method, x-interface, x-never, …) are NOT
// reconstructed back into their pre-degrade TypeKinds — same precedent as
// from-json-schema.ts, which likewise doesn't invert json-schema.ts's
// x-class-name/x-function — they simply travel as opaque meta entries.
function extractExtensions(schema: OpenApiSchema, exclude: ReadonlySet<string>): Record<string, unknown> {
  const extensions: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key.startsWith("x-") && !exclude.has(key)) extensions[key] = value
  }
  return extensions
}

function fromString(schema: OpenApiSchema): TypeRef {
  if (typeof schema.format === "string") {
    const known = stringFormats[schema.format]
    if (known !== undefined) return known()
    return t(types.string, { format: schema.format })
  }
  return t(types.string)
}

function fromNumber(schema: OpenApiSchema): TypeRef {
  if (schema.format === "float") return float32()
  if (schema.format === "double") return float64()
  if (typeof schema.format === "string") return t(types.number, { format: schema.format })
  return t(types.number)
}

function fromInteger(schema: OpenApiSchema): TypeRef {
  if (schema.format === "int32") return int32()
  if (schema.format === "int64") return int64()
  if (typeof schema.format === "string") return t(types.integer, { format: schema.format })
  return t(types.integer)
}

function fromObject(schema: OpenApiSchema, convert: (s: OpenApiSchema) => TypeRef): TypeRef {
  const properties = schema.properties as Record<string, OpenApiSchema> | undefined
  if (properties !== undefined) {
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
    const fields: Record<string, TypeRef> = {}
    for (const [name, fieldSchema] of Object.entries(properties)) {
      const fieldRef = convert(fieldSchema)
      const extra: Record<string, unknown> = {}
      if (!required.has(name)) extra.optional = true
      // Mirrored into the lowercase `meta.readonly` convention alongside the
      // verbatim `meta.readOnly` passthrough — same dual-write as
      // from-json-schema.ts's fromObject, for the same reason (round-trips
      // through both the OAS-native `readOnly` key and the TS-extraction
      // `readonly` convention other projectors read).
      if (fieldSchema.readOnly === true) extra.readonly = true
      fields[name] = Object.keys(extra).length > 0 ? withMeta(fieldRef, extra) : fieldRef
    }
    return t(types.object(fields))
  }

  const additionalProperties = schema.additionalProperties
  if (additionalProperties !== undefined && typeof additionalProperties === "object" && additionalProperties !== null) {
    return t(types.map(t(types.string), convert(additionalProperties as OpenApiSchema)))
  }

  return t(types.object({}))
}

function fromArray(schema: OpenApiSchema, convert: (s: OpenApiSchema) => TypeRef): TypeRef {
  const items = schema.items
  if (items !== undefined && typeof items === "object" && items !== null) {
    return t(types.array(convert(items as OpenApiSchema)))
  }
  return t(types.array(t(types.unknown)))
}

function convertLeaf(schema: OpenApiSchema, convert: (s: OpenApiSchema) => TypeRef): TypeRef {
  switch (schema.type) {
    case "boolean":
      return t(types.boolean)
    case "number":
      return fromNumber(schema)
    case "integer":
      return fromInteger(schema)
    case "string":
      return fromString(schema)
    case "object":
      return fromObject(schema, convert)
    case "array":
      return fromArray(schema, convert)
    default:
      // Empty schema (or a schema carrying only annotation/vendor keywords
      // already extracted into meta) — matches anything, same fallback as
      // from-json-schema.ts.
      return t(types.unknown)
  }
}

type OpenApiVersion = "3.0" | "2.0"

function fromOpenApiSchema(schema: OpenApiSchema, version: OpenApiVersion): TypeRef {
  const convert = (s: OpenApiSchema) => fromOpenApiSchema(s, version)

  // OAS 3.0.3 §4.8.24.1: `nullable: true` is the substitute for JSON
  // Schema's `type: [T, "null"]` array form (draft-05-based OAS schemas
  // have no type-array nullable at all). Swagger 2.0 has neither `nullable`
  // nor a type-array form (§4.7.4: "type - Value MUST be a string.") — the
  // de facto vendor-extension convention (Autorest, drf-yasg, …) is
  // `x-nullable`, mirroring openapi20.ts's own withMeta. Unlike JSON
  // Schema's structural array-unwrap, nullable here is always a flat
  // sibling modifier — no need to rewrite `type` before dispatching.
  const nullableFlag = version === "3.0" ? schema.nullable === true : schema["x-nullable"] === true

  // Swagger 2.0's `x-deprecated` (openapi20.ts's vendor-extension stand-in
  // for OAS 3.0's native `deprecated` keyword, §4.7.4 has no deprecated
  // field) folds into the same canonical `meta.deprecated` extractMeta
  // already produces for the 3.0 native keyword.
  const deprecatedFlag = version === "2.0" && schema["x-deprecated"] === true

  // Swagger 2.0 has no `oneOf`/`anyOf` (only `allOf` survived from its
  // draft-04 JSON Schema base, §4.7.4) — openapi20.ts's own union projector
  // degrades a union to `x-oneOf` (vendor-extension array of variant
  // schemas) plus a plain-string `discriminator`, which this branch
  // recognizes as the round-trip convention for a Swagger 2.0-authored
  // union. OAS 3.0 uses its native `oneOf` + Discriminator Object
  // (`{propertyName, mapping?}`, §4.8.25) directly.
  const oneOfList = version === "3.0" ? schema.oneOf : schema["x-oneOf"]

  const excludedExtensions = new Set<string>(
    version === "2.0" ? ["x-nullable", "x-deprecated", "x-oneOf"] : [],
  )
  const extraMeta: Record<string, unknown> = {
    ...extractMeta(schema),
    ...extractExtensions(schema, excludedExtensions),
  }
  if (nullableFlag) extraMeta.nullable = true
  if (deprecatedFlag) extraMeta.deprecated = true

  let base: TypeRef

  if (schema.$ref !== undefined) {
    // Reverses openapi30.ts's `#/components/schemas/NAME` and
    // openapi20.ts's `#/definitions/NAME` `$ref` encodings alike — both
    // resolve to a bare target name the same way from-json-schema.ts's
    // `$ref` handling does, so no version branch is needed here. Refs are
    // left unresolved (a `{kind:"ref", target}` TypeRef), same convention
    // as from-json-schema.ts — resolution against a document's `defs` is a
    // caller concern (see index.ts's `resolveRef`/`TypeRefDocument`), not
    // this ingester's.
    const target = String(schema.$ref).split("/").pop() ?? String(schema.$ref)
    base = t(types.ref(target))
  } else if (schema.const !== undefined) {
    base = t(types.literal(schema.const as string | number | boolean | null))
  } else if (Array.isArray(schema.enum)) {
    base = t(types.enum(schema.enum as string[]))
  } else if (Array.isArray(oneOfList)) {
    const variants = (oneOfList as OpenApiSchema[]).map(convert)
    const discriminator = schema.discriminator
    if (version === "3.0" && typeof discriminator === "object" && discriminator !== null) {
      const d = discriminator as { propertyName?: string; mapping?: Record<string, string> }
      if (typeof d.propertyName === "string") extraMeta.discriminator = d.propertyName
      // `mapping` has no forward-projector consumer yet (toOpenApi30 only
      // reads/writes `propertyName`) — preserved here as an open-bag entry
      // so it isn't silently dropped on ingest, per CLAUDE.md's "open
      // metadata bag over fixed schema."
      if (d.mapping !== undefined) extraMeta.discriminatorMapping = d.mapping
    } else if (version === "2.0" && typeof discriminator === "string") {
      // Swagger 2.0 §4.7.4: Schema Object's `discriminator` is a bare
      // string naming the property, unlike OAS 3.0's Discriminator Object.
      extraMeta.discriminator = discriminator
    }
    base = t(types.union(variants))
  } else if (version === "3.0" && Array.isArray(schema.anyOf)) {
    base = t(types.union((schema.anyOf as OpenApiSchema[]).map(convert)))
  } else if (Array.isArray(schema.allOf)) {
    // Swagger 2.0 §4.7.4 kept `allOf` from its draft-04 base (the only
    // polymorphism keyword it has) — same faithful intersection encoding
    // for both versions.
    base = t(types.intersection((schema.allOf as OpenApiSchema[]).map(convert)))
  } else {
    base = convertLeaf(schema, convert)
  }

  return withMeta(base, extraMeta)
}

/** Convert an OpenAPI 3.0 (OAS 3.0.3, §4.8.24 Schema Object) schema into a
 * type-ir `TypeRef`. Reverses `toOpenApi30` (openapi30.ts) for the shared
 * structural subset; `$ref`s are left unresolved (see `fromOpenApiSchema`'s
 * comment on `$ref` above) and vendor extensions this ingester has no
 * structural handler for travel verbatim into `meta`. */
export function fromOpenApi30(schema: OpenApiSchema): TypeRef {
  return fromOpenApiSchema(schema, "3.0")
}

/** Convert a Swagger 2.0 (§4.7.4 Schema Object) schema into a type-ir
 * `TypeRef`. Reverses `toOpenApi20` (openapi20.ts) for the shared
 * structural subset, including its `x-oneOf`/`discriminator`
 * vendor-extension encoding of unions (Swagger 2.0 has no native
 * `oneOf`/`anyOf`) and its `x-nullable`/`x-deprecated` stand-ins for
 * concepts OAS 3.0 has native keywords for. `$ref`s are left unresolved,
 * same convention as `fromOpenApi30`. */
export function fromOpenApi20(schema: OpenApiSchema): TypeRef {
  return fromOpenApiSchema(schema, "2.0")
}
