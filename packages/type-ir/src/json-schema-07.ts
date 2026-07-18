import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// JSON Schema draft-07: https://json-schema.org/draft-07/json-schema-release-notes
// Differences from draft 2020-12 handled below: tuples (items array + additionalItems),
// $ref target (#/definitions/...), and never (boolean `false` schema, since draft-07
// permits boolean schemas).
export type JsonSchema07 = Record<string, unknown>

const passthroughKeys = [
  "minimum",
  "maximum",
  // draft-07 §6.2/§6.3: exclusiveMinimum/exclusiveMaximum are numbers (since
  // draft-06 — draft-04's boolean-modifier form lives in json-schema-04.ts).
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "multipleOf",
  "$comment",
  // draft-07 §10: readOnly/writeOnly are draft-07 additions; examples arrives
  // in draft-06. (draft-04 has neither — see json-schema-04.ts.)
  "readOnly",
  "writeOnly",
] as const

function withMeta(schema: JsonSchema07, meta: Readonly<Record<string, unknown>>, complex: boolean): JsonSchema07 {
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
  // draft-07 §10.4: "examples" is an array of example values (distinct from
  // OAS's singular "example").
  if (Array.isArray(meta.examples)) result = { ...result, examples: meta.examples }

  for (const key of passthroughKeys) {
    if (meta[key] !== undefined) result = { ...result, [key]: meta[key] }
  }

  return result
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => JsonSchema07

const leaf =
  (schema: JsonSchema07): Converter =>
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
  never: leaf(false as unknown as JsonSchema07),
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const properties: Record<string, JsonSchema07> = {}
    const required: string[] = []
    for (const [name, field] of Object.entries(s.fields)) {
      properties[name] = toJsonSchema07(field)
      if (field.meta.optional !== true) required.push(name)
    }
    const schema: JsonSchema07 = { type: "object", properties }
    if (required.length > 0) schema.required = required
    return schema
  },
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return { type: "array", items: toJsonSchema07(s.element) }
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return { type: "array", items: s.elements.map(toJsonSchema07), additionalItems: false }
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return { type: "object", additionalProperties: toJsonSchema07(s.value) }
  },
  // draft-07 §9.2.1.3 defines `oneOf` (exactly one variant matches) but no
  // `discriminator` keyword; the OpenAPI-originated `discriminator: { propertyName }`
  // shape is a widely-recognized extension (carried by `meta.discriminator`, an open
  // metadata bag convention — see CLAUDE.md), same as json-schema.ts's latest projector.
  union: (shape, meta) => {
    const s = shape as TypeShape & { kind: "union" }
    const variants = s.variants.map(toJsonSchema07)
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
    return { $ref: `#/definitions/${s.target}` }
  },
  // draft-07 §9.2.1.1 `allOf`: every listed schema must validate — the
  // faithful encoding of a structural intersection (mixin composition).
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    return { allOf: s.members.map(toJsonSchema07) }
  },
  // draft-07 has no callable-type vocabulary either — same honest degradation
  // json-schema.ts (latest draft) uses: an untyped schema carrying
  // `x-function: true`.
  function: leaf({ "x-function": true }),
  // Same degrade as `function`, distinguished by `x-method: true` (a
  // standalone callable vs. one belonging to a type's contract).
  method: leaf({ "x-method": true }),
  // draft-07 has no service/interface-with-methods vocabulary either —
  // degrade to an untyped object schema carrying `x-interface: true`.
  interface: leaf({ type: "object", "x-interface": true }),
}

const complexKinds = new Set([
  "object",
  "array",
  "tuple",
  "map",
  "union",
  "intersection",
  "function",
  "method",
  "interface",
])

export function toJsonSchema07(ref: TypeRef): JsonSchema07 {
  const converter = resolve(ref.shape.kind, handlers)
  const schema = converter === undefined ? {} : converter(ref.shape, ref.meta)
  const complex = complexKinds.has(ref.shape.kind)
  return withMeta(schema, ref.meta, complex)
}
