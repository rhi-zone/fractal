// Valibot pipe/actions model: https://valibot.dev/guides/methods/#pipelines
// Schema reference (object, array, tuple, record, union, literal, picklist):
//   https://valibot.dev/api/
// String/number validation actions (minValue, maxValue, minLength, maxLength, regex, uuid,
// url, isoDateTime, isoDate, isoTime, base64): https://valibot.dev/api/#actions
// optional/nullable wrappers: https://valibot.dev/api/optional/ , https://valibot.dev/api/nullable/
import { resolve, type TypeRef, type TypeShape } from "./index.ts"

type Expr = { schema: string; actions: readonly string[] }
type Converter = (shape: TypeShape) => Expr

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
  if (typeof meta.minimum === "number") actions.push(`v.minValue(${meta.minimum})`)
  if (typeof meta.maximum === "number") actions.push(`v.maxValue(${meta.maximum})`)
  if (typeof meta.minLength === "number") actions.push(`v.minLength(${meta.minLength})`)
  if (typeof meta.maxLength === "number") actions.push(`v.maxLength(${meta.maxLength})`)
  if (typeof meta.pattern === "string") actions.push(`v.regex(/${meta.pattern}/)`)
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
  datetime: leafWithAction("v.string()", "v.isoDateTime()"),
  date: leafWithAction("v.string()", "v.isoDate()"),
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
  union: (shape) => {
    const s = shape as TypeShape & { kind: "union" }
    return { schema: `v.union([${s.variants.map(toValibot).join(", ")}])`, actions: [] }
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
}

export function toValibot(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  const { schema, actions: baseActions } = converter === undefined ? { schema: "v.unknown()", actions: [] } : converter(ref.shape)
  const actions = [...baseActions, ...constraintActions(ref.meta)]
  if (typeof ref.meta.brand === "string") actions.push(`v.brand(${quote(ref.meta.brand)})`)
  let expr = actions.length > 0 ? `v.pipe(${schema}, ${actions.join(", ")})` : schema

  if (ref.meta.nullable === true) expr = `v.nullable(${expr})`
  if (ref.meta.optional === true) expr = `v.optional(${expr})`

  return expr
}

export function toValibotDeclaration(name: string, ref: TypeRef): string {
  return `const ${name} = ${toValibot(ref)};`
}

export function toValibotDeclarations(registry: Record<string, TypeRef>): string {
  const declarations = Object.entries(registry).map(([name, ref]) => toValibotDeclaration(name, ref))
  return [`import * as v from "valibot"`, "", ...declarations].join("\n")
}
