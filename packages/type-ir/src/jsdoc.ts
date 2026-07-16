import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

function quote(value: string): string {
  return JSON.stringify(value)
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

const handlers: Record<string, Converter> = {
  boolean: leaf("boolean"),
  number: leaf("number"),
  integer: leaf("number"),
  int32: leaf("number"),
  int64: leaf("number"),
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
  unknown: leaf("*"),
  never: leaf("never"),
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const entries = Object.entries(s.fields)
    if (entries.length === 0) return "Object.<string, *>"
    const props = entries.map(([name, field]) => `${name}: ${toJsDocType(field)}`)
    return `{${props.join(", ")}}`
  },
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return `Array.<${toJsDocType(s.element)}>`
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    const types = [...new Set(s.elements.map(toJsDocType))]
    return `Array.<${types.join("|")}>`
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return `Object.<string, ${toJsDocType(s.value)}>`
  },
  union: (shape) => {
    const s = shape as TypeShape & { kind: "union" }
    const types = [...new Set(s.variants.map(toJsDocType))]
    return `(${types.join("|")})`
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (typeof s.value === "string") return quote(s.value)
    return String(s.value)
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return `(${s.members.map(quote).join("|")})`
  },
  ref: (shape) => {
    const s = shape as TypeShape & { kind: "ref" }
    return s.target
  },
  // JSDoc/Closure Compiler type syntax has no intersection operator (unlike its
  // union support via `|`) — lossy fallback: the first member's type, dropping
  // the rest.
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    return first === undefined ? "*" : toJsDocType(first)
  },
}

export function toJsDocType(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  const type = converter === undefined ? "*" : converter(ref.shape, ref.meta)
  return ref.meta.nullable === true ? `?${type}` : type
}

function propertyLine(name: string, field: TypeRef): string {
  const optional = field.meta.optional === true
  const label = optional ? `[${name}]` : name
  const typeExpr = toJsDocType(field)
  const description =
    typeof field.meta.description === "string" ? field.meta.description : optional ? "optional" : undefined
  const suffix = description === undefined ? "" : ` - ${description}`
  return ` * @property {${typeExpr}} ${label}${suffix}`
}

function isObjectKind(kind: string): boolean {
  return kind === "object" || ancestors(kind).includes("object")
}

export function toJsDocTypedef(name: string, ref: TypeRef): string {
  const description = typeof ref.meta.description === "string" ? ` ${ref.meta.description}` : ""

  if (isObjectKind(ref.shape.kind)) {
    const s = ref.shape as TypeShape & { kind: "object" }
    const lines = Object.entries(s.fields).map(([fieldName, field]) => propertyLine(fieldName, field))
    return ["/**", ` * @typedef {Object} ${name}${description}`, ...lines, " */"].join("\n")
  }

  return `/** @typedef {${toJsDocType(ref)}} ${name}${description} */`
}

export function toJsDocTypedefs(registry: Record<string, TypeRef>): string {
  return Object.entries(registry)
    .map(([name, ref]) => toJsDocTypedef(name, ref))
    .join("\n\n")
}
