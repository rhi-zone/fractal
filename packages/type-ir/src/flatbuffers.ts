import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target)
}

// FlatBuffers schema language (.fbs): https://flatbuffers.dev/schema/
export type FbField = {
  type: string
  required: boolean
  deprecated?: boolean
  description?: string
}

export type FbTable = {
  name: string
  fields: Array<{ name: string; field: FbField }>
  description?: string
}

export type FbEnum = {
  name: string
  base: string
  values: readonly string[]
  description?: string
}

export type FbUnion = {
  name: string
  types: readonly string[]
  description?: string
}

// FlatBuffers RPC declarations (§ "Services": https://flatbuffers.dev/schema/#services)
// — `MethodName(Request): Response;`. Both request and response must be table
// types, so (mirroring protobuf's/Cap'n Proto's own service projectors) a
// method's params are wrapped into a synthesized `<Method>Request` table (one
// field per param) and its return type into a `<Method>Response` table (a
// single `result` field, or none at all for a `void` return).
export type FbRpc = {
  name: string
  requestType: string
  responseType: string
}

export type FbService = {
  name: string
  rpcs: FbRpc[]
  tables: FbTable[]
  description?: string
}

// A declaration hoisted out while lowering a table field whose type has no
// inline FlatBuffers representation (nested object, tuple, enum, union, map).
// Unlike protobuf's/Cap'n Proto's nested message/struct syntax, FlatBuffers's
// schema language has NO nested-declaration construct at all (§ "Tables":
// https://flatbuffers.dev/schema/ — every table/struct/enum/union is a
// top-level declaration) — so these must always be hoisted out as sibling
// top-level declarations rather than inlined inside the enclosing braces.
type FbDecl = { kind: "table"; value: FbTable } | { kind: "enum"; value: FbEnum } | { kind: "union"; value: FbUnion }

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

// Scalar types: https://flatbuffers.dev/schema/#scalars
const handlers: Record<string, Converter> = {
  boolean: leaf("bool"),
  number: leaf("double"),
  integer: leaf("int"),
  int32: leaf("int32"),
  int64: leaf("int64"),
  float32: leaf("float"),
  float64: leaf("double"),
  string: leaf("string"),
  uuid: leaf("string"),
  uri: leaf("string"),
  // No temporal type in FlatBuffers; datetime follows the unix-timestamp convention.
  datetime: leaf("int64"),
  date: leaf("string"),
  time: leaf("string"),
  duration: leaf("int64"),
  bytes: leaf("[ubyte]"),
  // No null/void primitive (§ "Scalars" has no such type) — a standalone
  // reference degrades to opaque bytes, same fallback as `unknown` below; in
  // *table field* position these kinds are skipped entirely instead (see
  // `buildTable`), since FlatBuffers table fields are optional-by-default and
  // simply omitting the field is the honest encoding of "no value".
  unknown: leaf("[ubyte]"),
  // Nested objects need field-name context to be named; `buildTable` special-cases
  // `object` fields to hoist a properly named sibling table instead of falling
  // through to this generic handler. A standalone/top-level object reference (no
  // field context) falls back to meta.tableName, same convention as protobuf's
  // messageName / Cap'n Proto's structName.
  object: (_shape, meta) => (typeof meta.tableName === "string" ? meta.tableName : "AnyTable"),
  // A class instance carries only nominal identity (className/source), never
  // fields (see type-ir's TypeKinds.instance doc comment) — referenced by
  // className, trusting that a table of that name is declared elsewhere (the
  // mapping this projector was asked to follow; less defensive than
  // protobuf's/Cap'n Proto's opaque Any/AnyPointer degrade).
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return `[${toFlatBuffers(s.element)}]`
  },
  // No tuple construct (§ "Tables"); tuples lower to a table with positional
  // e0/e1/... fields — `buildTable`/`buildTupleTable` special-case tuple fields
  // to hoist a named sibling table. Standalone reference falls back to
  // meta.tableName, same convention as `object` above.
  tuple: (_shape, meta) => (typeof meta.tableName === "string" ? meta.tableName : "AnyTuple"),
  // No native map (§ "Tables" has no map primitive) — the idiomatic workaround
  // is a vector of a synthesized key/value entry table.
  map: (_shape, meta) => `[${typeof meta.entryName === "string" ? meta.entryName : "KeyValuePair"}]`,
  // Standalone reference falls back to meta.unionName; `buildTable` special-cases
  // union fields to hoist a named sibling `union` declaration.
  union: (_shape, meta) => (typeof meta.unionName === "string" ? meta.unionName : "AnyUnion"),
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (s.value === null) return "bool"
    if (typeof s.value === "string") return "string"
    if (typeof s.value === "boolean") return "bool"
    return Number.isInteger(s.value) ? "int" : "double"
  },
  enum: (shape, meta) => {
    const s = shape as TypeShape & { kind: "enum" }
    return typeof meta.enumName === "string" ? meta.enumName : `Enum${s.members.length}`
  },
  ref: (shape) => (shape as TypeShape & { kind: "ref" }).target,
  // No intersection/mixin construct (§ "Tables") — lossy: falls back to the
  // first member's type, dropping the rest.
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    return first === undefined ? "[ubyte]" : toFlatBuffers(first)
  },
  // FlatBuffers has no callable-type construct — degrades honestly to opaque
  // bytes, same as `unknown` above. (`method` falls back here too via
  // `registerParent` — this fallback only applies when a method TypeRef shows
  // up in ordinary *field* position; the actual method-as-RPC use case is
  // `toFlatBuffersService` below, which reads `interface.methods` directly.)
  function: leaf("[ubyte]"),
  // FlatBuffers's `rpc_service` (§ "Services") is a top-level declaration, not
  // a field type — a service surface embedded in field position has no
  // construct to degrade to, so this falls back to opaque bytes same as
  // `function`/`unknown` above. `toFlatBuffersService` is the real encoding.
  interface: leaf("[ubyte]"),
}

export function toFlatBuffers(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  return converter === undefined ? "[ubyte]" : converter(ref.shape, ref.meta)
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1)
}

// FlatBuffers table fields are optional-by-default (unlike structs, § "Tables
// vs. Structs": https://flatbuffers.dev/schema/#tables) — the inverse of
// proto3's default-required/opt-in-optional convention. To preserve fidelity
// with an IR field that is NOT marked optional/nullable, this emits the
// `(required)` attribute (§ "Attributes": https://flatbuffers.dev/schema/#attributes)
// rather than leaving the field silently optional.
function fieldRequired(meta: Readonly<Record<string, unknown>>): boolean {
  return !(meta.optional === true || meta.nullable === true)
}

function buildTupleTable(name: string, ref: TypeRef): FbTable {
  const shape = ref.shape as TypeShape & { kind: "tuple" }
  const fields: FbTable["fields"] = shape.elements.map((element, i) => ({
    name: `e${i}`,
    field: { type: toFlatBuffers(element), required: fieldRequired(element.meta) },
  }))
  const table: FbTable = { name, fields }
  if (typeof ref.meta.description === "string") table.description = ref.meta.description
  return table
}

function buildTable(name: string, ref: TypeRef, decls: FbDecl[]): FbTable {
  const shape = ref.shape as TypeShape & { kind: "object" }
  const fields: FbTable["fields"] = []

  for (const [fieldName, fieldRef] of Object.entries(shape.fields)) {
    // No null/void primitive (§ "Scalars") — skipped entirely rather than
    // degraded to a placeholder scalar, since an omitted (optional-by-default)
    // table field is the honest FlatBuffers encoding of "no value".
    if (isA(fieldRef.shape.kind, "null") || isA(fieldRef.shape.kind, "void")) continue

    const deprecated: { deprecated: true } | Record<string, never> =
      fieldRef.meta.deprecated === true ? { deprecated: true } : {}
    const description: { description: string } | Record<string, never> =
      typeof fieldRef.meta.description === "string" ? { description: fieldRef.meta.description } : {}
    const required = fieldRequired(fieldRef.meta)

    if (isA(fieldRef.shape.kind, "object")) {
      const nestedName = capitalize(fieldName)
      decls.push({ kind: "table", value: buildTable(nestedName, fieldRef, decls) })
      fields.push({ name: fieldName, field: { type: nestedName, required, ...deprecated, ...description } })
    } else if (
      fieldRef.shape.kind === "array" &&
      isA((fieldRef.shape as TypeShape & { kind: "array" }).element.shape.kind, "object")
    ) {
      const nestedName = capitalize(fieldName)
      const element = (fieldRef.shape as TypeShape & { kind: "array" }).element
      decls.push({ kind: "table", value: buildTable(nestedName, element, decls) })
      fields.push({ name: fieldName, field: { type: `[${nestedName}]`, required: false, ...deprecated, ...description } })
    } else if (fieldRef.shape.kind === "enum") {
      const enumName = capitalize(fieldName)
      const members = (fieldRef.shape as TypeShape & { kind: "enum" }).members
      decls.push({ kind: "enum", value: { name: enumName, base: "int", values: members } })
      fields.push({ name: fieldName, field: { type: enumName, required, ...deprecated, ...description } })
    } else if (fieldRef.shape.kind === "union") {
      const unionName = capitalize(fieldName)
      const variants = (fieldRef.shape as TypeShape & { kind: "union" }).variants
      decls.push({ kind: "union", value: { name: unionName, types: variants.map((v) => toFlatBuffers(v)) } })
      fields.push({ name: fieldName, field: { type: unionName, required: false, ...deprecated, ...description } })
    } else if (fieldRef.shape.kind === "map") {
      const mapShape = fieldRef.shape as TypeShape & { kind: "map" }
      const entryName = `${capitalize(fieldName)}Entry`
      decls.push({
        kind: "table",
        value: {
          name: entryName,
          fields: [
            { name: "key", field: { type: toFlatBuffers(mapShape.key), required: true } },
            { name: "value", field: { type: toFlatBuffers(mapShape.value), required: true } },
          ],
        },
      })
      fields.push({ name: fieldName, field: { type: `[${entryName}]`, required: false, ...deprecated, ...description } })
    } else if (fieldRef.shape.kind === "tuple") {
      const nestedName = capitalize(fieldName)
      decls.push({ kind: "table", value: buildTupleTable(nestedName, fieldRef) })
      fields.push({ name: fieldName, field: { type: nestedName, required, ...deprecated, ...description } })
    } else {
      fields.push({ name: fieldName, field: { type: toFlatBuffers(fieldRef), required, ...deprecated, ...description } })
    }
  }

  const table: FbTable = { name, fields }
  if (typeof ref.meta.description === "string") table.description = ref.meta.description
  return table
}

function buildService(name: string, ref: TypeRef): FbService {
  const shape = ref.shape as TypeShape & { kind: "interface" }
  const rpcs: FbRpc[] = []
  const tables: FbTable[] = []

  for (const [methodName, methodRef] of Object.entries(shape.methods)) {
    const m = methodRef.shape as TypeShape & {
      kind: "method" | "function"
      params: readonly { name: string; type: TypeRef }[]
      returnType: TypeRef
    }
    const rpcName = capitalize(methodName)

    const requestType = `${rpcName}Request`
    tables.push({
      name: requestType,
      fields: m.params.map((p) => ({ name: p.name, field: { type: toFlatBuffers(p.type), required: true } })),
    })

    const responseType = `${rpcName}Response`
    const isVoid = m.returnType.shape.kind === "void"
    tables.push({
      name: responseType,
      fields: isVoid ? [] : [{ name: "result", field: { type: toFlatBuffers(m.returnType), required: true } }],
    })

    rpcs.push({ name: rpcName, requestType, responseType })
  }

  const service: FbService = { name, rpcs, tables }
  if (typeof ref.meta.description === "string") service.description = ref.meta.description
  return service
}

function renderFieldLine(entry: FbTable["fields"][number]): string[] {
  const { field } = entry
  const lines: string[] = []
  // FlatBuffers has no doc-comment keyword of its own (§ "Schemas"); `///`
  // line comments immediately above a field are the idiomatic convention read
  // by flatc and downstream tooling.
  if (typeof field.description === "string") lines.push(`  /// ${field.description}`)
  const attrs: string[] = []
  // § "Attributes": https://flatbuffers.dev/schema/#attributes
  if (field.required) attrs.push("required")
  if (field.deprecated === true) attrs.push("deprecated")
  const suffix = attrs.length > 0 ? ` (${attrs.join(", ")})` : ""
  lines.push(`  ${entry.name}:${field.type}${suffix};`)
  return lines
}

function renderTable(table: FbTable): string {
  const lines: string[] = []
  if (typeof table.description === "string") lines.push(`/// ${table.description}`)
  lines.push(`table ${table.name} {`)
  for (const entry of table.fields) lines.push(...renderFieldLine(entry))
  lines.push("}")
  return lines.join("\n")
}

function renderEnum(e: FbEnum): string {
  const lines: string[] = []
  if (typeof e.description === "string") lines.push(`/// ${e.description}`)
  lines.push(`enum ${e.name} : ${e.base} {`)
  lines.push(`  ${e.values.join(", ")}`)
  lines.push("}")
  return lines.join("\n")
}

function renderUnion(u: FbUnion): string {
  const lines: string[] = []
  if (typeof u.description === "string") lines.push(`/// ${u.description}`)
  lines.push(`union ${u.name} { ${u.types.join(", ")} }`)
  return lines.join("\n")
}

function renderDecl(decl: FbDecl): string {
  switch (decl.kind) {
    case "table":
      return renderTable(decl.value)
    case "enum":
      return renderEnum(decl.value)
    case "union":
      return renderUnion(decl.value)
  }
}

function renderService(service: FbService): string {
  const lines: string[] = []
  for (const table of service.tables) lines.push(renderTable(table), "")
  if (typeof service.description === "string") lines.push(`/// ${service.description}`)
  lines.push(`rpc_service ${service.name} {`)
  for (const rpc of service.rpcs) lines.push(`  ${rpc.name}(${rpc.requestType}):${rpc.responseType};`)
  lines.push("}")
  return lines.join("\n")
}

/**
 * Lower an `object` (or `tuple`) TypeRef to a `table` declaration, hoisting
 * any nested object/tuple/enum/union/map fields out as sibling top-level
 * declarations (FlatBuffers has no nested-declaration syntax — see the
 * `FbDecl` doc comment above) and rendering everything as one string, sibling
 * declarations first, in the order they were discovered.
 */
export function toFlatBuffersTable(name: string, ref: TypeRef): string {
  const decls: FbDecl[] = []
  const table = ref.shape.kind === "tuple" ? buildTupleTable(name, ref) : buildTable(name, ref, decls)
  return [...decls.map(renderDecl), renderTable(table)].join("\n\n")
}

/**
 * Lower an `interface` TypeRef (a service's method surface) to a
 * `rpc_service` declaration (§ "Services": https://flatbuffers.dev/schema/#services)
 * — the KEY use case `method`/`interface` were added for (see protobuf.ts's
 * `toProtoService` for the parallel rationale). Both the request and response
 * of a FlatBuffers RPC method must be table types, so each method's params are
 * wrapped into a synthesized `<Method>Request` table and its return type into
 * a `<Method>Response` table, rendered alongside the `rpc_service` block.
 */
export function toFlatBuffersService(name: string, ref: TypeRef): string {
  return renderService(buildService(name, ref))
}

/**
 * Lower a registry of top-level TypeRefs (as would back a whole .fbs file) to
 * their declarations, dispatching on each entry's kind: `interface` -> service,
 * `enum` -> enum, `union` -> union, everything else -> table (tuples included,
 * via their positional e0/e1/... encoding).
 */
export function toFlatBuffersDeclarations(registry: Record<string, TypeRef>): string {
  const blocks: string[] = []
  for (const [name, ref] of Object.entries(registry)) {
    if (ref.shape.kind === "interface") {
      blocks.push(toFlatBuffersService(name, ref))
      continue
    }
    if (ref.shape.kind === "enum") {
      const members = (ref.shape as TypeShape & { kind: "enum" }).members
      const e: FbEnum = { name, base: "int", values: members }
      if (typeof ref.meta.description === "string") e.description = ref.meta.description
      blocks.push(renderEnum(e))
      continue
    }
    if (ref.shape.kind === "union") {
      const variants = (ref.shape as TypeShape & { kind: "union" }).variants
      const u: FbUnion = { name, types: variants.map((v) => toFlatBuffers(v)) }
      if (typeof ref.meta.description === "string") u.description = ref.meta.description
      blocks.push(renderUnion(u))
      continue
    }
    blocks.push(toFlatBuffersTable(name, ref))
  }
  return blocks.join("\n\n")
}

/**
 * Render a complete .fbs file (§ "Schemas": https://flatbuffers.dev/schema/)
 * from already-built tables/enums/unions/services — the FlatBuffers analogue
 * of protobuf.ts's `renderProto` / capnp.ts's `renderCapnp`. Enums and unions
 * are emitted first since FlatBuffers requires a type to be declared before
 * it's referenced (§ "Schemas": "types need to be declared before use").
 */
export function renderFlatBuffers(
  tables: FbTable[],
  enums: FbEnum[] = [],
  unions: FbUnion[] = [],
  services: FbService[] = [],
): string {
  const lines: string[] = []
  for (const e of enums) lines.push(renderEnum(e), "")
  for (const u of unions) lines.push(renderUnion(u), "")
  for (const table of tables) lines.push(renderTable(table), "")
  for (const service of services) {
    lines.push(renderService(service), "")
  }
  return `${lines.join("\n").trimEnd()}\n`
}
