// TypeBox validator code projector. Emits TypeBox builder source text, not runtime schemas.
// Spec: https://github.com/sinclairzx81/typebox (Types: Boolean, Number, Integer, String,
// Object, Array, Tuple, Record, Union, Literal, Ref; Options object as trailing constructor
// argument; Nullable via Type.Union([T, Type.Null()])).
import { childTypeRefs, resolve, type TypeRef, type TypeShape } from "./index.ts"

function quoteKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)
}

function literalValue(value: string | number | boolean | null): string {
  return JSON.stringify(value)
}

const optionKeys = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "multipleOf",
  "description",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "examples",
  "$comment",
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

// `selfName`, when set, is the name of the declaration currently being
// emitted (see toTypeBoxDeclaration). It's threaded through every recursive
// call so a nested `ref` whose target matches can render as TypeBox's `This`
// (bound by `Type.Recursive(This => ...)`) instead of a bare reference to a
// const that, for a self-referential type, is still mid-initialization at
// that point (see the ref handler below and containsSelfRef).
type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>, selfName?: string) => string

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
  email: leaf("Type.String", [["format", '"email"']]),
  // https://github.com/sinclairzx81/typebox#Date — Type.Date() validates a
  // native `Date` instance (`static: Date`), matching type-ir's
  // datetime/date domain type (see kinds/date-time.ts).
  datetime: leaf("Type.Date"),
  date: leaf("Type.Date"),
  time: leaf("Type.String", [["format", '"time"']]),
  duration: leaf("Type.String", [["format", '"duration"']]),
  bytes: leaf("Type.String", [["contentEncoding", '"base64"']]),
  null: leaf("Type.Null"),
  void: leaf("Type.Void"),
  unknown: leaf("Type.Unknown"),
  never: leaf("Type.Never"),
  object: (shape, meta, selfName) => {
    const s = shape as TypeShape & { kind: "object" }
    const fields = Object.entries(s.fields).map(([name, field]) => {
      const expr = toTypeBox(field, selfName)
      // https://github.com/sinclairzx81/typebox#readonly — Type.Readonly()
      // wraps a schema to mark the property readonly; composes with
      // Type.Optional() the same way TypeBox's own docs order them.
      const readonlyExpr = field.meta.readonly === true ? `Type.Readonly(${expr})` : expr
      const wrapped = field.meta.optional === true ? `Type.Optional(${readonlyExpr})` : readonlyExpr
      return `${quoteKey(name)}: ${wrapped}`
    })
    return call("Type.Object", [`{ ${fields.join(", ")} }`], [], meta)
  },
  array: (shape, meta, selfName) => {
    const s = shape as TypeShape & { kind: "array" }
    return call("Type.Array", [toTypeBox(s.element, selfName)], [], meta)
  },
  tuple: (shape, meta, selfName) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return call("Type.Tuple", [`[${s.elements.map((el) => toTypeBox(el, selfName)).join(", ")}]`], [], meta)
  },
  map: (shape, meta, selfName) => {
    const s = shape as TypeShape & { kind: "map" }
    return call("Type.Record", ["Type.String()", toTypeBox(s.value, selfName)], [], meta)
  },
  // TypeBox validates materialized values, not an ongoing async sequence —
  // degrades to `Type.Array()` of the element type, same fallback the other
  // data-only projectors use for `stream`.
  stream: (shape, meta, selfName) => {
    const s = shape as TypeShape & { kind: "stream" }
    return call("Type.Array", [toTypeBox(s.element, selfName)], [], meta)
  },
  union: (shape, meta, selfName) => {
    const s = shape as TypeShape & { kind: "union" }
    return call("Type.Union", [`[${s.variants.map((v) => toTypeBox(v, selfName)).join(", ")}]`], [], meta)
  },
  literal: (shape, meta) => {
    const s = shape as TypeShape & { kind: "literal" }
    return call("Type.Literal", [literalValue(s.value)], [], meta)
  },
  enum: (shape, meta) => {
    const s = shape as TypeShape & { kind: "enum" }
    return call("Type.Union", [`[${s.members.map((m) => `Type.Literal(${JSON.stringify(m)})`).join(", ")}]`], [], meta)
  },
  // A ref targeting the declaration currently being emitted is a
  // self-reference: rendering it as `Type.Ref(name)` would read the const
  // before its own initializer finishes assigning it (see
  // toTypeBoxDeclaration). TypeBox's `Type.Recursive(This => ...)` binds
  // `This` to exactly that in-progress schema, so a matching ref renders as
  // the bare identifier `This` instead.
  ref: (shape, meta, selfName) => {
    const s = shape as TypeShape & { kind: "ref" }
    if (selfName !== undefined && s.target === selfName) return "This"
    return call("Type.Ref", [s.target], [], meta)
  },
  // https://github.com/sinclairzx81/typebox — Type.Intersect([...]) is
  // TypeBox's native intersection combinator, accepting any arity.
  intersection: (shape, meta, selfName) => {
    const s = shape as TypeShape & { kind: "intersection" }
    if (s.members.length === 0) return "Type.Unknown()"
    return call("Type.Intersect", [`[${s.members.map((m) => toTypeBox(m, selfName)).join(", ")}]`], [], meta)
  },
  // https://github.com/sinclairzx81/typebox#Functions — Type.Function(params,
  // returns) is TypeBox's native callable-type constructor. `thisType` has no
  // dedicated slot (TypeBox validates parameter/return shapes, not a `this`
  // binding) and is dropped.
  function: (shape, meta, selfName) => {
    const s = shape as TypeShape & { kind: "function" }
    const params = s.params.map((p) => toTypeBox(p.type, selfName)).join(", ")
    return call("Type.Function", [`[${params}]`, toTypeBox(s.returnType, selfName)], [], meta)
  },
}

/** True when `shape` (or anything reachable under it) is a `ref` targeting
 * `name` — i.e. emitting it as `name`'s own declaration would be
 * self-referential. Generic over kind via `childTypeRefs`, so an
 * extension-registered kind with TypeRef-valued fields is covered without
 * this file knowing its name. */
function containsSelfRef(shape: TypeShape, name: string): boolean {
  if (shape.kind === "ref" && (shape as TypeShape & { kind: "ref" }).target === name) return true
  return childTypeRefs(shape).some((child) => containsSelfRef(child.shape, name))
}

export function toTypeBox(ref: TypeRef, selfName?: string): string {
  const converter = resolve(ref.shape.kind, handlers)
  const expr = converter === undefined ? "Type.Unknown()" : converter(ref.shape, ref.meta, selfName)
  return ref.meta.nullable === true ? `Type.Union([${expr}, Type.Null()])` : expr
}

export function toTypeBoxDeclaration(name: string, ref: TypeRef): string {
  // A self-referential type (e.g. a tree node whose `children` field is a
  // `ref` back to its own name) can't be built as `const X = Type.Object({
  // ..., ref-to-X })` — X isn't assigned yet at that point. TypeBox's answer
  // is `Type.Recursive(This => ...)`, which hands the in-progress schema to
  // its own builder callback; `selfName` tells the ref handler to render
  // that self-reference as `This` instead of the (not yet valid) `X`.
  if (containsSelfRef(ref.shape, name)) {
    return `const ${name} = Type.Recursive((This) => ${toTypeBox(ref, name)});`
  }
  return `const ${name} = ${toTypeBox(ref)};`
}

export function toTypeBoxDeclarations(registry: Record<string, TypeRef>): string {
  const declarations = Object.entries(registry).map(([name, ref]) => toTypeBoxDeclaration(name, ref))
  return [`import { Type } from "@sinclair/typebox";`, "", ...declarations].join("\n")
}
