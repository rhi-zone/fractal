// Effect Schema code projector. Emits Effect Schema (@effect/schema) source text, not
// runtime schemas.
// Spec: https://effect.website/docs/schema/introduction/ (Schema module — String, Number,
// Boolean, Struct, Array, Tuple, Union, Literal, Record, optional/optionalWith, NullOr,
// UUID, Int, DateFromString, numeric/string filters minLength/maxLength/pattern/
// greaterThanOrEqualTo/lessThanOrEqualTo/multipleOf, annotations).
//
// Divergence from the zod/typebox/valibot projectors: Effect Schema has no schema-level
// `.default()`. A default only has meaning as part of a Struct field's property signature
// (`S.optionalWith(field, { default: () => value })`), so `meta.default` is applied at the
// `object` field site, not as a generic chained call in `withMeta`.
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
  const lengthConstrainable = stringLike || kind === "array"

  const refinements: string[] = []
  if (typeof meta.minimum === "number" && numberLike) refinements.push(`S.greaterThanOrEqualTo(${meta.minimum})`)
  if (typeof meta.maximum === "number" && numberLike) refinements.push(`S.lessThanOrEqualTo(${meta.maximum})`)
  if (typeof meta.minLength === "number" && lengthConstrainable) refinements.push(`S.minLength(${meta.minLength})`)
  if (typeof meta.maxLength === "number" && lengthConstrainable) refinements.push(`S.maxLength(${meta.maxLength})`)
  if (typeof meta.pattern === "string" && stringLike) refinements.push(`S.pattern(${regexLiteral(meta.pattern)})`)
  if (typeof meta.multipleOf === "number" && numberLike) refinements.push(`S.multipleOf(${meta.multipleOf})`)

  if (refinements.length > 0) result = `${result}.pipe(${refinements.join(", ")})`

  if (meta.nullable === true) result = `S.NullOr(${result})`
  if (typeof meta.description === "string") {
    result += `.annotations({ description: ${JSON.stringify(meta.description)} })`
  }

  return result
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string

const leaf =
  (expr: string): Converter =>
  () =>
    expr

const handlers: Record<string, Converter> = {
  boolean: leaf("S.Boolean"),
  number: leaf("S.Number"),
  integer: leaf("S.Int"),
  int32: leaf("S.Int"),
  int64: leaf("S.Int"),
  float32: leaf("S.Number"),
  float64: leaf("S.Number"),
  string: leaf("S.String"),
  uuid: leaf("S.UUID"),
  uri: leaf("S.String"),
  datetime: leaf("S.DateFromString"),
  date: leaf("S.DateFromString"),
  time: leaf("S.String"),
  duration: leaf("S.String"),
  bytes: leaf("S.String"),
  null: leaf("S.Null"),
  void: leaf("S.Void"),
  unknown: leaf("S.Unknown"),
  never: leaf("S.Never"),
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const fields = Object.entries(s.fields).map(([name, field]) => {
      const expr = toEffectSchema(field)
      if (field.meta.optional === true) {
        if (field.meta.default !== undefined) {
          return `${quoteKey(name)}: S.optionalWith(${expr}, { default: () => ${JSON.stringify(field.meta.default)} } as const)`
        }
        return `${quoteKey(name)}: S.optional(${expr})`
      }
      return `${quoteKey(name)}: ${expr}`
    })
    return `S.Struct({ ${fields.join(", ")} })`
  },
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return `S.Array(${toEffectSchema(s.element)})`
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return `S.Tuple(${s.elements.map(toEffectSchema).join(", ")})`
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return `S.Record({ key: ${toEffectSchema(s.key)}, value: ${toEffectSchema(s.value)} })`
  },
  union: (shape) => {
    const s = shape as TypeShape & { kind: "union" }
    return `S.Union(${s.variants.map(toEffectSchema).join(", ")})`
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    return `S.Literal(${JSON.stringify(s.value)})`
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return `S.Union(${s.members.map((m) => `S.Literal(${JSON.stringify(m)})`).join(", ")})`
  },
  ref: (shape) => {
    const s = shape as TypeShape & { kind: "ref" }
    return s.target
  },
}

export function toEffectSchema(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  const expr = converter === undefined ? "S.Unknown" : converter(ref.shape, ref.meta)
  return withMeta(expr, ref.meta, ref.shape.kind)
}

export function toEffectSchemaDeclaration(name: string, ref: TypeRef): string {
  return `const ${name} = ${toEffectSchema(ref)};`
}

export function toEffectSchemaDeclarations(registry: Record<string, TypeRef>): string {
  const declarations = Object.entries(registry).map(([name, ref]) => toEffectSchemaDeclaration(name, ref))
  return [`import * as S from "@effect/schema/Schema";`, "", ...declarations].join("\n")
}
