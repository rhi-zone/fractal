import { resolve, type TypeRef, type TypeShape } from "./index.ts"

export type JsonSchema = Record<string, unknown>

const passthroughKeys = [
  "minimum",
  "maximum",
  // draft 2020-12 §6.2.3/6.2.4 (numeric form, since draft-06 — see json-schema-04.ts
  // for the boolean-modifier form used by draft-04).
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "multipleOf",
  "$comment",
  // draft 2020-12 §9.5 (Vocabularies for Basic Meta-Data Annotations): readOnly,
  // writeOnly, examples (since draft-06/07).
  "readOnly",
  "writeOnly",
] as const

function withMeta(schema: JsonSchema, meta: Readonly<Record<string, unknown>>, complex: boolean): JsonSchema {
  let result = schema

  if (meta.nullable === true) {
    if (complex) {
      result = { anyOf: [result, { type: "null" }] }
    } else if (typeof result.type === "string") {
      result = { ...result, type: [result.type, "null"] }
    } else {
      result = { anyOf: [result, { type: "null" }] }
    }
  }

  if (typeof meta.description === "string") result = { ...result, description: meta.description }
  if (meta.deprecated === true) result = { ...result, deprecated: true }
  if (meta.default !== undefined) result = { ...result, default: meta.default }
  // draft 2020-12 §9.5: "examples" is an array of example values (distinct from
  // OAS's singular "example").
  if (Array.isArray(meta.examples)) result = { ...result, examples: meta.examples }

  for (const key of passthroughKeys) {
    if (meta[key] !== undefined) result = { ...result, [key]: meta[key] }
  }

  return result
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => JsonSchema

const leaf =
  (schema: JsonSchema): Converter =>
  () =>
    schema

const handlers: Record<string, Converter> = {
  boolean: leaf({ type: "boolean" }),
  number: leaf({ type: "number" }),
  integer: leaf({ type: "integer" }),
  int32: leaf({ type: "integer", format: "int32" }),
  int64: leaf({ type: "integer", format: "int64" }),
  float32: leaf({ type: "number", format: "float" }),
  float64: leaf({ type: "number", format: "double" }),
  string: leaf({ type: "string" }),
  uuid: leaf({ type: "string", format: "uuid" }),
  uri: leaf({ type: "string", format: "uri" }),
  datetime: leaf({ type: "string", format: "date-time" }),
  date: leaf({ type: "string", format: "date" }),
  time: leaf({ type: "string", format: "time" }),
  duration: leaf({ type: "string", format: "duration" }),
  bytes: leaf({ type: "string", contentEncoding: "base64" }),
  null: leaf({ type: "null" }),
  void: leaf({ type: "null" }),
  unknown: leaf({}),
  never: leaf({ not: {} }),
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const properties: Record<string, JsonSchema> = {}
    const required: string[] = []
    for (const [name, field] of Object.entries(s.fields)) {
      properties[name] = toJsonSchema(field)
      if (field.meta.optional !== true) required.push(name)
    }
    const schema: JsonSchema = { type: "object", properties }
    if (required.length > 0) schema.required = required
    return schema
  },
  // JSON Schema has no class-identity concept and `instance` carries no field
  // data to build `properties` from (it's purely nominal — see type-ir's
  // TypeKinds.instance doc comment). Degrade honestly to an untyped object
  // schema, carrying the class name as `x-class-name` (a vendor-extension-style
  // key, same convention as this package's OAS projectors' `x-*` fields) so
  // tooling that wants the identity back can still read it.
  instance: (shape) => {
    const s = shape as TypeShape & { kind: "instance" }
    return { type: "object", "x-class-name": s.className }
  },
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return { type: "array", items: toJsonSchema(s.element) }
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return { type: "array", prefixItems: s.elements.map(toJsonSchema), items: false }
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return { type: "object", additionalProperties: toJsonSchema(s.value) }
  },
  // JSON Schema 2019-09 §9.2.1.2 defines no `discriminator` keyword itself,
  // but the OpenAPI-originated `discriminator: { propertyName }` shape is a
  // widely-recognized extension (carried by `meta.discriminator`, an open
  // metadata bag convention — see CLAUDE.md). `oneOf` (exactly one variant
  // matches) is the correct composition keyword once a discriminator makes
  // variants mutually exclusive by construction; plain unions keep `anyOf`.
  union: (shape, meta) => {
    const s = shape as TypeShape & { kind: "union" }
    const variants = s.variants.map(toJsonSchema)
    if (typeof meta.discriminator === "string") {
      return { oneOf: variants, discriminator: { propertyName: meta.discriminator } }
    }
    return { anyOf: variants }
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    return { const: s.value }
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return { type: "string", enum: [...s.members] }
  },
  ref: (shape) => {
    const s = shape as TypeShape & { kind: "ref" }
    return { $ref: `#/$defs/${s.target}` }
  },
  // draft 2020-12 §10.2.1.1 `allOf`: every listed schema must validate — the
  // faithful encoding of a structural intersection (mixin composition).
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    return { allOf: s.members.map(toJsonSchema) }
  },
}

const complexKinds = new Set(["object", "instance", "array", "tuple", "map", "union", "intersection"])

export function toJsonSchema(ref: TypeRef): JsonSchema {
  const converter = resolve(ref.shape.kind, handlers)
  const schema = converter === undefined ? {} : converter(ref.shape, ref.meta)
  const complex = complexKinds.has(ref.shape.kind)
  return withMeta(schema, ref.meta, complex)
}
