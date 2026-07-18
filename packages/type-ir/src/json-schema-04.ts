import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// JSON Schema draft-04: https://json-schema.org/specification-links.html#draft-4
// (draft-zyp-json-schema-04). Divergences from draft-07 / latest (json-schema.ts,
// json-schema-07.ts) handled below:
//
// - $schema: "http://json-schema.org/draft-04/schema#" (draft-04 §6)
// - "id" not "$id" (draft-04 §7.2; $id arrives in draft-06)
// - No `const` (introduced draft-06) — literals become `enum: [value]`
// - No `if`/`then`/`else` (introduced draft-07)
// - $ref targets `#/definitions/...` (draft-04 §7.2.3, same path as draft-07;
//   `$defs` arrives in draft-2019-09)
// - No boolean schemas (`true`/`false` as a schema; introduced draft-06) — `never`
//   must use `{ "not": {} }` instead of the literal `false` draft-07 uses
// - `items` as an array for tuples + `additionalItems: false` (draft-04 §5.3.1;
//   same shape as draft-07 — the array-of-schemas form for `items` is what
//   draft-2020-12 renamed to `prefixItems`)
// - No `type` array for nullable (the `["string", "null"]` form is not defined by
//   draft-04's `type` keyword usage the way later drafts commonly use it as a
//   union-of-types — draft-04 §5.5.2 does permit `type` as an array of the seven
//   primitive type names, but to keep the nullable encoding uniform and safely
//   composable with other keywords we always use `anyOf: [schema, {type:"null"}]`)
// - No `examples` (introduced draft-06)
// - `exclusiveMinimum`/`exclusiveMaximum` are booleans that modify `minimum`/
//   `maximum` (draft-04 §5.1.1/§5.1.2), not standalone numbers (that numeric form
//   arrives in draft-06)
// - No `propertyNames` (introduced draft-06)
// - No `readOnly`/`writeOnly` (introduced draft-07) — `meta.readonly` on a
//   field is silently dropped rather than emitting a keyword draft-04 doesn't
//   define
export type JsonSchema04 = Record<string, unknown>

// `$comment` is a draft-07+ keyword (json-schema.org draft-07 §10.1) — not part
// of draft-04's vocabulary, so it is excluded here (unlike json-schema-07.ts/
// json-schema.ts, and unlike openapi30.ts which also passes it through).
const passthroughKeys = ["minLength", "maxLength", "pattern", "multipleOf"] as const

function applyNumericBounds(schema: JsonSchema04, meta: Readonly<Record<string, unknown>>): JsonSchema04 {
  let result = schema

  // draft-04 §5.1.1: exclusiveMinimum is a boolean modifier on `minimum`.
  if (meta.exclusiveMinimum !== undefined) {
    result = { ...result, minimum: meta.exclusiveMinimum, exclusiveMinimum: true }
  } else if (meta.minimum !== undefined) {
    result = { ...result, minimum: meta.minimum }
  }

  // draft-04 §5.1.2: exclusiveMaximum is a boolean modifier on `maximum`.
  if (meta.exclusiveMaximum !== undefined) {
    result = { ...result, maximum: meta.exclusiveMaximum, exclusiveMaximum: true }
  } else if (meta.maximum !== undefined) {
    result = { ...result, maximum: meta.maximum }
  }

  return result
}

function withMeta(schema: JsonSchema04, meta: Readonly<Record<string, unknown>>): JsonSchema04 {
  let result = schema

  // draft-04 has no `type` array nor `anyOf`-free nullable idiom distinct from
  // later drafts' `["T", "null"]` shorthand — always wrap in anyOf.
  if (meta.nullable === true) {
    result = { anyOf: [result, { type: "null" }] }
  }

  if (typeof meta.description === "string") result = { ...result, description: meta.description }
  if (meta.deprecated === true) result = { ...result, deprecated: true }
  if (meta.default !== undefined) result = { ...result, default: meta.default }

  result = applyNumericBounds(result, meta)

  for (const key of passthroughKeys) {
    if (meta[key] !== undefined) result = { ...result, [key]: meta[key] }
  }

  return result
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => JsonSchema04

const leaf =
  (schema: JsonSchema04): Converter =>
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
  // draft-04 has no boolean schemas (that arrives draft-06), so `never` cannot be
  // encoded as the literal `false` the way json-schema-07.ts does — use `not: {}`.
  never: leaf({ not: {} }),
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const properties: Record<string, JsonSchema04> = {}
    const required: string[] = []
    for (const [name, field] of Object.entries(s.fields)) {
      properties[name] = toJsonSchema04(field)
      if (field.meta.optional !== true) required.push(name)
    }
    const schema: JsonSchema04 = { type: "object", properties }
    if (required.length > 0) schema.required = required
    return schema
  },
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return { type: "array", items: toJsonSchema04(s.element) }
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    // draft-04 §5.3.1: `items` as an array of schemas positionally validates a
    // tuple; `additionalItems: false` forbids extra elements.
    return { type: "array", items: s.elements.map(toJsonSchema04), additionalItems: false }
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return { type: "object", additionalProperties: toJsonSchema04(s.value) }
  },
  // draft-04 §5.5.4 defines `oneOf` (exactly one variant matches) but no
  // `discriminator` keyword; the OpenAPI-originated `discriminator: { propertyName }`
  // shape is a widely-recognized extension (carried by `meta.discriminator`, an open
  // metadata bag convention — see CLAUDE.md), same as json-schema.ts's latest projector.
  union: (shape, meta) => {
    const s = shape as TypeShape & { kind: "union" }
    const variants = s.variants.map(toJsonSchema04)
    if (typeof meta.discriminator === "string") {
      return { oneOf: variants, discriminator: { propertyName: meta.discriminator } }
    }
    return { anyOf: variants }
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    // draft-04 has no `const` (introduced draft-06) — use a single-member enum.
    return { enum: [s.value] }
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return { type: "string", enum: [...s.members] }
  },
  ref: (shape) => {
    const s = shape as TypeShape & { kind: "ref" }
    return { $ref: `#/definitions/${s.target}` }
  },
  // draft-04 §5.5.3 `allOf`: every listed schema must validate — the faithful
  // encoding of a structural intersection (mixin composition), unchanged from
  // later drafts.
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    return { allOf: s.members.map(toJsonSchema04) }
  },
  // draft-04 has no callable-type vocabulary either — same honest degradation
  // json-schema.ts (latest draft) uses: an untyped schema carrying
  // `x-function: true`.
  function: leaf({ "x-function": true }),
  // Same degrade as `function`, distinguished by `x-method: true` (a
  // standalone callable vs. one belonging to a type's contract).
  method: leaf({ "x-method": true }),
  // draft-04 has no service/interface-with-methods vocabulary either —
  // degrade to an untyped object schema carrying `x-interface: true`.
  interface: leaf({ type: "object", "x-interface": true }),
}

export function toJsonSchema04(ref: TypeRef): JsonSchema04 {
  const converter = resolve(ref.shape.kind, handlers)
  const schema = converter === undefined ? {} : converter(ref.shape, ref.meta)
  return withMeta(schema, ref.meta)
}

// Declaration helpers ---------------------------------------------------------
//
// A "declaration" wraps a top-level TypeRef with draft-04's document-level
// keywords ($schema, id, definitions) rather than the per-node keywords toJsonSchema04
// produces.

export interface JsonSchema04Declaration {
  readonly id?: string
  readonly definitions?: Readonly<Record<string, TypeRef>>
}

export function toJsonSchema04Document(
  ref: TypeRef,
  declaration: JsonSchema04Declaration = {},
): JsonSchema04 {
  const schema: JsonSchema04 = {
    $schema: "http://json-schema.org/draft-04/schema#",
    ...toJsonSchema04(ref),
  }

  if (declaration.id !== undefined) schema.id = declaration.id

  if (declaration.definitions !== undefined) {
    const definitions: Record<string, JsonSchema04> = {}
    for (const [name, defRef] of Object.entries(declaration.definitions)) {
      definitions[name] = toJsonSchema04(defRef)
    }
    schema.definitions = definitions
  }

  return schema
}
