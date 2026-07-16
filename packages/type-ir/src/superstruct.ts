// Superstruct schema code projector. Emits Superstruct schema source text, not runtime schemas.
// Spec: https://docs.superstructjs.org/ (Types, Refinements, Coercions).
// Superstruct has no native string-format validators (uuid, datetime, date, time, duration,
// base64) — those fall back to `s.string()` with a trailing comment naming the intended format.
import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target)
}

function quoteKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)
}

function regexLiteral(pattern: string): string {
  return `/${pattern.replace(/\//g, "\\/")}/`
}

function withMeta(expr: string, meta: Readonly<Record<string, unknown>>, kind: string): string {
  let result = expr

  const numberLike = isA(kind, "number")
  const stringLike = isA(kind, "string")
  const sizeConstrainable = stringLike || kind === "array"

  const hasMinLength = typeof meta.minLength === "number" && sizeConstrainable
  const hasMaxLength = typeof meta.maxLength === "number" && sizeConstrainable
  if (hasMinLength && hasMaxLength) {
    result = `s.size(${result}, ${meta.minLength}, ${meta.maxLength})`
  } else if (hasMinLength) {
    result = `s.size(${result}, ${meta.minLength}, Infinity)`
  } else if (hasMaxLength) {
    result = `s.size(${result}, 0, ${meta.maxLength})`
  }

  if (typeof meta.pattern === "string" && stringLike) {
    result = `s.pattern(${result}, ${regexLiteral(meta.pattern)})`
  }

  if (typeof meta.minimum === "number" && numberLike) result = `s.min(${result}, ${meta.minimum})`
  if (typeof meta.maximum === "number" && numberLike) result = `s.max(${result}, ${meta.maximum})`

  if (typeof meta.multipleOf === "number" && numberLike) {
    result = `s.refine(${result}, "multipleOf", (value) => value % ${meta.multipleOf} === 0)`
  }

  if (meta.nullable === true) result = `s.nullable(${result})`

  if (typeof meta.description === "string") result += ` /* ${meta.description} */`

  if (meta.default !== undefined) result = `s.defaulted(${result}, ${JSON.stringify(meta.default)})`

  return result
}

type Converter = (shape: TypeShape) => string

const leaf =
  (expr: string): Converter =>
  () =>
    expr

const handlers: Record<string, Converter> = {
  boolean: leaf("s.boolean()"),
  number: leaf("s.number()"),
  integer: leaf("s.integer()"),
  int32: leaf("s.integer()"),
  int64: leaf("s.integer()"),
  float32: leaf("s.number()"),
  float64: leaf("s.number()"),
  string: leaf("s.string()"),
  uuid: leaf("s.string() /* uuid */"),
  uri: leaf("s.string() /* uri */"),
  datetime: leaf("s.string() /* datetime */"),
  date: leaf("s.string() /* date */"),
  time: leaf("s.string() /* time */"),
  duration: leaf("s.string() /* duration */"),
  bytes: leaf("s.string() /* base64 */"),
  null: leaf("s.literal(null)"),
  void: leaf("s.any() /* void */"),
  unknown: leaf("s.unknown()"),
  never: leaf("s.never()"),
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const fields = Object.entries(s.fields).map(([name, field]) => {
      const expr = toSuperstruct(field)
      const wrapped = field.meta.optional === true ? `s.optional(${expr})` : expr
      return `${quoteKey(name)}: ${wrapped}`
    })
    return `s.object({ ${fields.join(", ")} })`
  },
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return `s.array(${toSuperstruct(s.element)})`
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return `s.tuple([${s.elements.map(toSuperstruct).join(", ")}])`
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return `s.record(s.string(), ${toSuperstruct(s.value)})`
  },
  union: (shape) => {
    const s = shape as TypeShape & { kind: "union" }
    return `s.union([${s.variants.map(toSuperstruct).join(", ")}])`
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    return `s.literal(${JSON.stringify(s.value)})`
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return `s.enums([${s.members.map((m) => JSON.stringify(m)).join(", ")}])`
  },
  ref: (shape) => {
    const s = shape as TypeShape & { kind: "ref" }
    return s.target
  },
  // Superstruct has no intersection combinator — lossy fallback: the first
  // member's schema, dropping the rest.
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    return first === undefined ? "s.unknown()" : toSuperstruct(first)
  },
}

export function toSuperstruct(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  const expr = converter === undefined ? "s.unknown()" : converter(ref.shape)
  return withMeta(expr, ref.meta, ref.shape.kind)
}

export function toSuperstructDeclaration(name: string, ref: TypeRef): string {
  return `const ${name} = ${toSuperstruct(ref)};`
}

export function toSuperstructDeclarations(registry: Record<string, TypeRef>): string {
  const declarations = Object.entries(registry).map(([name, ref]) => toSuperstructDeclaration(name, ref))
  return [`import * as s from "superstruct";`, "", ...declarations].join("\n")
}
