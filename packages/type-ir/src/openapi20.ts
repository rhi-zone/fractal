import { resolve, type TypeRef, type TypeShape } from "./index.ts"

export type OpenApi20Schema = Record<string, unknown>

// Swagger 2.0 spec §4.6 (Data Types) + §4.7.4 (Schema Object): the vocabulary is
// draft-04 JSON Schema restricted further — no allOf-free polymorphism keywords
// beyond `allOf` itself (no `oneOf`/`anyOf`/`not`), `type` MUST be a single string
// (no type arrays), and there is no `nullable`/`deprecated`/`examples` keyword
// (those are OAS 3.0 additions). Vendor extensions (`x-*`, §4.7.26 Specification
// Extensions) are the only escape hatch for concepts the format has no slot for.
// "minimum"/"maximum" are handled explicitly in withMeta (interacting with
// exclusiveMinimum/exclusiveMaximum), not passed through generically.
const passthroughKeys = ["minLength", "maxLength", "pattern", "multipleOf"] as const

// Swagger 2.0 §4.7.4: Schema Object supports `readOnly` (boolean) directly.
// `writeOnly` was only added in OAS 3.0 — there is no vendor-extension
// convention worth inventing for it, so it is dropped (lossy).
function withMeta(schema: OpenApi20Schema, meta: Readonly<Record<string, unknown>>): OpenApi20Schema {
  let result = schema

  // Swagger 2.0 has no `nullable` keyword and `type` cannot be an array
  // (§4.7.4: "type - Value MUST be a string."), so there is no standard way to
  // express nullability at all. `x-nullable` is the de facto convention
  // (used by Autorest, drf-yasg, and other Swagger 2.0 tooling).
  if (meta.nullable === true) result = { ...result, "x-nullable": true }

  if (typeof meta.description === "string") result = { ...result, description: meta.description }
  // `deprecated` on Schema Object is an OAS 3.0 addition; no standard Swagger
  // 2.0 equivalent, so it travels as a vendor extension instead.
  if (meta.deprecated === true) result = { ...result, "x-deprecated": true }
  if (meta.default !== undefined) result = { ...result, default: meta.default }
  // Swagger 2.0 §4.7.4 Schema Object has a singular `example` field; the
  // plural `examples` map is an OAS 3.0 Media Type Object concept.
  if (meta.example !== undefined) result = { ...result, example: meta.example }
  if (meta.readOnly === true) result = { ...result, readOnly: true }

  // Swagger 2.0's Schema Object (§4.7.4) borrows its numeric-validation
  // vocabulary from JSON Schema draft-04, where exclusiveMinimum/
  // exclusiveMaximum are booleans that modify `minimum`/`maximum` rather than
  // standalone numbers (that numeric form is a later, non-draft-04 JSON
  // Schema addition) — same encoding as json-schema-04.ts.
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

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => OpenApi20Schema

const leaf =
  (schema: OpenApi20Schema): Converter =>
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
  // Swagger 2.0 Data Type Format table (§4.6) lists `byte` (base64-encoded
  // string) and `binary` (raw octets) formats for `type: string`.
  bytes: leaf({ type: "string", format: "byte" }),
  // No `type: "null"` and no `nullable` keyword exist in Swagger 2.0 — the
  // closest available signal is the same `x-nullable` vendor convention used
  // for `meta.nullable` (see withMeta), applied to an otherwise-typeless
  // schema since there is no scalar "null" type to declare.
  null: leaf({ "x-nullable": true }),
  void: leaf({ "x-nullable": true }),
  unknown: leaf({}),
  // Swagger 2.0 has no `not` keyword (dropped from the OAS 2.0 JSON Schema
  // subset, §4.7.4). There is no faithful way to express "no value satisfies
  // this schema" in the format; `x-never` marks the intent as a vendor
  // extension rather than silently degrading to an unconstrained schema.
  never: leaf({ "x-never": true }),
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const properties: Record<string, OpenApi20Schema> = {}
    const required: string[] = []
    for (const [name, field] of Object.entries(s.fields)) {
      let propSchema = toOpenApi20(field)
      // Swagger 2.0 §4.7.4: `readOnly` is a per-schema annotation, driven by
      // the `meta.readonly` open-metadata-bag convention set on the field's
      // own TypeRef (distinct from `meta.readOnly`, handled in withMeta above
      // for schemas that carry the OAS-cased key directly).
      if (field.meta.readonly === true) propSchema = { ...propSchema, readOnly: true }
      properties[name] = propSchema
      if (field.meta.optional !== true) required.push(name)
    }
    const schema: OpenApi20Schema = { type: "object", properties }
    if (required.length > 0) schema.required = required
    return schema
  },
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return { type: "array", items: toOpenApi20(s.element) }
  },
  // Swagger 2.0 §4.7.4: "items - Required if type is array. Value MUST be an
  // object and not an array." There is no tuple-validation form at all (no
  // `prefixItems`, no array-form `items`) — encoding a tuple is inherently
  // lossy. When every element shares the same kind we use that shape as the
  // (accurate) common `items` schema; otherwise we fall back to the empty
  // schema (any value), which is the least-wrong approximation of a mixed
  // tuple's element type.
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    const items = s.elements.map(toOpenApi20)
    const [first, ...rest] = items
    const homogeneous = first !== undefined && rest.every((item) => sameShape(item, first))
    return { type: "array", items: homogeneous ? first : {} }
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return { type: "object", additionalProperties: toOpenApi20(s.value) }
  },
  // Swagger 2.0 has no streaming/async-sequence vocabulary — degrades to the
  // same `array`-of-element shape used for a materialized sequence, carrying
  // `x-stream: true` (vendor-extension-style key, same convention as
  // `x-function`/`x-interface` below).
  stream: (shape) => {
    const s = shape as TypeShape & { kind: "stream" }
    return { type: "array", items: toOpenApi20(s.element), "x-stream": true }
  },
  // Swagger 2.0 has no `oneOf`/`anyOf` (both OAS 3.0 additions — the only
  // JSON Schema combinator it kept was `allOf`, used solely for the
  // discriminator/inheritance pattern in §4.7.4). A union of variants has no
  // faithful encoding; the empty schema (any value) accepts every variant
  // (and more), with `x-oneOf` carrying the lossless variant list as a
  // vendor extension for tooling that wants it.
  union: (shape, meta) => {
    const s = shape as TypeShape & { kind: "union" }
    const schema: OpenApi20Schema = { "x-oneOf": s.variants.map(toOpenApi20) }
    // Swagger 2.0 §4.7.4: `discriminator` is a *string* naming the property
    // (unlike OAS 3.0's Discriminator Object with a `propertyName` field) —
    // driven by `meta.discriminator` (open metadata bag convention, see
    // CLAUDE.md), same as the other projectors' discriminator support.
    if (typeof meta.discriminator === "string") schema.discriminator = meta.discriminator
    return schema
  },
  // No `const` keyword in draft-04 — same substitution as JSON Schema/OAS 3.0.
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    return { enum: [s.value] }
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return { type: "string", enum: [...s.members] }
  },
  // Swagger 2.0 §4.7.4 Schema Object `$ref` resolves against the top-level
  // `definitions` map, not `#/components/schemas/` (an OAS 3.0 rename).
  ref: (shape) => {
    const s = shape as TypeShape & { kind: "ref" }
    return { $ref: `#/definitions/${s.target}` }
  },
  // Swagger 2.0 §4.7.4 keeps `allOf` from its JSON Schema draft-04 base (the
  // only polymorphism keyword it kept) — the faithful encoding of a
  // structural intersection (mixin composition).
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    return { allOf: s.members.map(toOpenApi20) }
  },
  // Swagger 2.0 has no callable-type concept — same vendor-extension
  // degradation as json-schema.ts's `x-function`.
  function: leaf({ "x-function": true }),
  // Same degrade as `function`, distinguished by `x-method: true`.
  method: leaf({ "x-method": true }),
  // Swagger 2.0 has no service/interface-with-methods concept — degrade to
  // an untyped object schema carrying `x-interface: true`.
  interface: leaf({ type: "object", "x-interface": true }),
}

function sameShape(a: OpenApi20Schema, b: OpenApi20Schema): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function toOpenApi20(ref: TypeRef): OpenApi20Schema {
  const converter = resolve(ref.shape.kind, handlers)
  const schema = converter === undefined ? {} : converter(ref.shape, ref.meta)
  return withMeta(schema, ref.meta)
}

// Swagger 2.0 §2.2/§4.7.4: schemas referenced via `#/definitions/Name` live in
// the top-level `definitions` map of the Swagger Object, keyed by name.
export function toOpenApi20Definitions(refs: Readonly<Record<string, TypeRef>>): Record<string, OpenApi20Schema> {
  const definitions: Record<string, OpenApi20Schema> = {}
  for (const [name, ref] of Object.entries(refs)) {
    definitions[name] = toOpenApi20(ref)
  }
  return definitions
}
