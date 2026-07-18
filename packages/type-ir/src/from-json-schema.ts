import { t, types, type TypeRef } from "./index.ts"
import {
  bytes,
  date,
  datetime,
  duration,
  float32,
  float64,
  int32,
  int64,
  time,
  uri,
  uuid,
} from "./kinds/common.ts"

export type JsonSchema = Record<string, unknown>

// Mirrors json-schema.ts's `passthroughKeys` — the reverse direction extracts
// the same set of annotation keywords back into meta.
const passthroughKeys = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "multipleOf",
  "$comment",
  "readOnly",
  "writeOnly",
] as const

function extractMeta(schema: JsonSchema): Record<string, unknown> {
  const meta: Record<string, unknown> = {}

  if (typeof schema.description === "string") meta.description = schema.description
  if (schema.deprecated === true) meta.deprecated = true
  if (schema.default !== undefined) meta.default = schema.default
  if (Array.isArray(schema.examples)) meta.examples = schema.examples

  for (const key of passthroughKeys) {
    if (schema[key] !== undefined) meta[key] = schema[key]
  }

  return meta
}

function withMeta(ref: TypeRef, extra: Record<string, unknown>): TypeRef {
  if (Object.keys(extra).length === 0) return ref
  return { shape: ref.shape, meta: { ...ref.meta, ...extra } }
}

function isNullSchema(schema: JsonSchema): boolean {
  return schema.type === "null"
}

// Formatted-string kinds recognized by json-schema.ts's leaf handlers.
const stringFormats: Record<string, () => TypeRef> = {
  uuid: () => uuid(),
  uri: () => uri(),
  "date-time": () => datetime(),
  date: () => date(),
  time: () => time(),
  duration: () => duration(),
}

function fromString(schema: JsonSchema): TypeRef {
  if (schema.contentEncoding === "base64") return bytes()
  if (typeof schema.format === "string") {
    const known = stringFormats[schema.format]
    if (known !== undefined) return known()
    return t(types.string, { format: schema.format })
  }
  return t(types.string)
}

function fromNumber(schema: JsonSchema): TypeRef {
  if (schema.format === "float") return float32()
  if (schema.format === "double") return float64()
  if (typeof schema.format === "string") return t(types.number, { format: schema.format })
  return t(types.number)
}

function fromInteger(schema: JsonSchema): TypeRef {
  if (schema.format === "int32") return int32()
  if (schema.format === "int64") return int64()
  if (typeof schema.format === "string") return t(types.integer, { format: schema.format })
  return t(types.integer)
}

function fromObject(schema: JsonSchema): TypeRef {
  const properties = schema.properties as Record<string, JsonSchema> | undefined
  if (properties !== undefined) {
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
    const fields: Record<string, TypeRef> = {}
    for (const [name, fieldSchema] of Object.entries(properties)) {
      const fieldRef = fromJsonSchema(fieldSchema)
      const extra: Record<string, unknown> = {}
      if (!required.has(name)) extra.optional = true
      // `readOnly` (already lifted verbatim into meta.readOnly by extractMeta's
      // generic passthrough above) is additionally mirrored into the
      // lowercase `meta.readonly` convention (see type-ir's TypeRef doc
      // comment) so this field round-trips through projectors that read the
      // TS-source-extraction convention (typescript.ts, zod.ts, typebox.ts, …),
      // not just the JSON-Schema-native passthrough projectors.
      if (fieldSchema.readOnly === true) extra.readonly = true
      fields[name] = Object.keys(extra).length > 0 ? withMeta(fieldRef, extra) : fieldRef
    }
    return t(types.object(fields))
  }

  const additionalProperties = schema.additionalProperties
  if (additionalProperties !== undefined && typeof additionalProperties === "object" && additionalProperties !== null) {
    return t(types.map(t(types.string), fromJsonSchema(additionalProperties as JsonSchema)))
  }

  return t(types.object({}))
}

function fromArray(schema: JsonSchema): TypeRef {
  const prefixItems = schema.prefixItems as JsonSchema[] | undefined
  if (Array.isArray(prefixItems)) {
    return t(types.tuple(prefixItems.map(fromJsonSchema)))
  }

  const items = schema.items
  // Draft-04/07 array-form `items` — the pre-2020-12 tuple syntax.
  if (Array.isArray(items)) {
    return t(types.tuple((items as JsonSchema[]).map(fromJsonSchema)))
  }

  if (items !== undefined && typeof items === "object" && items !== null) {
    return t(types.array(fromJsonSchema(items as JsonSchema)))
  }

  return t(types.array(t(types.unknown)))
}

// Splits an anyOf's variants into the non-null variants and whether a
// `{type: "null"}` variant was present — the reverse of withMeta's nullable
// anyOf-wrapping in json-schema.ts.
function splitNullableAnyOf(variants: JsonSchema[]): { rest: JsonSchema[]; nullable: boolean } {
  const nullVariants = variants.filter(isNullSchema)
  if (nullVariants.length !== 1) return { rest: variants, nullable: false }
  return { rest: variants.filter((v) => !isNullSchema(v)), nullable: true }
}

export function fromJsonSchema(schema: JsonSchema): TypeRef {
  const meta = extractMeta(schema)

  // `type: [T, "null"]` nullable leaf form.
  if (Array.isArray(schema.type)) {
    const typeList = schema.type as string[]
    const nonNull = typeList.filter((ty) => ty !== "null")
    const isNullable = nonNull.length < typeList.length
    if (nonNull.length === 1) {
      const inner = fromJsonSchema({ ...schema, type: nonNull[0] })
      return withMeta(inner, { ...meta, ...(isNullable ? { nullable: true } : {}) })
    }
  }

  if (schema.not !== undefined && Object.keys(schema.not as object).length === 0) {
    return withMeta(t(types.never), meta)
  }

  if (schema.$ref !== undefined) {
    const target = String(schema.$ref).split("/").pop() ?? String(schema.$ref)
    return withMeta(t(types.ref(target)), meta)
  }

  if (schema.const !== undefined) {
    return withMeta(t(types.literal(schema.const as string | number | boolean | null)), meta)
  }

  if (Array.isArray(schema.enum)) {
    return withMeta(t(types.enum(schema.enum as string[])), meta)
  }

  if (Array.isArray(schema.anyOf)) {
    const { rest, nullable } = splitNullableAnyOf(schema.anyOf as JsonSchema[])
    if (nullable) {
      if (rest.length === 1) return withMeta(fromJsonSchema(rest[0] as JsonSchema), { ...meta, nullable: true })
      return withMeta(t(types.union(rest.map(fromJsonSchema))), { ...meta, nullable: true })
    }
    return withMeta(t(types.union((schema.anyOf as JsonSchema[]).map(fromJsonSchema))), meta)
  }

  if (Array.isArray(schema.oneOf)) {
    const variants = (schema.oneOf as JsonSchema[]).map(fromJsonSchema)
    const discriminator = schema.discriminator as { propertyName?: string } | undefined
    const extra: Record<string, unknown> = { ...meta }
    if (discriminator !== undefined && typeof discriminator.propertyName === "string") {
      extra.discriminator = discriminator.propertyName
    }
    return withMeta(t(types.union(variants)), extra)
  }

  if (Array.isArray(schema.allOf)) {
    return withMeta(t(types.intersection((schema.allOf as JsonSchema[]).map(fromJsonSchema))), meta)
  }

  switch (schema.type) {
    case "boolean":
      return withMeta(t(types.boolean), meta)
    case "number":
      return withMeta(fromNumber(schema), meta)
    case "integer":
      return withMeta(fromInteger(schema), meta)
    case "string":
      return withMeta(fromString(schema), meta)
    case "null":
      return withMeta(t(types.null), meta)
    case "object":
      return withMeta(fromObject(schema), meta)
    case "array":
      return withMeta(fromArray(schema), meta)
    default:
      break
  }

  // Empty schema (or a schema carrying only annotation keywords already
  // extracted into meta) — matches anything.
  return withMeta(t(types.unknown), meta)
}
