// TypeBox validator code projector. Emits TypeBox builder source text, not runtime schemas.
// Spec: https://github.com/sinclairzx81/typebox (Types: Boolean, Number, Integer, String,
// Object, Array, Tuple, Record, Union, Literal, Ref; Options object as trailing constructor
// argument; Nullable via Type.Union([T, Type.Null()])).
import { resolve, type TypeRef, type TypeShape } from "./index.ts"

function quoteKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)
}

function literalValue(value: string | number | boolean | null): string {
  return JSON.stringify(value)
}

const optionKeys = [
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "multipleOf",
  "description",
  "default",
] as const

function metaOptionEntries(meta: Readonly<Record<string, unknown>>): [string, string][] {
  const entries: [string, string][] = []
  for (const key of optionKeys) {
    const value = meta[key]
    if (value === undefined) continue
    entries.push([key, typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value)])
  }
  return entries
}

function optionsLiteral(entries: [string, string][]): string {
  return `{ ${entries.map(([key, value]) => `${key}: ${value}`).join(", ")} }`
}

function call(name: string, args: string[], baseOptions: [string, string][], meta: Readonly<Record<string, unknown>>): string {
  const entries = [...baseOptions, ...metaOptionEntries(meta)]
  const finalArgs = entries.length > 0 ? [...args, optionsLiteral(entries)] : args
  return `${name}(${finalArgs.join(", ")})`
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string

const leaf =
  (name: string, baseOptions: [string, string][] = []): Converter =>
  (_shape, meta) =>
    call(name, [], baseOptions, meta)

const handlers: Record<string, Converter> = {
  boolean: leaf("Type.Boolean"),
  number: leaf("Type.Number"),
  integer: leaf("Type.Integer"),
  int32: leaf("Type.Integer", [["format", '"int32"']]),
  int64: leaf("Type.Integer", [["format", '"int64"']]),
  float32: leaf("Type.Number", [["format", '"float"']]),
  float64: leaf("Type.Number", [["format", '"double"']]),
  string: leaf("Type.String"),
  uuid: leaf("Type.String", [["format", '"uuid"']]),
  uri: leaf("Type.String", [["format", '"uri"']]),
  datetime: leaf("Type.String", [["format", '"date-time"']]),
  date: leaf("Type.String", [["format", '"date"']]),
  time: leaf("Type.String", [["format", '"time"']]),
  duration: leaf("Type.String", [["format", '"duration"']]),
  bytes: leaf("Type.String", [["contentEncoding", '"base64"']]),
  null: leaf("Type.Null"),
  void: leaf("Type.Void"),
  unknown: leaf("Type.Unknown"),
  never: leaf("Type.Never"),
  object: (shape, meta) => {
    const s = shape as TypeShape & { kind: "object" }
    const fields = Object.entries(s.fields).map(([name, field]) => {
      const expr = toTypeBox(field)
      const wrapped = field.meta.optional === true ? `Type.Optional(${expr})` : expr
      return `${quoteKey(name)}: ${wrapped}`
    })
    return call("Type.Object", [`{ ${fields.join(", ")} }`], [], meta)
  },
  array: (shape, meta) => {
    const s = shape as TypeShape & { kind: "array" }
    return call("Type.Array", [toTypeBox(s.element)], [], meta)
  },
  tuple: (shape, meta) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return call("Type.Tuple", [`[${s.elements.map(toTypeBox).join(", ")}]`], [], meta)
  },
  map: (shape, meta) => {
    const s = shape as TypeShape & { kind: "map" }
    return call("Type.Record", ["Type.String()", toTypeBox(s.value)], [], meta)
  },
  union: (shape, meta) => {
    const s = shape as TypeShape & { kind: "union" }
    return call("Type.Union", [`[${s.variants.map(toTypeBox).join(", ")}]`], [], meta)
  },
  literal: (shape, meta) => {
    const s = shape as TypeShape & { kind: "literal" }
    return call("Type.Literal", [literalValue(s.value)], [], meta)
  },
  enum: (shape, meta) => {
    const s = shape as TypeShape & { kind: "enum" }
    return call("Type.Union", [`[${s.members.map((m) => `Type.Literal(${JSON.stringify(m)})`).join(", ")}]`], [], meta)
  },
  ref: (shape, meta) => {
    const s = shape as TypeShape & { kind: "ref" }
    return call("Type.Ref", [s.target], [], meta)
  },
}

export function toTypeBox(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  const expr = converter === undefined ? "Type.Unknown()" : converter(ref.shape, ref.meta)
  return ref.meta.nullable === true ? `Type.Union([${expr}, Type.Null()])` : expr
}

export function toTypeBoxDeclaration(name: string, ref: TypeRef): string {
  return `const ${name} = ${toTypeBox(ref)};`
}

export function toTypeBoxDeclarations(registry: Record<string, TypeRef>): string {
  const declarations = Object.entries(registry).map(([name, ref]) => toTypeBoxDeclaration(name, ref))
  return [`import { Type } from "@sinclair/typebox";`, "", ...declarations].join("\n")
}
