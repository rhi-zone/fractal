import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// JSON Type Definition — RFC 8927. Eight schema forms (§2.2): empty, type,
// enum, elements, properties, values, discriminator, ref. All forms accept
// "nullable" (§2.2) and "metadata" (§2.2.7, explicitly ignored by validators —
// the official extension point for anything a form can't express).
export type Jtd = Record<string, unknown>

type ConverterResult = {
  readonly form: Jtd
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly forceNullable?: boolean
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => ConverterResult

const leaf =
  (form: Jtd): Converter =>
  () => ({ form })

// "optional" is consumed by the object handler (properties/optionalProperties
// split); "nullable" is consumed into the top-level "nullable" keyword.
// Everything else rides in "metadata" (§2.2.7).
const consumedMetaKeys = new Set(["nullable", "optional"])

function collectMetadata(meta: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (!consumedMetaKeys.has(key)) metadata[key] = value
  }
  return metadata
}

const handlers: Record<string, Converter> = {
  // RFC 8927 §3.3.2 — type form; JTD's type enum has no generic "number" or
  // "integer" nor an "int64", so those degrade to the closest fit.
  boolean: leaf({ type: "boolean" }),
  number: leaf({ type: "float64" }),
  integer: leaf({ type: "int32" }),
  int32: leaf({ type: "int32" }),
  int64: () => ({ form: {}, metadata: { type: "int64" } }),
  float32: leaf({ type: "float32" }),
  float64: leaf({ type: "float64" }),
  string: leaf({ type: "string" }),
  uuid: () => ({ form: { type: "string" }, metadata: { format: "uuid" } }),
  uri: () => ({ form: { type: "string" }, metadata: { format: "uri" } }),
  email: () => ({ form: { type: "string" }, metadata: { format: "email" } }),
  // RFC 8927 §3.3.2 — the "timestamp" type form is JTD's own native
  // representation of a language-level Date/DateTime value (spec: "the
  // instance is a string encoding of an RFC3339 timestamp"), matching
  // type-ir's datetime/date domain type (`Date`, not a wire-format string —
  // see kinds/date-time.ts). `date` reuses the same form (JS has no
  // calendar-only Date type to distinguish it from `datetime`).
  datetime: leaf({ type: "timestamp" }),
  date: leaf({ type: "timestamp" }),
  time: () => ({ form: { type: "string" }, metadata: { format: "time" } }),
  duration: () => ({ form: { type: "string" }, metadata: { format: "duration" } }),
  bytes: () => ({ form: { type: "string" }, metadata: { contentEncoding: "base64" } }),
  // RFC 8927 §3.3.1 — empty form (accepts anything). null/void have no direct
  // JTD equivalent; degrade to empty + forced nullable.
  null: () => ({ form: {}, forceNullable: true }),
  void: () => ({ form: {}, forceNullable: true }),
  unknown: leaf({}),
  never: () => ({ form: {}, metadata: { never: true } }),
  // RFC 8927 §3.3.5 — properties form
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const properties: Record<string, Jtd> = {}
    const optionalProperties: Record<string, Jtd> = {}
    for (const [name, field] of Object.entries(s.fields)) {
      if (field.meta.optional === true) optionalProperties[name] = toJtd(field)
      else properties[name] = toJtd(field)
    }
    const form: Jtd = { properties }
    if (Object.keys(optionalProperties).length > 0) form.optionalProperties = optionalProperties
    return { form }
  },
  // RFC 8927 §3.3.4 — elements form
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return { form: { elements: toJtd(s.element) } }
  },
  // JTD has no tuple form. Degrade to the first element's schema (lossy —
  // heterogeneity is not representable) and flag it in metadata.
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    const first = s.elements[0]
    return { form: { elements: first === undefined ? {} : toJtd(first) }, metadata: { tuple: true } }
  },
  // RFC 8927 §3.3.6 — values form (string-keyed map)
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return { form: { values: toJtd(s.value) } }
  },
  // JTD has no streaming/async-sequence form — degrades to the same elements
  // form the `array` handler above uses, flagged in metadata (§2.2.7's
  // extension point) so consumers can tell a stream apart from an ordinary
  // array.
  stream: (shape) => {
    const s = shape as TypeShape & { kind: "stream" }
    return { form: { elements: toJtd(s.element) }, metadata: { stream: true } }
  },
  // JTD's union equivalent (§3.3.7, discriminator form) requires a tag field
  // and object-shaped variants. General unions can't satisfy that; degrade to
  // empty + the variant schemas in metadata.
  union: (shape) => {
    const s = shape as TypeShape & { kind: "union" }
    return { form: {}, metadata: { union: s.variants.map(toJtd) } }
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    return typeof s.value === "string"
      ? { form: { enum: [s.value] } }
      : { form: {}, metadata: { const: s.value } }
  },
  // RFC 8927 §3.3.3 — enum form
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return { form: { enum: [...s.members] } }
  },
  // RFC 8927 §3.3.8 — ref form
  ref: (shape) => {
    const s = shape as TypeShape & { kind: "ref" }
    return { form: { ref: s.target } }
  },
  // JTD has no intersection form. Degrade to the first member's schema (lossy
  // — the rest are dropped) and flag it in metadata, same convention as tuple.
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    return { form: first === undefined ? {} : toJtd(first), metadata: { intersection: true } }
  },
  // JTD has no callable-type form — degrade to the empty form (accepts
  // anything), flagged in metadata (§2.2.7's extension point) like every
  // other unrepresentable case above.
  function: () => ({ form: {}, metadata: { function: true } }),
}

export function toJtd(ref: TypeRef): Jtd {
  const converter = resolve(ref.shape.kind, handlers)
  const result: ConverterResult = converter === undefined ? { form: {} } : converter(ref.shape, ref.meta)

  const schema: Jtd = { ...result.form }

  const metadata = collectMetadata(ref.meta)
  if (result.metadata !== undefined) Object.assign(metadata, result.metadata)
  if (Object.keys(metadata).length > 0) schema.metadata = metadata

  if (ref.meta.nullable === true || result.forceNullable === true) schema.nullable = true

  return schema
}
