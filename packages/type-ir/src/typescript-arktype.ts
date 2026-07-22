// ArkType validator code projector. Emits ArkType schema source text, not runtime schemas.
// Spec: https://arktype.io/ (string-based type syntax, object/array/tuple literals, unions,
// literals, optional keys, `.matching()`, `type.or`/`type.array` fallbacks for non-string forms).
import { resolve, type TypeRef, type TypeShape } from "./index.ts"

type Mode = "word" | "literal" | "expr"

type Emitted = { text: string; mode: Mode }

function quoteKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)
}

function regexLiteral(pattern: string): string {
  return `/${pattern.replace(/\//g, "\\/")}/`
}

function asDefArg(e: Emitted): string {
  return e.mode === "word" ? JSON.stringify(e.text) : e.text
}

function withConstraints(e: Emitted, meta: Readonly<Record<string, unknown>>): Emitted {
  if (e.mode !== "word") return e
  let text = e.text
  // https://arktype.io/docs/expressions#range — string-syntax range operators
  // support both inclusive (>=/<=) and exclusive (>/<) bounds directly.
  if (typeof meta.exclusiveMinimum === "number") text += ` > ${meta.exclusiveMinimum}`
  else if (typeof meta.minimum === "number") text += ` >= ${meta.minimum}`
  if (typeof meta.exclusiveMaximum === "number") text += ` < ${meta.exclusiveMaximum}`
  else if (typeof meta.maximum === "number") text += ` <= ${meta.maximum}`
  if (typeof meta.minLength === "number") text += ` >= ${meta.minLength}`
  if (typeof meta.maxLength === "number") text += ` <= ${meta.maxLength}`
  // https://arktype.io/docs/expressions — `%` is ArkType's divisibility operator
  // (`"number % 2"` = "must be a multiple of 2"), the string-syntax equivalent
  // of JSON Schema's `multipleOf`.
  if (typeof meta.multipleOf === "number") text += ` % ${meta.multipleOf}`
  return { ...e, text }
}

function withNullable(e: Emitted, meta: Readonly<Record<string, unknown>>): Emitted {
  if (meta.nullable !== true) return e
  if (e.mode === "word") return { ...e, text: `${e.text} | null` }
  const inner = e.mode === "expr" ? e.text : `type(${e.text})`
  return { text: `type.or(${inner}, type("null"))`, mode: "expr" }
}

// `.matching()`/`.describe()`/`.default()` are Type methods (https://arktype.io/docs/type-api,
// https://arktype.io/docs/configuration), not string-syntax operators like `withConstraints`
// handles — applying any of them forces the expression into "expr" mode (a `type(...)` call
// with method chains), same as `withNullable` does for `type.or(...)`.
function withChainedMeta(e: Emitted, meta: Readonly<Record<string, unknown>>): Emitted {
  const chain: string[] = []
  if (typeof meta.pattern === "string") chain.push(`.matching(${regexLiteral(meta.pattern)})`)
  if (typeof meta.description === "string") chain.push(`.describe(${JSON.stringify(meta.description)})`)
  if (meta.default !== undefined) chain.push(`.default(${JSON.stringify(meta.default)})`)
  // https://arktype.io/docs/expressions#brand — `.brand(name)` nominally tags a
  // type's output so structurally-identical types are no longer interchangeable.
  if (typeof meta.brand === "string") chain.push(`.brand(${JSON.stringify(meta.brand)})`)
  if (chain.length === 0) return e

  const base = e.mode === "expr" ? e.text : e.mode === "literal" ? `type(${e.text})` : `type(${JSON.stringify(e.text)})`
  return { text: `${base}${chain.join("")}`, mode: "expr" }
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => Emitted

const leaf =
  (word: string): Converter =>
  () => ({ text: word, mode: "word" })

const handlers: Record<string, Converter> = {
  boolean: leaf("boolean"),
  number: leaf("number"),
  integer: leaf("number.integer"),
  int32: leaf("number.integer"),
  int64: leaf("number.integer"),
  float32: leaf("number"),
  float64: leaf("number"),
  string: leaf("string"),
  uuid: leaf("string"),
  uri: leaf("string"),
  email: leaf("string"),
  // https://arktype.io/docs/keywords#js — "Date" is ArkType's built-in
  // keyword for a native `Date` instance, matching type-ir's datetime/date
  // domain type (see kinds/date-time.ts).
  datetime: leaf("Date"),
  date: leaf("Date"),
  time: leaf("string"),
  duration: leaf("string"),
  bytes: leaf("string"),
  null: leaf("null"),
  void: leaf("void"),
  unknown: leaf("unknown"),
  never: leaf("never"),
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const fields = Object.entries(s.fields).map(([name, field]) => {
      const optional = field.meta.optional === true
      const key = optional ? JSON.stringify(`${name}?`) : quoteKey(name)
      return `${key}: ${asDefArg(emitRef(field))}`
    })
    return { text: `{ ${fields.join(", ")} }`, mode: "literal" }
  },
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    const element = emitRef(s.element)
    if (element.mode === "word") return { text: `${element.text}[]`, mode: "word" }
    return { text: `type.array(${asDefArg(element)})`, mode: "expr" }
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    const elements = s.elements.map((element) => asDefArg(emitRef(element)))
    return { text: `[${elements.join(", ")}]`, mode: "literal" }
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    const value = emitRef(s.value)
    if (value.mode === "word") return { text: `Record<string, ${value.text}>`, mode: "word" }
    return { text: "Record<string, unknown>", mode: "word" }
  },
  // ArkType's string DSL validates materialized values, not an ongoing async
  // sequence — degrades to the same `element[]`/`type.array(...)` encoding
  // the `array` handler above uses.
  stream: (shape) => {
    const s = shape as TypeShape & { kind: "stream" }
    const element = emitRef(s.element)
    if (element.mode === "word") return { text: `${element.text}[]`, mode: "word" }
    return { text: `type.array(${asDefArg(element)})`, mode: "expr" }
  },
  union: (shape) => {
    const s = shape as TypeShape & { kind: "union" }
    const variants = s.variants.map(emitRef)
    if (variants.every((v) => v.mode === "word")) {
      return { text: variants.map((v) => v.text).join(" | "), mode: "word" }
    }
    const args = variants.map((v) => (v.mode === "expr" ? v.text : `type(${asDefArg(v)})`))
    return { text: `type.or(${args.join(", ")})`, mode: "expr" }
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    const v = s.value
    const word = typeof v === "string" ? `'${v}'` : v === null ? "null" : String(v)
    return { text: word, mode: "word" }
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return { text: s.members.map((m) => `'${m}'`).join(" | "), mode: "word" }
  },
  ref: (shape) => {
    const s = shape as TypeShape & { kind: "ref" }
    return { text: s.target, mode: "expr" }
  },
  // `type.and()` is ArkType's variadic intersection combinator (mirrors `type.or()`
  // above) — https://arktype.io/docs/type-api. Word-mode members can also use the
  // string DSL's `&` operator directly, same as `union` does with `|`.
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    if (s.members.length === 0) return { text: "unknown", mode: "word" }
    const members = s.members.map(emitRef)
    if (members.every((m) => m.mode === "word")) {
      return { text: members.map((m) => m.text).join(" & "), mode: "word" }
    }
    const args = members.map((m) => (m.mode === "expr" ? m.text : `type(${asDefArg(m)})`))
    return { text: `type.and(${args.join(", ")})`, mode: "expr" }
  },
  // ArkType's string DSL validates data shapes, not callable values — there's
  // no function-type construct to target, so this degrades to `unknown`
  // (matches the `instance` fallback pattern used by other data-only
  // projectors, but ArkType doesn't distinguish instance/function specially
  // either — both are opaque to it).
  function: leaf("unknown"),
}

function emitRef(ref: TypeRef): Emitted {
  const converter = resolve(ref.shape.kind, handlers)
  const base: Emitted = converter === undefined ? { text: "unknown", mode: "word" } : converter(ref.shape, ref.meta)
  return withChainedMeta(withNullable(withConstraints(base, ref.meta), ref.meta), ref.meta)
}

function topLevelText(e: Emitted): string {
  if (e.mode === "word") return `type(${JSON.stringify(e.text)})`
  if (e.mode === "literal") return `type(${e.text})`
  return e.text
}

export function toArkType(ref: TypeRef): string {
  // Pattern/description/default are applied inside emitRef via withChainedMeta,
  // which already forces "expr" mode when any of them are present — so
  // topLevelText only ever needs to wrap bare word/literal forms here.
  return topLevelText(emitRef(ref))
}

export function toArkTypeDeclaration(name: string, ref: TypeRef): string {
  return `const ${name} = ${toArkType(ref)};`
}

export function toArkTypeDeclarations(registry: Record<string, TypeRef>): string {
  const declarations = Object.entries(registry).map(([name, ref]) => toArkTypeDeclaration(name, ref))
  return [`import { type } from "arktype";`, "", ...declarations].join("\n")
}
