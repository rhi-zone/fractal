import { resolve, type TypeRef, type TypeShape } from "./index.ts"

type Converter = (shape: TypeShape) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

function quote(value: string): string {
  return JSON.stringify(value)
}

const complexKinds = new Set(["union", "object", "map", "intersection"])

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
  bytes: leaf("Uint8Array"),
  null: leaf("null"),
  void: leaf("void"),
  unknown: leaf("unknown"),
  never: leaf("never"),
  object: (shape) => {
    const s = shape as TypeShape & { kind: "object" }
    const fields = Object.entries(s.fields).map(([name, field]) => {
      const optional = field.meta.optional === true
      return `${name}${optional ? "?" : ""}: ${toTypeScript(field)}`
    })
    return `{ ${fields.join("; ")} }`
  },
  // A class instance carries only nominal identity (className/source), never
  // fields (see type-ir's TypeKinds.instance doc comment) — the caller (whatever
  // assembles this emitted source into a module) is responsible for ensuring
  // `className` is imported from `source` alongside the generated declaration.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return complexKinds.has(s.element.shape.kind)
      ? `Array<${toTypeScript(s.element)}>`
      : `${toTypeScript(s.element)}[]`
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return `[${s.elements.map(toTypeScript).join(", ")}]`
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return s.key.shape.kind === "string"
      ? `Record<string, ${toTypeScript(s.value)}>`
      : `Map<${toTypeScript(s.key)}, ${toTypeScript(s.value)}>`
  },
  union: (shape) => {
    const s = shape as TypeShape & { kind: "union" }
    return s.variants.map(toTypeScript).join(" | ")
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (typeof s.value === "string") return quote(s.value)
    return String(s.value)
  },
  enum: (shape) => {
    const s = shape as TypeShape & { kind: "enum" }
    return s.members.map(quote).join(" | ")
  },
  ref: (shape) => {
    const s = shape as TypeShape & { kind: "ref" }
    return s.target
  },
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    return s.members.map(toTypeScript).join(" & ")
  },
}

export function toTypeScript(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  let type = converter === undefined ? "unknown" : converter(ref.shape)
  if (typeof ref.meta.brand === "string") {
    type = `${type} & { readonly __brand: ${quote(ref.meta.brand)} }`
  }
  return ref.meta.nullable === true ? `${type} | null` : type
}

// TSDoc (https://tsdoc.org/) comment above a declaration — driven by
// `meta.description` (the summary text) and `meta.deprecated` (the
// `@deprecated` block tag), same open-metadata-bag convention the jsdoc.ts
// projector uses. A single line renders as `/** ... */`; both together render
// as a multi-line block.
function docComment(meta: Readonly<Record<string, unknown>>): string {
  const description = typeof meta.description === "string" ? meta.description : undefined
  const deprecated = meta.deprecated === true
  if (description === undefined && !deprecated) return ""

  if (description !== undefined && deprecated) {
    return ["/**", ` * ${description}`, " * @deprecated", " */", ""].join("\n")
  }
  if (description !== undefined) return `/** ${description} */\n`
  return "/** @deprecated */\n"
}

export function toTypeDeclaration(name: string, ref: TypeRef): string {
  return `${docComment(ref.meta)}type ${name} = ${toTypeScript(ref)};`
}

export function toTypeDeclarations(registry: Record<string, TypeRef>): string {
  return Object.entries(registry)
    .map(([name, ref]) => toTypeDeclaration(name, ref))
    .join("\n")
}
