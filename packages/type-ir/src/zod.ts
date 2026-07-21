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
  // https://zod.dev/?id=numbers — `.gt()`/`.lt()` are Zod's exclusive-bound
  // equivalents of `.min()`/`.max()` (inclusive).
  if (typeof meta.exclusiveMinimum === "number" && numberLike) result += `.gt(${meta.exclusiveMinimum})`
  if (typeof meta.exclusiveMaximum === "number" && numberLike) result += `.lt(${meta.exclusiveMaximum})`
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
  // https://zod.dev/?id=dates — z.coerce.date() validates/coerces to a `Date`
  // (accepts a `Date`, an ISO string, or a timestamp number), matching
  // type-ir's datetime/date domain type (`Date`, not a wire-format string —
  // see kinds/date-time.ts).
  datetime: leaf("z.coerce.date()"),
  date: leaf("z.coerce.date()"),
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
      // https://zod.dev/api#readonly — `.readonly()` (any ZodType) marks the
      // parsed output type readonly (Object.freeze at parse time); chained
      // after `.optional()` like Zod's other field-level modifiers.
      const readonly = field.meta.readonly === true ? ".readonly()" : ""
      return `${quoteKey(name)}: ${expr}${optional}${readonly}`
    })
    return `z.object({ ${fields.join(", ")} })`
  },
  // https://zod.dev/?id=instanceof — `z.instanceof(Class)` checks the runtime
  // prototype chain rather than validating structurally, so it needs the
  // actual class reference in scope, not just its name. The caller (whatever
  // assembles this emitted source into a module) is responsible for ensuring
  // `className` is imported from `source` alongside `zod`.
  instance: (shape) => {
    const s = shape as TypeShape & { kind: "instance" }
    return `z.instanceof(${s.className})`
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
  // Zod validates materialized values, not an ongoing async sequence — no
  // AsyncIterable schema exists, so this degrades to `z.array()` of the
  // element type, same as every other data-only projector's stream fallback.
  stream: (shape) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `z.array(${toZod(s.element)})`
  },
  // https://zod.dev/?id=discriminated-unions — z.discriminatedUnion(key, [...])
  // is Zod's native construct for object unions keyed on a shared literal
  // field; it validates in O(1) by reading the key instead of trying every
  // variant. Driven by `meta.discriminator` (open metadata bag convention,
  // see CLAUDE.md); a plain union (no discriminator) keeps z.union().
  union: (shape, meta) => {
    const s = shape as TypeShape & { kind: "union" }
    const variants = s.variants.map(toZod)
    if (typeof meta.discriminator === "string") {
      return `z.discriminatedUnion(${JSON.stringify(meta.discriminator)}, [${variants.join(", ")}])`
    }
    return `z.union([${variants.join(", ")}])`
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
  // https://zod.dev/?id=functions — `z.function()` validates arity/argument
  // and return types via `.args(...)`/`.returns(...)`. `thisType` has no Zod
  // equivalent (Zod validates call signatures, not the `this` binding) and is
  // dropped.
  function: (shape) => {
    const s = shape as TypeShape & { kind: "function" }
    const args = s.params.map((p) => toZod(p.type)).join(", ")
    return `z.function().args(${args}).returns(${toZod(s.returnType)})`
  },
  // `method` has no explicit entry here — `registerParent("method", "function")`
  // means `resolve()` falls back to the `function` handler above, and Zod's
  // `z.function()` has no `this`-binding concept either way.
  //
  // https://zod.dev/?id=objects — a service surface has no single native Zod
  // construct, but its methods each have one (`z.function()`, same as
  // `function`/`method` above), so `z.object({...})` with each method rendered
  // as a `z.function()` field is the closest faithful encoding: it validates
  // the shape "an object with these callable members," which is what an
  // `interface` TypeRef actually asserts.
  interface: (shape) => {
    const s = shape as TypeShape & { kind: "interface" }
    const methods = Object.entries(s.methods).map(([name, method]) => `${quoteKey(name)}: ${toZod(method)}`)
    return `z.object({ ${methods.join(", ")} })`
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
