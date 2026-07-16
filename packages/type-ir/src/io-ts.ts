// io-ts codec code projector. Emits io-ts codec source text, not runtime schemas.
// Spec: https://github.com/gcanti/io-ts (Basic types, Mixed, Interface (`type`),
// Partial, Intersection, Array, Tuple, Record, Union, Literal, Keyof).
// Note: unlike Zod/Valibot, io-ts's primitive codecs are *values*, not factory calls
// (`t.string`, not `t.string()`) — only the combinator codecs (`t.type`, `t.array`, …)
// are function calls.
import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target)
}

function quoteKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)
}

type Expr = { readonly code: string; readonly note?: string }
type Converter = (shape: TypeShape) => Expr

const leaf =
  (code: string, note?: string): Converter =>
  () =>
    note === undefined ? { code } : { code, note }

// io-ts has no format-specific codecs (uuid, datetime, …): fall back to the nearest
// built-in primitive and record the lost subtype as a comment.
const handlers: Record<string, Converter> = {
  boolean: leaf("t.boolean"),
  number: leaf("t.number"),
  integer: leaf("t.number", "integer"),
  int32: leaf("t.number", "int32"),
  int64: leaf("t.number", "int64"),
  float32: leaf("t.number", "float32"),
  float64: leaf("t.number", "float64"),
  string: leaf("t.string"),
  uuid: leaf("t.string", "uuid"),
  uri: leaf("t.string", "uri"),
  datetime: leaf("t.string", "datetime"),
  date: leaf("t.string", "date"),
  time: leaf("t.string", "time"),
  duration: leaf("t.string", "duration"),
  bytes: leaf("t.string", "bytes"),
  null: leaf("t.null"),
  void: leaf("t.void"),
  unknown: leaf("t.unknown"),
  never: leaf("t.never"),
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const entries = Object.entries(s.fields)
    const required = entries.filter(([, field]) => field.meta.optional !== true)
    const optional = entries.filter(([, field]) => field.meta.optional === true)

    const props = (fields: readonly (readonly [string, TypeRef])[]): string =>
      `{ ${fields.map(([name, field]) => `${quoteKey(name)}: ${toIoTs(field)}`).join(", ")} }`

    if (optional.length === 0) return { code: `t.type(${props(required)})` }
    if (required.length === 0) return { code: `t.partial(${props(optional)})` }
    return { code: `t.intersection([t.type(${props(required)}), t.partial(${props(optional)})])` }
  },
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return { code: `t.array(${toIoTs(s.element)})` }
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return { code: `t.tuple([${s.elements.map(toIoTs).join(", ")}])` }
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return { code: `t.record(t.string, ${toIoTs(s.value)})` }
  },
  union: (shape) => {
    const s = shape as TypeShape & { kind: "union" }
    return { code: `t.union([${s.variants.map(toIoTs).join(", ")}])` }
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    // io-ts's t.literal accepts string | number | boolean only — null has its own codec.
    if (s.value === null) return { code: "t.null" }
    return { code: `t.literal(${JSON.stringify(s.value)})` }
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    const members = s.members.map((m) => `${quoteKey(m)}: null`).join(", ")
    return { code: `t.keyof({ ${members} })` }
  },
  ref: (shape) => {
    const s = shape as TypeShape & { kind: "ref" }
    return { code: s.target }
  },
}

function constraintNotes(meta: Readonly<Record<string, unknown>>, kind: string): string[] {
  const numberLike = isA(kind, "number")
  const stringLike = isA(kind, "string")
  const lengthConstrainable = stringLike || kind === "array"

  const notes: string[] = []
  if (typeof meta.minimum === "number" && numberLike) notes.push(`minimum: ${meta.minimum}`)
  if (typeof meta.maximum === "number" && numberLike) notes.push(`maximum: ${meta.maximum}`)
  if (typeof meta.minLength === "number" && lengthConstrainable) notes.push(`minLength: ${meta.minLength}`)
  if (typeof meta.maxLength === "number" && lengthConstrainable) notes.push(`maxLength: ${meta.maxLength}`)
  if (typeof meta.pattern === "string" && stringLike) notes.push(`pattern: ${JSON.stringify(meta.pattern)}`)
  if (typeof meta.multipleOf === "number" && numberLike) notes.push(`multipleOf: ${meta.multipleOf}`)
  if (typeof meta.description === "string") notes.push(`description: ${JSON.stringify(meta.description)}`)
  if (meta.default !== undefined) notes.push(`default: ${JSON.stringify(meta.default)}`)
  return notes
}

export function toIoTs(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  const { code, note } = converter === undefined ? { code: "t.unknown", note: undefined } : converter(ref.shape)

  // io-ts has no constraint or format-refinement codecs built in (min/max/length/pattern,
  // uuid/datetime/…): surface everything io-ts can't express as a trailing comment.
  const notes = [...(note !== undefined ? [note] : []), ...constraintNotes(ref.meta, ref.shape.kind)]
  const expr = notes.length > 0 ? `${code} /* ${notes.join(", ")} */` : code

  return ref.meta.nullable === true ? `t.union([${expr}, t.null])` : expr
}

export function toIoTsDeclaration(name: string, ref: TypeRef): string {
  return `const ${name} = ${toIoTs(ref)};`
}

export function toIoTsDeclarations(registry: Record<string, TypeRef>): string {
  const declarations = Object.entries(registry).map(([name, ref]) => toIoTsDeclaration(name, ref))
  return [`import * as t from "io-ts";`, "", ...declarations].join("\n")
}
