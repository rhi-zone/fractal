// Valibot pipe/actions model: https://valibot.dev/guides/methods/#pipelines
// Schema reference (object, array, tuple, record, union, literal, picklist):
//   https://valibot.dev/api/
// String/number validation actions (minValue, maxValue, minLength, maxLength, regex, uuid,
// url, isoDateTime, isoDate, isoTime, base64): https://valibot.dev/api/#actions
// optional/nullable wrappers: https://valibot.dev/api/optional/ , https://valibot.dev/api/nullable/
import { resolve, type TypeRef, type TypeShape } from "./index.ts"

type Expr = { schema: string; actions: readonly string[] }
type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => Expr

function quote(value: string): string {
  return JSON.stringify(value)
}

const leaf =
  (schema: string): Converter =>
  () => ({ schema, actions: [] })

const leafWithAction =
  (schema: string, action: string): Converter =>
  () => ({ schema, actions: [action] })

function constraintActions(meta: Readonly<Record<string, unknown>>): string[] {
  const actions: string[] = []
  // https://valibot.dev/api/gtValue/ , https://valibot.dev/api/ltValue/ — the
  // strict (exclusive) counterparts of minValue/maxValue.
  if (typeof meta.exclusiveMinimum === "number") actions.push(`v.gtValue(${meta.exclusiveMinimum})`)
  else if (typeof meta.minimum === "number") actions.push(`v.minValue(${meta.minimum})`)
  if (typeof meta.exclusiveMaximum === "number") actions.push(`v.ltValue(${meta.exclusiveMaximum})`)
  else if (typeof meta.maximum === "number") actions.push(`v.maxValue(${meta.maximum})`)
  if (typeof meta.minLength === "number") actions.push(`v.minLength(${meta.minLength})`)
  if (typeof meta.maxLength === "number") actions.push(`v.maxLength(${meta.maxLength})`)
  if (typeof meta.pattern === "string") actions.push(`v.regex(/${meta.pattern}/)`)
  // https://valibot.dev/api/multipleOf/
  if (typeof meta.multipleOf === "number") actions.push(`v.multipleOf(${meta.multipleOf})`)
  if (typeof meta.description === "string") actions.push(`v.description(${quote(meta.description)})`)
  return actions
}

const handlers: Record<string, Converter> = {
  boolean: leaf("v.boolean()"),
  number: leaf("v.number()"),
  integer: leafWithAction("v.number()", "v.integer()"),
  int32: leafWithAction("v.number()", "v.integer()"),
  int64: leafWithAction("v.number()", "v.integer()"),
  float32: leaf("v.number()"),
  float64: leaf("v.number()"),
  string: leaf("v.string()"),
  uuid: leafWithAction("v.string()", "v.uuid()"),
  uri: leafWithAction("v.string()", "v.url()"),
  // https://valibot.dev/api/date/ — v.date() validates a `Date` instance,
  // matching type-ir's datetime/date domain type (`Date`, not a wire-format
  // string — see kinds/date-time.ts). Valibot has no built-in string->Date
  // coercion action (unlike Zod's z.coerce.date()).
  datetime: leaf("v.date()"),
  date: leaf("v.date()"),
  time: leafWithAction("v.string()", "v.isoTime()"),
  duration: leaf("v.string()"),
  bytes: leafWithAction("v.string()", "v.base64()"),
  null: leaf("v.null()"),
  void: leaf("v.void()"),
  unknown: leaf("v.unknown()"),
  never: leaf("v.never()"),
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const fields = Object.entries(s.fields).map(([name, field]) => `${name}: ${toValibot(field)}`)
    return { schema: `v.object({ ${fields.join(", ")} })`, actions: [] }
  },
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return { schema: `v.array(${toValibot(s.element)})`, actions: [] }
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return { schema: `v.tuple([${s.elements.map(toValibot).join(", ")}])`, actions: [] }
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return { schema: `v.record(v.string(), ${toValibot(s.value)})`, actions: [] }
  },
  // Valibot validates materialized values, not an ongoing async sequence —
  // degrades to `v.array()` of the element type, same fallback the other
  // data-only projectors use for `stream`.
  stream: (shape) => {
    const s = shape as TypeShape & { kind: "stream" }
    return { schema: `v.array(${toValibot(s.element)})`, actions: [] }
  },
  // https://valibot.dev/api/variant/ — v.variant(key, [...]) is Valibot's
  // native discriminated-union schema, keyed on a shared literal field for
  // O(1) variant selection. Driven by `meta.discriminator` (open metadata bag
  // convention, see CLAUDE.md); a plain union (no discriminator) keeps
  // v.union().
  union: (shape, meta) => {
    const s = shape as TypeShape & { kind: "union" }
    const variants = s.variants.map(toValibot)
    if (typeof meta.discriminator === "string") {
      return { schema: `v.variant(${quote(meta.discriminator)}, [${variants.join(", ")}])`, actions: [] }
    }
    return { schema: `v.union([${variants.join(", ")}])`, actions: [] }
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    const value = typeof s.value === "string" ? quote(s.value) : String(s.value)
    return { schema: `v.literal(${value})`, actions: [] }
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return { schema: `v.picklist([${s.members.map(quote).join(", ")}])`, actions: [] }
  },
  ref: (shape) => {
    const s = shape as TypeShape & { kind: "ref" }
    return { schema: s.target, actions: [] }
  },
  // https://valibot.dev/api/intersect/ — v.intersect() takes an array of any
  // arity, unlike Zod's binary z.intersection().
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    return { schema: `v.intersect([${s.members.map(toValibot).join(", ")}])`, actions: [] }
  },
  // Valibot has no callable-value schema — degrades to v.unknown(), same
  // fallback as an unrecognized kind.
  function: leaf("v.unknown()"),
}

export function toValibot(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  const { schema, actions: baseActions } = converter === undefined ? { schema: "v.unknown()", actions: [] } : converter(ref.shape, ref.meta)
  const actions = [...baseActions, ...constraintActions(ref.meta)]
  if (typeof ref.meta.brand === "string") actions.push(`v.brand(${quote(ref.meta.brand)})`)
  let expr = actions.length > 0 ? `v.pipe(${schema}, ${actions.join(", ")})` : schema

  // https://valibot.dev/api/optional/ , https://valibot.dev/api/nullable/ — both
  // wrappers accept a default value as their second argument, applied when the
  // input is undefined (optional) / null (nullable) respectively. A schema-level
  // default with neither wrapper has no valibot equivalent (defaults are only
  // meaningful at an optional/nullable boundary) — surfaced as a trailing
  // comment instead, same convention as io-ts/runtypes use for unsupported meta.
  let defaultConsumed = false
  if (ref.meta.nullable === true) {
    if (ref.meta.default !== undefined && ref.meta.optional !== true) {
      expr = `v.nullable(${expr}, ${JSON.stringify(ref.meta.default)})`
      defaultConsumed = true
    } else {
      expr = `v.nullable(${expr})`
    }
  }
  if (ref.meta.optional === true) {
    if (ref.meta.default !== undefined) {
      expr = `v.optional(${expr}, ${JSON.stringify(ref.meta.default)})`
      defaultConsumed = true
    } else {
      expr = `v.optional(${expr})`
    }
  }
  if (ref.meta.default !== undefined && !defaultConsumed) {
    expr += ` /* default: ${JSON.stringify(ref.meta.default)} */`
  }

  return expr
}

export function toValibotDeclaration(name: string, ref: TypeRef): string {
  return `const ${name} = ${toValibot(ref)};`
}

export function toValibotDeclarations(registry: Record<string, TypeRef>): string {
  const declarations = Object.entries(registry).map(([name, ref]) => toValibotDeclaration(name, ref))
  return [`import * as v from "valibot"`, "", ...declarations].join("\n")
}
