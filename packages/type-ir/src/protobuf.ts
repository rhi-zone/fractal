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

// https://protobuf.dev/programming-guides/proto3/#services — a service's RPCs
// each take exactly one request message and return exactly one response
// message. `requestMessage`/`responseMessage` are synthesized wrapper
// messages (gRPC convention: `rpc Foo(FooRequest) returns (FooResponse)`)
// carrying the method's params/return value, since arbitrary scalar/callable
// types can't sit directly in an RPC's request/response position.
export type ProtoRpc = {
  name: string
  requestType: string
  responseType: string
  // Proto3 server-streaming RPC (§ "Services"): `returns (stream Response)`,
  // set when the method's TypeRef return type is `stream` — the one place in
  // this projector where `stream` DOES have a native keyword, since it's a
  // real part of proto3's RPC syntax (unlike message-field position, where
  // `toProtoField`'s `stream` handler degrades to `repeated` instead).
  responseStreaming?: boolean
}

export type ProtoService = {
  name: string
  rpcs: ProtoRpc[]
  messages: ProtoMessage[]
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
  email: leaf("string"),
  // https://protobuf.dev/reference/protobuf/google.protobuf/#timestamp —
  // both datetime and date (type-ir's `Date` domain type — see
  // kinds/date-time.ts) map to the well-known Timestamp type; proto3 has no
  // separate calendar-only date type in its core well-knowns.
  datetime: leaf("google.protobuf.Timestamp"),
  date: leaf("google.protobuf.Timestamp"),
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
  // Proto3's `stream` keyword (§ "Services") only appears in RPC method
  // parameter/return position (`rpc Foo(stream Request) returns (stream
  // Response)`) — there's no field-level streaming type to target here, so
  // this degrades to `repeated`, the same fallback `array` uses above. The
  // RPC-position case is handled directly by `toProtoService` below, which
  // reads `interface.methods` rather than going through this field converter.
  stream: (shape) => {
    const s = shape as TypeShape & { kind: "stream" }
    return { type: toProtoField(s.element).type, repeated: true }
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
  // `instance` above. (`method` falls back here too via `registerParent` —
  // this fallback only applies when a method TypeRef shows up in ordinary
  // *field* position; the actual method-as-RPC use case is `toProtoService`
  // below, which reads `interface.methods` directly rather than going through
  // this field-type converter.)
  function: leaf("google.protobuf.Any"),
  // A service surface embedded as a field's type has no proto3 field
  // construct (`service` is a top-level declaration, not a field type,
  // per https://protobuf.dev/programming-guides/proto3/#services) — degrades
  // honestly to Any, same as `function`/`instance` above. The real encoding
  // of `interface` is `toProtoService`, which emits a `service { rpc ... }`
  // block from an `interface` TypeRef used as a top-level declaration.
  interface: leaf("google.protobuf.Any"),
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

/**
 * Lower an `interface` TypeRef (a service's method surface) to a
 * `ProtoService` — the KEY use case `method`/`interface` were added for
 * (Cap'n Proto's/Protobuf's own missing "callable contract" vocabulary,
 * see TypeKinds.interface's doc comment in index.ts). Each method becomes an
 * RPC; since proto3 RPCs take exactly one request and one response message
 * (§ "Services"), each method's params are wrapped into a synthesized
 * `<Method>Request` message (one field per param) and its return type into a
 * `<Method>Response` message (a single `result` field, or no fields at all
 * for a `void` return) — the standard gRPC wrapper-message convention.
 */
export function toProtoService(name: string, ref: TypeRef): ProtoService {
  const shape = ref.shape as TypeShape & { kind: "interface" }
  const rpcs: ProtoRpc[] = []
  const messages: ProtoMessage[] = []

  for (const [methodName, methodRef] of Object.entries(shape.methods)) {
    const m = methodRef.shape as TypeShape & { kind: "method" | "function"; params: unknown; returnType: unknown }
    const rpcName = capitalize(methodName)
    const params = (m.params ?? []) as Array<{ name: string; type: TypeRef }>
    const returnType = m.returnType as TypeRef | undefined

    const requestType = `${rpcName}Request`
    messages.push({
      name: requestType,
      fields: params.map((p, i) => ({ name: p.name, field: toProtoField(p.type), number: i + 1 })),
    })

    const responseType = `${rpcName}Response`
    const isVoid = returnType === undefined || returnType.shape.kind === "void"
    // A `stream` return type maps to proto3's `stream` RPC keyword (see the
    // `ProtoRpc.responseStreaming` doc comment) — the synthesized response
    // message wraps the stream's *element* type, not the stream itself,
    // since each streamed message is one element.
    const isStreaming = returnType !== undefined && returnType.shape.kind === "stream"
    const resultType = isStreaming ? (returnType.shape as TypeShape & { kind: "stream" }).element : returnType
    messages.push({
      name: responseType,
      fields: isVoid ? [] : [{ name: "result", field: toProtoField(resultType as TypeRef), number: 1 }],
    })

    rpcs.push({ name: rpcName, requestType, responseType, ...(isStreaming ? { responseStreaming: true } : {}) })
  }

  const service: ProtoService = { name, rpcs, messages }
  if (typeof ref.meta.description === "string") service.description = ref.meta.description
  return service
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

function renderService(service: ProtoService, depth: number): string[] {
  const indent = "  ".repeat(depth)
  const inner = "  ".repeat(depth + 1)
  const lines: string[] = []
  if (typeof service.description === "string") lines.push(`${indent}// ${service.description}`)
  lines.push(`${indent}service ${service.name} {`)
  for (const rpc of service.rpcs) {
    const responseType = rpc.responseStreaming === true ? `stream ${rpc.responseType}` : rpc.responseType
    lines.push(`${inner}rpc ${rpc.name}(${rpc.requestType}) returns (${responseType});`)
  }
  lines.push(`${indent}}`)
  return lines
}

// `services`' synthesized request/response messages (see `toProtoService`)
// are rendered as top-level sibling messages alongside `messages` — proto3
// has no nested-message-inside-service construct (§ "Services" only allows
// `rpc` entries in a service block), so they're declared at the same level
// the RPCs reference them by name.
export function renderProto(messages: ProtoMessage[], services: ProtoService[] = []): string {
  const lines = ['syntax = "proto3";', ""]
  for (const message of messages) {
    lines.push(...renderMessage(message, 0), "")
  }
  for (const service of services) {
    for (const message of service.messages) lines.push(...renderMessage(message, 0), "")
    lines.push(...renderService(service, 0), "")
  }
  return `${lines.join("\n").trimEnd()}\n`
}
