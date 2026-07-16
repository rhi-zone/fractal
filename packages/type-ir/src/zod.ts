// Zod validator code projector. Emits Zod schema source text, not runtime schemas.
// Spec: https://zod.dev/ (Primitives, Strings, Numbers, Objects, Arrays, Tuples,
// Records, Unions, Literals, Enums, Optional/Nullable, Descriptions, Defaults).
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

  if (typeof meta.minimum === "number" && numberLike) result += `.min(${meta.minimum})`
  if (typeof meta.maximum === "number" && numberLike) result += `.max(${meta.maximum})`
  if (typeof meta.minLength === "number" && lengthConstrainable) result += `.min(${meta.minLength})`
  if (typeof meta.maxLength === "number" && lengthConstrainable) result += `.max(${meta.maxLength})`
  if (typeof meta.pattern === "string" && stringLike) result += `.regex(${regexLiteral(meta.pattern)})`
  if (typeof meta.multipleOf === "number" && numberLike) result += `.multipleOf(${meta.multipleOf})`

  if (meta.nullable === true) result += ".nullable()"
  if (typeof meta.description === "string") result += `.describe(${JSON.stringify(meta.description)})`
  if (meta.default !== undefined) result += `.default(${JSON.stringify(meta.default)})`
  if (typeof meta.brand === "string") result += `.brand<${JSON.stringify(meta.brand)}>()`

  return result
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string

const leaf =
  (expr: string): Converter =>
  () =>
    expr

const handlers: Record<string, Converter> = {
  boolean: leaf("z.boolean()"),
  number: leaf("z.number()"),
  integer: leaf("z.number().int()"),
  int32: leaf("z.number().int()"),
  int64: leaf("z.number().int()"),
  float32: leaf("z.number()"),
  float64: leaf("z.number()"),
  string: leaf("z.string()"),
  uuid: leaf("z.string().uuid()"),
  uri: leaf("z.string().url()"),
  datetime: leaf("z.string().datetime()"),
  date: leaf("z.string().date()"),
  time: leaf("z.string().time()"),
  duration: leaf("z.string().duration()"),
  bytes: leaf("z.string().base64()"),
  null: leaf("z.null()"),
  void: leaf("z.void()"),
  unknown: leaf("z.unknown()"),
  never: leaf("z.never()"),
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const fields = Object.entries(s.fields).map(([name, field]) => {
      const expr = toZod(field)
      const optional = field.meta.optional === true ? ".optional()" : ""
      return `${quoteKey(name)}: ${expr}${optional}`
    })
    return `z.object({ ${fields.join(", ")} })`
  },
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return `z.array(${toZod(s.element)})`
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return `z.tuple([${s.elements.map(toZod).join(", ")}])`
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return `z.record(${toZod(s.key)}, ${toZod(s.value)})`
  },
  union: (shape) => {
    const s = shape as TypeShape & { kind: "union" }
    return `z.union([${s.variants.map(toZod).join(", ")}])`
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    return `z.literal(${JSON.stringify(s.value)})`
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return `z.enum([${s.members.map((m) => JSON.stringify(m)).join(", ")}])`
  },
  ref: (shape) => {
    const s = shape as TypeShape & { kind: "ref" }
    return s.target
  },
  // Zod's z.intersection() only takes two schemas (https://zod.dev/?id=intersections) —
  // 3+ members nest left-associatively: `z.intersection(z.intersection(a, b), c)`.
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first, ...rest] = s.members
    if (first === undefined) return "z.unknown()"
    return rest.reduce((acc, member) => `z.intersection(${acc}, ${toZod(member)})`, toZod(first))
  },
}

export function toZod(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  const expr = converter === undefined ? "z.unknown()" : converter(ref.shape, ref.meta)
  return withMeta(expr, ref.meta, ref.shape.kind)
}

export function toZodDeclaration(name: string, ref: TypeRef): string {
  return `const ${name} = ${toZod(ref)};`
}

export function toZodDeclarations(registry: Record<string, TypeRef>): string {
  const declarations = Object.entries(registry).map(([name, ref]) => toZodDeclaration(name, ref))
  return [`import { z } from "zod";`, "", ...declarations].join("\n")
}
