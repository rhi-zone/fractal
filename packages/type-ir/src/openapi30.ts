import { resolve, type TypeRef, type TypeShape } from "./index.ts"

export type OpenApi30Schema = Record<string, unknown>

// "minimum"/"maximum" are handled explicitly in withMeta (interacting with
// exclusiveMinimum/exclusiveMaximum), not passed through generically.
const passthroughKeys = ["minLength", "maxLength", "pattern", "multipleOf", "$comment"] as const

// OAS 3.0.3 §4.8.24 (Schema Object, "Composition and Inheritance") + §4.8.24.1
// use `nullable: true` — there is no type-array nullable in draft-05.
function withMeta(schema: OpenApi30Schema, meta: Readonly<Record<string, unknown>>): OpenApi30Schema {
  let result = schema

  if (meta.nullable === true) result = { ...result, nullable: true }

  if (typeof meta.description === "string") result = { ...result, description: meta.description }
  if (meta.deprecated === true) result = { ...result, deprecated: true }
  if (meta.default !== undefined) result = { ...result, default: meta.default }
  if (meta.example !== undefined) result = { ...result, example: meta.example }
  // OAS 3.0.3 §4.8.24.2 Properties table: readOnly/writeOnly are booleans,
  // mutually exclusive by spec ("a property MUST NOT be marked as both
  // readOnly and writeOnly being true") — passed through as-authored.
  if (meta.readOnly === true) result = { ...result, readOnly: true }
  if (meta.writeOnly === true) result = { ...result, writeOnly: true }

  // OAS 3.0.3 is restricted to a JSON Schema Wright Draft-05-based vocabulary
  // (§4.8.24), which still uses draft-04-style boolean exclusiveMinimum/
  // exclusiveMaximum modifiers on minimum/maximum — the numeric standalone
  // form arrives only with OAS 3.1's move to 2020-12. Same encoding as
  // json-schema-04.ts/openapi20.ts.
  if (meta.exclusiveMinimum !== undefined) {
    result = { ...result, minimum: meta.exclusiveMinimum, exclusiveMinimum: true }
  } else if (meta.minimum !== undefined) {
    result = { ...result, minimum: meta.minimum }
  }
  if (meta.exclusiveMaximum !== undefined) {
    result = { ...result, maximum: meta.exclusiveMaximum, exclusiveMaximum: true }
  } else if (meta.maximum !== undefined) {
    result = { ...result, maximum: meta.maximum }
  }

  for (const key of passthroughKeys) {
    if (meta[key] !== undefined) result = { ...result, [key]: meta[key] }
  }

  return result
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => OpenApi30Schema

const leaf =
  (schema: OpenApi30Schema): Converter =>
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
  duration: leaf({ type: "string" }),
  bytes: leaf({ type: "string", format: "byte" }),
  // OAS 3.0.3 §4.8.24.1 Properties: nullable is the substitute for a "null" type,
  // which draft-05-based OAS schemas do not have.
  null: leaf({ nullable: true }),
  void: leaf({ nullable: true }),
  unknown: leaf({}),
  never: leaf({ not: {} }),
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const properties: Record<string, OpenApi30Schema> = {}
    const required: string[] = []
    for (const [name, field] of Object.entries(s.fields)) {
      properties[name] = toOpenApi30(field)
      if (field.meta.optional !== true) required.push(name)
    }
    const schema: OpenApi30Schema = { type: "object", properties }
    if (required.length > 0) schema.required = required
    return schema
  },
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return { type: "array", items: toOpenApi30(s.element) }
  },
  // OAS 3.0.3 schemas are constrained to JSON Schema Wright Draft-04/-07 style
  // (§4.8.24), which lacks `prefixItems` (a 2020-12 addition) — tuples use
  // `items` as an array instead.
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return { type: "array", items: s.elements.map(toOpenApi30) }
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return { type: "object", additionalProperties: toOpenApi30(s.value) }
  },
  // OAS 3.0.3 §4.8.25 Discriminator Object: `discriminator.propertyName` names
  // the field OAS-aware tooling (codegen, some validators) reads to pick the
  // matching variant without trying each `oneOf` member — a native feature,
  // driven here by `meta.discriminator` (open metadata bag convention, see
  // CLAUDE.md). `oneOf` (not `anyOf`) is used once a discriminator is present,
  // since the variants are then mutually exclusive by construction.
  union: (shape, meta) => {
    const s = shape as TypeShape & { kind: "union" }
    const variants = s.variants.map(toOpenApi30)
    if (typeof meta.discriminator === "string") {
      return { oneOf: variants, discriminator: { propertyName: meta.discriminator } }
    }
    return { anyOf: variants }
  },
  // OAS 3.0.3 has no `const` (also a 2020-12 addition) — a single-value `enum`
  // is the equivalent.
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    return { enum: [s.value] }
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return { type: "string", enum: [...s.members] }
  },
  // OAS 3.0.3 §4.8.24.2: components live under `#/components/schemas/`, not
  // JSON Schema's `#/$defs/`.
  ref: (shape) => {
    const s = shape as TypeShape & { kind: "ref" }
    return { $ref: `#/components/schemas/${s.target}` }
  },
  // OAS 3.0.3 §4.8.24 inherits JSON Schema's `allOf` — the faithful encoding
  // of a structural intersection (mixin composition).
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    return { allOf: s.members.map(toOpenApi30) }
  },
  // OAS 3.0 has no callable-type concept — same vendor-extension degradation
  // as json-schema.ts's `x-function`.
  function: leaf({ "x-function": true }),
}

export function toOpenApi30(ref: TypeRef): OpenApi30Schema {
  const converter = resolve(ref.shape.kind, handlers)
  const schema = converter === undefined ? {} : converter(ref.shape, ref.meta)
  return withMeta(schema, ref.meta)
}
