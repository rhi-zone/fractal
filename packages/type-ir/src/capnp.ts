import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target)
}

// Cap'n Proto schema language: https://capnproto.org/language.html
export type CapnpStruct = {
  name: string
  fields: Array<{ name: string; type: string; ordinal: number; description?: string }>
  nestedStructs?: CapnpStruct[]
  nestedEnums?: Array<{ name: string; values: readonly string[] }>
  description?: string
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

// Built-in types: https://capnproto.org/language.html#built-in-types
const handlers: Record<string, Converter> = {
  boolean: leaf("Bool"),
  number: leaf("Float64"),
  integer: leaf("Int64"),
  int32: leaf("Int32"),
  int64: leaf("Int64"),
  float32: leaf("Float32"),
  float64: leaf("Float64"),
  string: leaf("Text"),
  uuid: leaf("Text"),
  uri: leaf("Text"),
  // No temporal types in Cap'n Proto; datetime follows the unix-timestamp convention.
  datetime: leaf("Int64"),
  date: leaf("Text"),
  time: leaf("Text"),
  duration: leaf("Int64"),
  bytes: leaf("Data"),
  null: leaf("Void"),
  void: leaf("Void"),
  unknown: leaf("AnyPointer"),
  never: leaf("Void"),
  // Nested structs need field-name context to be named; toCapnpStruct special-cases
  // object fields to emit a properly named nested struct instead of falling through here.
  object: (_shape, meta) => (typeof meta.structName === "string" ? meta.structName : "AnyPointer"),
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return `List(${toCapnpType(s.element)})`
  },
  // No tuple construct (§ "Structs"); lossy — degrades to a list of opaque pointers.
  tuple: leaf("List(AnyPointer)"),
  // No map built-in (§ "Language Reference" has no map primitive); toCapnpStruct
  // special-cases map fields to emit a helper Entry struct instead of falling through here.
  map: leaf("List(Entry)"),
  // Unions require a discriminant tag (§ "Unions") that a bare TypeRef union has no slot
  // for; lossy — degrades to an opaque pointer.
  union: leaf("AnyPointer"),
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (s.value === null) return "Void"
    if (typeof s.value === "string") return "Text"
    if (typeof s.value === "boolean") return "Bool"
    return Number.isInteger(s.value) ? "Int64" : "Float64"
  },
  enum: (shape, meta) => {
    const s = shape as TypeShape & { kind: "enum" }
    return typeof meta.enumName === "string" ? meta.enumName : `Enum${s.members.length}`
  },
  ref: (shape) => (shape as TypeShape & { kind: "ref" }).target,
  // No intersection/mixin construct (§ "Language Reference") — lossy: falls
  // back to the first member's type, dropping the rest.
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    return first === undefined ? "AnyPointer" : toCapnpType(first)
  },
}

export function toCapnpType(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  return converter === undefined ? "AnyPointer" : converter(ref.shape, ref.meta)
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1)
}

// Cap'n Proto style (§ "Naming"): enumerants are lowerCamelCase.
function toLowerCamel(name: string): string {
  return name.toLowerCase()
}

export function toCapnpStruct(name: string, ref: TypeRef): CapnpStruct {
  const shape = ref.shape as TypeShape & { kind: "object" }
  const fields: CapnpStruct["fields"] = []
  const nestedStructs: CapnpStruct[] = []
  const nestedEnums: Array<{ name: string; values: readonly string[] }> = []
  let ordinal = 0

  for (const [fieldName, fieldRef] of Object.entries(shape.fields)) {
    const description: { description: string } | Record<string, never> =
      typeof fieldRef.meta.description === "string" ? { description: fieldRef.meta.description } : {}
    if (isA(fieldRef.shape.kind, "object")) {
      const nestedName = capitalize(fieldName)
      nestedStructs.push(toCapnpStruct(nestedName, fieldRef))
      fields.push({ name: fieldName, type: nestedName, ordinal, ...description })
    } else if (
      fieldRef.shape.kind === "array" &&
      isA((fieldRef.shape as TypeShape & { kind: "array" }).element.shape.kind, "object")
    ) {
      const nestedName = capitalize(fieldName)
      const element = (fieldRef.shape as TypeShape & { kind: "array" }).element
      nestedStructs.push(toCapnpStruct(nestedName, element))
      fields.push({ name: fieldName, type: `List(${nestedName})`, ordinal, ...description })
    } else if (fieldRef.shape.kind === "enum") {
      const enumName = capitalize(fieldName)
      const members = (fieldRef.shape as TypeShape & { kind: "enum" }).members
      nestedEnums.push({ name: enumName, values: members })
      fields.push({ name: fieldName, type: enumName, ordinal, ...description })
    } else if (fieldRef.shape.kind === "map") {
      const mapShape = fieldRef.shape as TypeShape & { kind: "map" }
      const entryName = `${capitalize(fieldName)}Entry`
      // No map built-in (§ "Language Reference"): the canonical workaround is
      // List(Entry) where Entry is a two-field key/value struct.
      const entryStruct: CapnpStruct = {
        name: entryName,
        fields: [
          { name: "key", type: toCapnpType(mapShape.key), ordinal: 0 },
          { name: "value", type: toCapnpType(mapShape.value), ordinal: 1 },
        ],
      }
      nestedStructs.push(entryStruct)
      fields.push({ name: fieldName, type: `List(${entryName})`, ordinal, ...description })
    } else {
      fields.push({ name: fieldName, type: toCapnpType(fieldRef), ordinal, ...description })
    }
    ordinal++
  }

  const result: CapnpStruct = { name, fields }
  if (nestedStructs.length > 0) result.nestedStructs = nestedStructs
  if (nestedEnums.length > 0) result.nestedEnums = nestedEnums
  if (typeof ref.meta.description === "string") result.description = ref.meta.description
  return result
}

function renderField(field: CapnpStruct["fields"][number], indent: string): string[] {
  const lines: string[] = []
  // Cap'n Proto has no doc-comment keyword (§ "Language Reference"); `#` line
  // comments immediately above the field are the idiomatic convention.
  if (typeof field.description === "string") lines.push(`${indent}# ${field.description}`)
  lines.push(`${indent}${field.name} @${field.ordinal} :${field.type};`)
  return lines
}

function renderStruct(struct: CapnpStruct, depth: number): string[] {
  const indent = "  ".repeat(depth)
  const inner = "  ".repeat(depth + 1)
  const lines: string[] = []
  // Cap'n Proto has no doc-comment keyword (§ "Language Reference"); `#` line
  // comments immediately above the struct are the idiomatic convention.
  if (typeof struct.description === "string") lines.push(`${indent}# ${struct.description}`)
  lines.push(`${indent}struct ${struct.name} {`)

  for (const field of struct.fields) lines.push(...renderField(field, inner))

  for (const e of struct.nestedEnums ?? []) {
    lines.push(`${inner}enum ${e.name} {`)
    // Cap'n Proto enums (§ "Enums"): ordinals are assigned sequentially starting at 0.
    e.values.forEach((value, i) => lines.push(`${inner}  ${toLowerCamel(value)} @${i};`))
    lines.push(`${inner}}`)
  }

  for (const nested of struct.nestedStructs ?? []) lines.push(...renderStruct(nested, depth + 1))

  lines.push(`${indent}}`)
  return lines
}

export function renderCapnp(structs: CapnpStruct[], id?: string): string {
  // File ID (§ "Files"): every .capnp file must declare a unique @0x... identifier.
  const header = id !== undefined ? `@${id};` : "# @0x... (assign a unique ID)"
  const lines = [header, ""]
  for (const struct of structs) {
    lines.push(...renderStruct(struct, 0), "")
  }
  return `${lines.join("\n").trimEnd()}\n`
}
