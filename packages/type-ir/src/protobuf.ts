import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target)
}

// Proto3 language spec: https://protobuf.dev/programming-guides/proto3/
export type ProtoField = {
  type: string
  repeated: boolean
  optional: boolean
  mapKey?: string
  mapValue?: string
  deprecated?: boolean
  description?: string
}

export type ProtoMessage = {
  name: string
  fields: Array<{ name: string; field: ProtoField; number: number }>
  nestedMessages?: ProtoMessage[]
  nestedEnums?: Array<{ name: string; values: readonly string[] }>
  description?: string
}

type ProtoBase = { type: string; repeated?: boolean; mapKey?: string; mapValue?: string }

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => ProtoBase

const leaf =
  (type: string): Converter =>
  () => ({ type })

// Well-known types: https://protobuf.dev/reference/protobuf/google.protobuf/
const handlers: Record<string, Converter> = {
  boolean: leaf("bool"),
  number: leaf("double"),
  integer: leaf("int64"),
  int32: leaf("int32"),
  int64: leaf("int64"),
  float32: leaf("float"),
  float64: leaf("double"),
  string: leaf("string"),
  uuid: leaf("string"),
  uri: leaf("string"),
  datetime: leaf("google.protobuf.Timestamp"),
  date: leaf("string"),
  time: leaf("string"),
  duration: leaf("google.protobuf.Duration"),
  bytes: leaf("bytes"),
  null: leaf("google.protobuf.NullValue"),
  void: leaf("google.protobuf.Empty"),
  unknown: leaf("google.protobuf.Any"),
  never: leaf("google.protobuf.Empty"),
  // No context (field name) is available here to name a nested message; toProtoMessage
  // special-cases "object" fields to emit a properly named nested message instead of
  // falling through to this generic handler.
  object: (_shape, meta) => ({
    type: typeof meta.messageName === "string" ? meta.messageName : "google.protobuf.Struct",
  }),
  // A class instance carries only nominal identity (className/source), never fields
  // (see type-ir's TypeKinds.instance doc comment) — proto3 has no construct for an
  // opaque class reference, so this degrades honestly to Any rather than emitting a
  // message with no fields.
  instance: leaf("google.protobuf.Any"),
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return { type: toProtoField(s.element).type, repeated: true }
  },
  // Proto3 has no tuple construct (§ "Scalar Value Types" / message composition); this is
  // lossy — heterogeneous tuples degrade to a repeated field of the widest common type.
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    const elementTypes = s.elements.map((element) => toProtoField(element).type)
    const [first] = elementTypes
    const uniform = first !== undefined && elementTypes.every((type) => type === first)
    return { type: uniform ? first : "google.protobuf.Any", repeated: true }
  },
  // Map fields: https://protobuf.dev/programming-guides/proto3/#maps
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    const key = toProtoField(s.key).type
    const value = toProtoField(s.value).type
    return { type: `map<${key}, ${value}>`, mapKey: key, mapValue: value }
  },
  // Oneof is a field-level construct in proto3 (§ "Using Oneof"), not a standalone type, so
  // a union in the type IR degrades to google.protobuf.Any rather than a proto oneof.
  union: leaf("google.protobuf.Any"),
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (s.value === null) return { type: "google.protobuf.NullValue" }
    if (typeof s.value === "string") return { type: "string" }
    if (typeof s.value === "boolean") return { type: "bool" }
    return { type: Number.isInteger(s.value) ? "int64" : "double" }
  },
  enum: (shape, meta) => {
    const s = shape as TypeShape & { kind: "enum" }
    return { type: typeof meta.enumName === "string" ? meta.enumName : `Enum${s.members.length}` }
  },
  ref: (shape) => {
    const s = shape as TypeShape & { kind: "ref" }
    return { type: s.target }
  },
  // Proto3 has no intersection/mixin construct — lossy: falls back to the
  // first member's field type, dropping the rest.
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    return first === undefined ? { type: "google.protobuf.Any" } : toProtoField(first)
  },
  // Proto3 has no callable-type construct — degrades honestly to Any, same as
  // `instance` above.
  function: leaf("google.protobuf.Any"),
}

export function toProtoField(ref: TypeRef): ProtoField {
  const converter = resolve(ref.shape.kind, handlers)
  const base = converter === undefined ? { type: "google.protobuf.Any" } : converter(ref.shape, ref.meta)
  const optional = ref.meta.optional === true || ref.meta.nullable === true
  const field: ProtoField = { type: base.type, repeated: base.repeated === true, optional }
  if (base.mapKey !== undefined) field.mapKey = base.mapKey
  if (base.mapValue !== undefined) field.mapValue = base.mapValue
  // FieldOptions.deprecated (descriptor.proto): renders as the `[deprecated = true]`
  // field option (§ "Options" / https://protobuf.dev/programming-guides/proto3/#options).
  if (ref.meta.deprecated === true) field.deprecated = true
  // Proto3 has no doc-comment keyword of its own; `//` line comments (§ "Language
  // Specification" — the same C/C++-style comments as the rest of the language)
  // immediately above a field are the idiomatic way tools like protoc-gen-doc
  // read documentation, so `meta.description` renders as one.
  if (typeof ref.meta.description === "string") field.description = ref.meta.description
  return field
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1)
}

export function toProtoMessage(name: string, ref: TypeRef): ProtoMessage {
  const shape = ref.shape as TypeShape & { kind: "object" }
  const fields: ProtoMessage["fields"] = []
  const nestedMessages: ProtoMessage[] = []
  const nestedEnums: Array<{ name: string; values: readonly string[] }> = []
  let number = 1

  for (const [fieldName, fieldRef] of Object.entries(shape.fields)) {
    const optional = fieldRef.meta.optional === true || fieldRef.meta.nullable === true
    const deprecated: { deprecated: true } | Record<string, never> =
      fieldRef.meta.deprecated === true ? { deprecated: true } : {}
    const description: { description: string } | Record<string, never> =
      typeof fieldRef.meta.description === "string" ? { description: fieldRef.meta.description } : {}
    if (isA(fieldRef.shape.kind, "object")) {
      const nestedName = capitalize(fieldName)
      nestedMessages.push(toProtoMessage(nestedName, fieldRef))
      fields.push({ name: fieldName, field: { type: nestedName, repeated: false, optional, ...deprecated, ...description }, number })
    } else if (
      fieldRef.shape.kind === "array" &&
      isA((fieldRef.shape as TypeShape & { kind: "array" }).element.shape.kind, "object")
    ) {
      const nestedName = capitalize(fieldName)
      const element = (fieldRef.shape as TypeShape & { kind: "array" }).element
      nestedMessages.push(toProtoMessage(nestedName, element))
      fields.push({
        name: fieldName,
        field: { type: nestedName, repeated: true, optional: false, ...deprecated, ...description },
        number,
      })
    } else if (fieldRef.shape.kind === "enum") {
      const enumName = capitalize(fieldName)
      const members = (fieldRef.shape as TypeShape & { kind: "enum" }).members
      nestedEnums.push({ name: enumName, values: members })
      fields.push({ name: fieldName, field: { type: enumName, repeated: false, optional, ...deprecated, ...description }, number })
    } else {
      fields.push({ name: fieldName, field: toProtoField(fieldRef), number })
    }
    number++
  }

  const message: ProtoMessage = { name, fields }
  if (nestedMessages.length > 0) message.nestedMessages = nestedMessages
  if (nestedEnums.length > 0) message.nestedEnums = nestedEnums
  if (typeof ref.meta.description === "string") message.description = ref.meta.description
  return message
}

function renderField(entry: ProtoMessage["fields"][number], indent: string): string[] {
  const { field } = entry
  const lines: string[] = []
  // Proto3 has no doc-comment keyword (§ "Language Specification"); `//` line
  // comments immediately above the field are the idiomatic convention.
  if (typeof field.description === "string") lines.push(`${indent}// ${field.description}`)
  // Map fields carry no label (§ "Maps": "repeated is not allowed for map fields"); proto3
  // optional fields use the explicit "optional" keyword (§ "Field Rules").
  const label = field.mapKey !== undefined ? "" : field.repeated ? "repeated " : field.optional ? "optional " : ""
  // FieldOptions.deprecated renders as a bracketed field option
  // (§ "Options": https://protobuf.dev/programming-guides/proto3/#options).
  const options = field.deprecated === true ? " [deprecated = true]" : ""
  lines.push(`${indent}${label}${field.type} ${entry.name} = ${entry.number}${options};`)
  return lines
}

function renderMessage(message: ProtoMessage, depth: number): string[] {
  const indent = "  ".repeat(depth)
  const inner = "  ".repeat(depth + 1)
  const lines: string[] = []
  // Proto3 has no doc-comment keyword (§ "Language Specification"); `//` line
  // comments immediately above the message are the idiomatic convention.
  if (typeof message.description === "string") lines.push(`${indent}// ${message.description}`)
  lines.push(`${indent}message ${message.name} {`)

  for (const entry of message.fields) lines.push(...renderField(entry, inner))

  for (const e of message.nestedEnums ?? []) {
    lines.push(`${inner}enum ${e.name} {`)
    // Proto3 enums (§ "Enum"): the first defined value's number must be 0.
    e.values.forEach((value, i) => lines.push(`${inner}  ${value.toUpperCase()} = ${i};`))
    lines.push(`${inner}}`)
  }

  for (const nested of message.nestedMessages ?? []) lines.push(...renderMessage(nested, depth + 1))

  lines.push(`${indent}}`)
  return lines
}

export function renderProto(messages: ProtoMessage[]): string {
  const lines = ['syntax = "proto3";', ""]
  for (const message of messages) {
    lines.push(...renderMessage(message, 0), "")
  }
  return `${lines.join("\n").trimEnd()}\n`
}
