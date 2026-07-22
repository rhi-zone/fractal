import { resolve, type TypeRef, type TypeRefDocument, type TypeShape } from "./index.ts"

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

  if (typeof meta.title === "string") result = { ...result, title: meta.title }
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

// Infers the JSON Schema `type` for an enum's members from their actual
// runtime types, rather than assuming `string` — an enum's members are
// frequently integers (or other primitives) carried verbatim from the
// source type system (see type-ir's TypeKinds.enum doc comment). Mixed-type
// membership (or a type JSON Schema has no single keyword for) omits `type`
// entirely and relies on `enum` alone, which is valid per draft 2020-12
// §6.1.2 (`type` is optional; `enum` alone still constrains to the listed
// values).
function enumSchema(members: readonly unknown[]): JsonSchema {
  if (members.length > 0 && members.every((m) => typeof m === "boolean")) {
    return { type: "boolean", enum: [...members] }
  }
  if (members.length > 0 && members.every((m) => typeof m === "number")) {
    const type = members.every((m) => Number.isInteger(m)) ? "integer" : "number"
    return { type, enum: [...members] }
  }
  if (members.length > 0 && members.every((m) => typeof m === "string")) {
    return { type: "string", enum: [...members] }
  }
  return { enum: [...members] }
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
  email: leaf({ type: "string", format: "email" }),
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
      let propSchema = toJsonSchema(field)
      // draft 2020-12 §9.5: `readOnly` is a per-schema annotation, driven by
      // the `meta.readonly` open-metadata-bag convention (see type-ir's
      // TypeRef doc comment) set on the field's own TypeRef.
      if (field.meta.readonly === true) propSchema = { ...propSchema, readOnly: true }
      properties[name] = propSchema
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
  // JSON Schema has no streaming/async-sequence vocabulary — degrades to the
  // same `array`-of-element shape used elsewhere for a materialized sequence,
  // carrying `x-stream: true` (vendor-extension-style key, same convention as
  // `x-class-name`/`x-function`) so tooling that cares can still tell a
  // stream apart from an ordinary array.
  stream: (shape) => {
    const s = shape as TypeShape & { kind: "stream" }
    return { type: "array", items: toJsonSchema(s.element), "x-stream": true }
  },
  // JSON Schema has no pagination vocabulary either — degrade to the same
  // array-of-element shape, carrying `x-page-style` (vendor-extension-style
  // key, same convention as `x-stream`) so tooling that cares can still tell
  // a paginated endpoint's items apart from a plain array.
  page: (shape) => {
    const s = shape as TypeShape & { kind: "page" }
    return { type: "array", items: toJsonSchema(s.element), "x-page-style": s.style }
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
    return enumSchema(s.members)
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
  // JSON Schema has no callable-type vocabulary — degrade honestly to an
  // untyped schema, carrying `x-function: true` (vendor-extension-style key,
  // same convention as `instance`'s `x-class-name`) so tooling that cares can
  // still detect the shape was a function.
  function: leaf({ "x-function": true }),
  // Same degrade as `function`, but carrying `x-method: true` instead of
  // `x-function: true` so tooling can distinguish "a standalone callable"
  // from "a callable that belongs to a type's contract" — an explicit entry
  // rather than relying on the `method` -> `function` parent fallback,
  // because the distinguishing vendor-extension key is the whole point here.
  method: leaf({ "x-method": true }),
  // JSON Schema has no service/interface-with-methods vocabulary either —
  // degrade to an untyped object schema, carrying `x-interface: true` (same
  // vendor-extension convention as `x-class-name`/`x-function`/`x-method`).
  interface: leaf({ type: "object", "x-interface": true }),
}

const complexKinds = new Set([
  "object",
  "instance",
  "array",
  "stream",
  "page",
  "tuple",
  "map",
  "union",
  "intersection",
  "function",
  "method",
  "interface",
])

export function toJsonSchema(ref: TypeRef): JsonSchema {
  const converter = resolve(ref.shape.kind, handlers)
  const schema = converter === undefined ? {} : converter(ref.shape, ref.meta)
  const complex = complexKinds.has(ref.shape.kind)
  return withMeta(schema, ref.meta, complex)
}

/**
 * Project a whole `TypeRefDocument` (see type-ir/src/index.ts) to a
 * self-contained JSON Schema: the root schema plus a top-level `$defs` object
 * — one entry per `doc.defs` name — that the `ref` handler's `#/$defs/NAME`
 * `$ref`s (see above) resolve against, per draft 2020-12 §8.2.4. `doc.defs`
 * empty or absent (a bare TypeRef wrapped via `typeRefDocument`) omits `$defs`
 * entirely, so this is a strict superset of calling `toJsonSchema(doc.root)`
 * directly for the no-sharing case.
 */
export function toJsonSchemaDocument(doc: TypeRefDocument): JsonSchema {
  const schema = toJsonSchema(doc.root)
  const defNames = Object.keys(doc.defs)
  if (defNames.length === 0) return schema
  const $defs: Record<string, JsonSchema> = {}
  for (const name of defNames) $defs[name] = toJsonSchema(doc.defs[name]!)
  return { ...schema, $defs }
}
