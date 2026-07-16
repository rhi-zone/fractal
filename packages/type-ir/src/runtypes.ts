// runtypes code projector. Emits runtypes schema source text, not runtime schemas.
// Spec: https://github.com/pelotom/runtypes (v6.x API — Record/Dictionary naming,
// pre-rename to Object/Record in v7). Reference: Runtype base methods (optional,
// nullable, withConstraint), Record (mixed required/optional fields via per-field
// .optional()), Dictionary (arbitrary-key maps), Tuple/Union (variadic constructors).
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

const INTEGER_CHECK = `.withConstraint((n) => Number.isInteger(n) || "must be an integer")`

function withMeta(expr: string, meta: Readonly<Record<string, unknown>>, kind: string): string {
  let result = expr

  const numberLike = isA(kind, "number")
  const stringLike = isA(kind, "string")
  const lengthConstrainable = stringLike || kind === "array"

  if (typeof meta.exclusiveMinimum === "number" && numberLike)
    result += `.withConstraint((n) => n > ${meta.exclusiveMinimum} || "must be > ${meta.exclusiveMinimum}")`
  else if (typeof meta.minimum === "number" && numberLike)
    result += `.withConstraint((n) => n >= ${meta.minimum} || "must be >= ${meta.minimum}")`
  if (typeof meta.exclusiveMaximum === "number" && numberLike)
    result += `.withConstraint((n) => n < ${meta.exclusiveMaximum} || "must be < ${meta.exclusiveMaximum}")`
  else if (typeof meta.maximum === "number" && numberLike)
    result += `.withConstraint((n) => n <= ${meta.maximum} || "must be <= ${meta.maximum}")`
  if (typeof meta.minLength === "number" && lengthConstrainable)
    result += `.withConstraint((v) => v.length >= ${meta.minLength} || "length must be >= ${meta.minLength}")`
  if (typeof meta.maxLength === "number" && lengthConstrainable)
    result += `.withConstraint((v) => v.length <= ${meta.maxLength} || "length must be <= ${meta.maxLength}")`
  if (typeof meta.pattern === "string" && stringLike)
    result += `.withConstraint((v) => ${regexLiteral(meta.pattern)}.test(v) || "must match ${meta.pattern}")`
  if (typeof meta.multipleOf === "number" && numberLike)
    result += `.withConstraint((n) => n % ${meta.multipleOf} === 0 || "must be a multiple of ${meta.multipleOf}")`

  if (meta.nullable === true) result += ".nullable()"
  // runtypes has no .describe()/.default() — fall back to a comment, same as the
  // format-validator fallback below (no built-in uuid/email/etc. validators either).
  if (typeof meta.description === "string") result += ` /* ${meta.description} */`
  if (meta.default !== undefined) result += ` /* default: ${JSON.stringify(meta.default)} */`

  return result
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string

const leaf =
  (expr: string): Converter =>
  () =>
    expr

const handlers: Record<string, Converter> = {
  boolean: leaf("R.Boolean"),
  number: leaf("R.Number"),
  integer: leaf(`R.Number${INTEGER_CHECK}`),
  int32: leaf(`R.Number${INTEGER_CHECK}`),
  int64: leaf(`R.Number${INTEGER_CHECK}`),
  float32: leaf("R.Number"),
  float64: leaf("R.Number"),
  string: leaf("R.String"),
  // No built-in format validators (uuid, email, url, etc.) — fall back to R.String
  // with a comment naming the intended format.
  uuid: leaf("R.String /* uuid */"),
  uri: leaf("R.String /* uri */"),
  datetime: leaf("R.String /* datetime */"),
  date: leaf("R.String /* date */"),
  time: leaf("R.String /* time */"),
  duration: leaf("R.String /* duration */"),
  bytes: leaf("R.String /* bytes, base64 */"),
  null: leaf("R.Null"),
  void: leaf("R.Undefined"),
  unknown: leaf("R.Unknown"),
  never: leaf("R.Never"),
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const fields = Object.entries(s.fields).map(([name, field]) => {
      const expr = toRuntypes(field)
      const optional = field.meta.optional === true ? ".optional()" : ""
      return `${quoteKey(name)}: ${expr}${optional}`
    })
    return `R.Record({ ${fields.join(", ")} })`
  },
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return `R.Array(${toRuntypes(s.element)})`
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return `R.Tuple(${s.elements.map(toRuntypes).join(", ")})`
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return `R.Dictionary(${toRuntypes(s.value)}, ${toRuntypes(s.key)})`
  },
  union: (shape) => {
    const s = shape as TypeShape & { kind: "union" }
    return `R.Union(${s.variants.map(toRuntypes).join(", ")})`
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    return `R.Literal(${JSON.stringify(s.value)})`
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return `R.Union(${s.members.map((m) => `R.Literal(${JSON.stringify(m)})`).join(", ")})`
  },
  ref: (shape) => {
    const s = shape as TypeShape & { kind: "ref" }
    return s.target
  },
  // https://github.com/pelotom/runtypes — R.Intersect(...) (v6) is runtypes'
  // native variadic intersection constructor.
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    if (s.members.length === 0) return "R.Unknown"
    return `R.Intersect(${s.members.map(toRuntypes).join(", ")})`
  },
}

export function toRuntypes(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  const expr = converter === undefined ? "R.Unknown" : converter(ref.shape, ref.meta)
  return withMeta(expr, ref.meta, ref.shape.kind)
}

export function toRuntypesDeclaration(name: string, ref: TypeRef): string {
  return `const ${name} = ${toRuntypes(ref)};`
}

export function toRuntypesDeclarations(registry: Record<string, TypeRef>): string {
  const declarations = Object.entries(registry).map(([name, ref]) => toRuntypesDeclaration(name, ref))
  return [`import * as R from "runtypes";`, "", ...declarations].join("\n")
}
