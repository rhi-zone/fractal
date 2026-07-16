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
  if (typeof meta.minimum === "number") text += ` >= ${meta.minimum}`
  if (typeof meta.maximum === "number") text += ` <= ${meta.maximum}`
  if (typeof meta.minLength === "number") text += ` >= ${meta.minLength}`
  if (typeof meta.maxLength === "number") text += ` <= ${meta.maxLength}`
  return { ...e, text }
}

function withNullable(e: Emitted, meta: Readonly<Record<string, unknown>>): Emitted {
  if (meta.nullable !== true) return e
  if (e.mode === "word") return { ...e, text: `${e.text} | null` }
  const inner = e.mode === "expr" ? e.text : `type(${e.text})`
  return { text: `type.or(${inner}, type("null"))`, mode: "expr" }
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
  datetime: leaf("string"),
  date: leaf("string"),
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
}

function emitRef(ref: TypeRef): Emitted {
  const converter = resolve(ref.shape.kind, handlers)
  const base: Emitted = converter === undefined ? { text: "unknown", mode: "word" } : converter(ref.shape, ref.meta)
  return withNullable(withConstraints(base, ref.meta), ref.meta)
}

function topLevelText(e: Emitted): string {
  if (e.mode === "word") return `type(${JSON.stringify(e.text)})`
  if (e.mode === "literal") return `type(${e.text})`
  return e.text
}

export function toArkType(ref: TypeRef): string {
  const e = emitRef(ref)
  let text = topLevelText(e)
  if (typeof ref.meta.pattern === "string" && e.mode === "word") {
    text = `${text}.matching(${regexLiteral(ref.meta.pattern)})`
  }
  return text
}

export function toArkTypeDeclaration(name: string, ref: TypeRef): string {
  return `const ${name} = ${toArkType(ref)};`
}

export function toArkTypeDeclarations(registry: Record<string, TypeRef>): string {
  const declarations = Object.entries(registry).map(([name, ref]) => toArkTypeDeclaration(name, ref))
  return [`import { type } from "arktype";`, "", ...declarations].join("\n")
}
