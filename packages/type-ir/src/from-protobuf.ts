// packages/type-ir/src/from-protobuf.ts — @rhi-zone/fractal-type-ir/from-protobuf
//
// Protobuf (proto3) -> TypeRef, the reverse direction of protobuf.ts's
// TypeRef -> proto3 projector (toProtoField/toProtoMessage/toProtoService).
//
// Two entry points, both converging on the same conversion core:
//
//   - fromProtoDescriptor(file) — PRIMARY. Takes a JSON structure shaped like
//     the JSON mapping of protobuf's own self-describing `descriptor.proto`
//     (`FileDescriptorProto`/`DescriptorProto`/`FieldDescriptorProto`/…,
//     camelCase field names, `TYPE_*` enum strings for
//     `FieldDescriptorProto.type` — what `protoc --descriptor_set_out` or a
//     JS/TS protobuf codegen's descriptor `toObject()`/`toJSON()` produces).
//     This is the format protobuf uses to describe itself, so it needs no
//     bespoke grammar.
//   - parseProtoText(text) / fromProtoText(text) — CONVENIENCE. Parses `.proto`
//     text via `protobufjs`'s real grammar (protobuf.parse), then adapts its
//     reflection tree (Type/Enum/Field/OneOf) into the same descriptor shape
//     `fromProtoDescriptor` consumes, so both paths share one conversion core
//     and one set of tests-worth of behavior. `protobufjs` is an optional
//     peer dependency (see package.json) — this module only needs it when
//     `parseProtoText`/`fromProtoText` are actually called.
//
// Both entry points return a `TypeRefDocument`: every message/enum in the
// file becomes a named entry in `defs` (keyed by its dotted nested path,
// e.g. `"Person"`, `"Person.Address"`), cross-references resolve through
// `{ kind: "ref", target }`, and `root` is a ref to the first top-level
// message/enum (or `unknown` if the file declares none). This mirrors how
// proto3 files actually work — multiple, often mutually-referential,
// independently-named top-level declarations — rather than forcing a
// single-schema shape the way `fromJsonSchema` does for JSON Schema's
// single-root convention.

import protobuf from "protobufjs"
import { t, types, typeRefDocument, type TypeRef, type TypeRefDocument } from "./index.ts"
import { bytes, datetime, duration, float32, float64, int32, int64, uint32, uint64 } from "./kinds/common.ts"

// ============================================================================
// Descriptor types — the JSON mapping of google/protobuf/descriptor.proto,
// trimmed to the subset this converter reads. `description` is NOT part of
// the real descriptor.proto (doc comments live in a separate `SourceCodeInfo`
// side-table there) — it's a deliberate extension so callers building this
// JSON by hand (or `parseProtoText`, which captures `//` comments) have
// somewhere to put them; real protoc descriptor-set JSON simply won't have it.
// ============================================================================

export type ProtoFieldType =
  | "TYPE_DOUBLE"
  | "TYPE_FLOAT"
  | "TYPE_INT64"
  | "TYPE_UINT64"
  | "TYPE_INT32"
  | "TYPE_FIXED64"
  | "TYPE_FIXED32"
  | "TYPE_BOOL"
  | "TYPE_STRING"
  | "TYPE_MESSAGE"
  | "TYPE_BYTES"
  | "TYPE_UINT32"
  | "TYPE_ENUM"
  | "TYPE_SFIXED32"
  | "TYPE_SFIXED64"
  | "TYPE_SINT32"
  | "TYPE_SINT64"

export type ProtoFieldDescriptor = {
  readonly name: string
  readonly number: number
  readonly type: ProtoFieldType
  /** Set for TYPE_MESSAGE/TYPE_ENUM — the referenced type's name, optionally
   * dotted/leading-dot-qualified (`.pkg.Outer.Inner`), per descriptor.proto
   * convention. `parseProtoText` emits the bare identifier as written. */
  readonly typeName?: string
  readonly label?: "LABEL_OPTIONAL" | "LABEL_REPEATED"
  /** proto3's explicit `optional` keyword (`FieldDescriptorProto.proto3_optional`
   * — JSON name `proto3Optional`), distinct from `label`: a singular proto3
   * field is implicitly presence-untracked unless this is set. */
  readonly proto3Optional?: boolean
  readonly oneofIndex?: number
  readonly options?: { readonly deprecated?: boolean }
  readonly description?: string
}

export type ProtoEnumValueDescriptor = {
  readonly name: string
  readonly number: number
  readonly description?: string
}

export type ProtoEnumDescriptor = {
  readonly name: string
  readonly value: readonly ProtoEnumValueDescriptor[]
  readonly description?: string
}

export type ProtoOneofDescriptor = {
  readonly name: string
}

export type ProtoMessageDescriptor = {
  readonly name: string
  readonly field?: readonly ProtoFieldDescriptor[]
  readonly nestedType?: readonly ProtoMessageDescriptor[]
  readonly enumType?: readonly ProtoEnumDescriptor[]
  readonly oneofDecl?: readonly ProtoOneofDescriptor[]
  /** `mapEntry: true` marks the synthetic 2-field (`key`/`value`) message
   * proto3 generates for every `map<K, V>` field — see "Maps":
   * https://protobuf.dev/programming-guides/proto3/#maps. Such messages are
   * resolved inline into a `map` TypeRef by field conversion and are never
   * themselves added to `defs` (they're a compiler artifact, not a
   * user-facing type). */
  readonly options?: { readonly mapEntry?: boolean; readonly deprecated?: boolean }
  readonly description?: string
}

export type ProtoFileDescriptor = {
  readonly name?: string
  readonly package?: string
  readonly messageType?: readonly ProtoMessageDescriptor[]
  readonly enumType?: readonly ProtoEnumDescriptor[]
}

// ============================================================================
// Scalar + well-known type tables
// ============================================================================

// Mirrors the brief's mapping exactly: sint32/fixed32/sfixed32 collapse to
// int32(), sint64/fixed64/sfixed64 collapse to int64() — proto3's wire-encoding
// variants (zigzag/fixed-width) are an encoding concern, not a domain-type
// distinction the IR tracks (the IR's int32/int64 kinds already exist for
// "how wide is this integer", not "how is it packed on the wire").
const scalarHandlers: Record<ProtoFieldType, (() => TypeRef) | undefined> = {
  TYPE_DOUBLE: () => float64(),
  TYPE_FLOAT: () => float32(),
  TYPE_INT64: () => int64(),
  TYPE_UINT64: () => uint64(),
  TYPE_INT32: () => int32(),
  TYPE_FIXED64: () => int64(),
  TYPE_FIXED32: () => int32(),
  TYPE_BOOL: () => t(types.boolean),
  TYPE_STRING: () => t(types.string),
  // Matches protobuf.ts's forward direction (`bytes: leaf("bytes")`) and
  // kinds/bytes.ts's dedicated `bytes` kind — using `string` + a format tag
  // instead would silently re-collapse to `string` when round-tripped back
  // through protobuf.ts's field converter (which only reads `.kind`, not
  // `meta.format`), losing the bytes/string distinction proto3 actually has.
  TYPE_BYTES: () => bytes(),
  TYPE_UINT32: () => uint32(),
  TYPE_ENUM: undefined, // resolved via the registry — see fieldBaseType
  TYPE_MESSAGE: undefined, // resolved via the registry — see fieldBaseType
  TYPE_SFIXED32: () => int32(),
  TYPE_SFIXED64: () => int64(),
  TYPE_SINT32: () => int32(),
  TYPE_SINT64: () => int64(),
}

function withMeta(ref: TypeRef, extra: Record<string, unknown>): TypeRef {
  if (Object.keys(extra).length === 0) return ref
  return { shape: ref.shape, meta: { ...ref.meta, ...extra } }
}

// Well-known types: https://protobuf.dev/reference/protobuf/google.protobuf/
// The reverse of protobuf.ts's `handlers.datetime`/`duration`/`unknown`/etc.
// Wrapper types (`google.protobuf.*Value`) are the proto3 idiom for "a
// nullable scalar" (proto3 has no field-level `optional` pre-3.15) — they
// round-trip as the scalar with `meta.nullable: true`.
const wellKnownHandlers: Record<string, () => TypeRef> = {
  "google.protobuf.Timestamp": () => datetime(),
  "google.protobuf.Duration": () => duration(),
  "google.protobuf.Any": () => withMeta(t(types.unknown), { protobufType: "google.protobuf.Any" }),
  "google.protobuf.Empty": () => t(types.void),
  "google.protobuf.NullValue": () => t(types.null),
  "google.protobuf.Struct": () => t(types.map(t(types.string), t(types.unknown))),
  "google.protobuf.Value": () => t(types.unknown),
  "google.protobuf.ListValue": () => t(types.array(t(types.unknown))),
  "google.protobuf.StringValue": () => withMeta(t(types.string), { nullable: true }),
  "google.protobuf.BoolValue": () => withMeta(t(types.boolean), { nullable: true }),
  "google.protobuf.Int32Value": () => withMeta(int32(), { nullable: true }),
  "google.protobuf.Int64Value": () => withMeta(int64(), { nullable: true }),
  "google.protobuf.UInt32Value": () => withMeta(uint32(), { nullable: true }),
  "google.protobuf.UInt64Value": () => withMeta(uint64(), { nullable: true }),
  "google.protobuf.FloatValue": () => withMeta(float32(), { nullable: true }),
  "google.protobuf.DoubleValue": () => withMeta(float64(), { nullable: true }),
  "google.protobuf.BytesValue": () => withMeta(bytes(), { nullable: true }),
}

// ============================================================================
// Registry — flatten the file's message/enum tree into dotted-path entries
// (e.g. "Person", "Person.Address") so field type references (which may be
// forward, sibling, or nested-relative per proto scoping rules) can resolve
// against a single flat lookup instead of a tree walk per reference.
// ============================================================================

type RegistryEntry = { readonly kind: "message"; readonly descriptor: ProtoMessageDescriptor } | { readonly kind: "enum"; readonly descriptor: ProtoEnumDescriptor }

function registerMessages(list: readonly ProtoMessageDescriptor[], prefix: string, registry: Map<string, RegistryEntry>): void {
  for (const m of list) {
    const qualified = prefix === "" ? m.name : `${prefix}.${m.name}`
    registry.set(qualified, { kind: "message", descriptor: m })
    if (m.nestedType !== undefined) registerMessages(m.nestedType, qualified, registry)
    if (m.enumType !== undefined) registerEnums(m.enumType, qualified, registry)
  }
}

function registerEnums(list: readonly ProtoEnumDescriptor[], prefix: string, registry: Map<string, RegistryEntry>): void {
  for (const e of list) {
    const qualified = prefix === "" ? e.name : `${prefix}.${e.name}`
    registry.set(qualified, { kind: "enum", descriptor: e })
  }
}

/**
 * Resolve a field's raw `typeName` (possibly leading-dot-qualified like real
 * descriptor JSON, possibly a bare local identifier like `parseProtoText`
 * emits) against the flat registry, trying — in order — an exact match, then
 * `selfPath`'s own scope and each enclosing scope outward (proto's C++-style
 * scoping: https://protobuf.dev/programming-guides/proto3/#reserved, §
 * "Nested Types" — search self, then enclosing message, then its enclosing
 * message, … then file scope), then finally any registry key whose last
 * dotted segment matches (a last-resort for typeName strings this parser
 * didn't fully qualify). Falls back to the raw (stripped) name unresolved —
 * producing a dangling `ref` — rather than throwing, matching this package's
 * other ingesters' honest-degrade convention for unrecognized input.
 */
function resolveTypeName(raw: string, registry: Map<string, RegistryEntry>, selfPath: string, pkg?: string): string {
  let name = raw.replace(/^\./, "")
  if (pkg !== undefined && pkg !== "" && name.startsWith(`${pkg}.`)) name = name.slice(pkg.length + 1)
  if (registry.has(name)) return name

  const parts = selfPath === "" ? [] : selfPath.split(".")
  for (let i = parts.length; i >= 0; i--) {
    const candidate = [...parts.slice(0, i), name].join(".")
    if (registry.has(candidate)) return candidate
  }

  const suffix = `.${name}`
  for (const key of registry.keys()) {
    if (key === name || key.endsWith(suffix)) return key
  }

  return name
}

// ============================================================================
// Field / message / enum conversion
// ============================================================================

/** The field's value type, unwrapped (no repeated/optional applied yet). */
function fieldBaseType(field: ProtoFieldDescriptor, registry: Map<string, RegistryEntry>, selfPath: string, pkg?: string): TypeRef {
  const scalar = scalarHandlers[field.type]
  if (scalar !== undefined) return scalar()

  // TYPE_MESSAGE or TYPE_ENUM (or, from parseProtoText, any non-scalar
  // identifier tagged TYPE_MESSAGE regardless of which it actually is — see
  // parseProtoText's doc comment. Resolution below reads the registry
  // entry's ACTUAL kind, so a mistagged TYPE_MESSAGE that's really an enum
  // still resolves correctly.)
  const rawTypeName = field.typeName ?? ""
  const strippedFull = rawTypeName.replace(/^\./, "")
  const wellKnown = wellKnownHandlers[strippedFull]
  if (wellKnown !== undefined) return wellKnown()

  const resolvedName = resolveTypeName(rawTypeName, registry, selfPath, pkg)
  const entry = registry.get(resolvedName)

  if (entry?.kind === "message" && entry.descriptor.options?.mapEntry === true) {
    const keyField = entry.descriptor.field?.find((f) => f.name === "key")
    const valueField = entry.descriptor.field?.find((f) => f.name === "value")
    const keyType = keyField !== undefined ? fieldBaseType(keyField, registry, resolvedName, pkg) : t(types.string)
    const valueType = valueField !== undefined ? fieldBaseType(valueField, registry, resolvedName, pkg) : t(types.unknown)
    return t(types.map(keyType, valueType))
  }

  // Message, enum, or unresolved — all become a `ref` (an unresolved name
  // becomes a dangling ref, per resolveTypeName's doc comment).
  return t(types.ref(resolvedName))
}

function fieldMeta(field: ProtoFieldDescriptor): Record<string, unknown> {
  const meta: Record<string, unknown> = {}
  if (field.proto3Optional === true) meta.optional = true
  if (field.options?.deprecated === true) meta.deprecated = true
  if (typeof field.description === "string") meta.description = field.description
  return meta
}

/** Full field type: base type + repeated wrapping + meta. Exported standalone
 * so a single `FieldDescriptorProto`-shaped value can be converted without a
 * whole file/message around it (mirrors from-json-schema.ts's `fromJsonSchema`
 * being independently callable). `registry`/`selfPath`/`pkg` default to an
 * empty scope — sufficient for fields with no message/enum-typed references. */
export function fromProtoField(
  field: ProtoFieldDescriptor,
  registry: Map<string, RegistryEntry> = new Map(),
  selfPath = "",
  pkg?: string,
): TypeRef {
  const base = fieldBaseType(field, registry, selfPath, pkg)
  // Map fields carry LABEL_REPEATED at the descriptor level too (§ "Maps" —
  // a map field IS internally `repeated MapEntry`), but they're not an
  // array of TypeRef — `fieldBaseType` already resolved them straight to a
  // `map` TypeRef, so repeated-wrapping is skipped for that shape.
  const wrapped = field.label === "LABEL_REPEATED" && base.shape.kind !== "map" ? t(types.array(base)) : base
  return withMeta(wrapped, fieldMeta(field))
}

function enumToTypeRef(descriptor: ProtoEnumDescriptor): TypeRef {
  const meta: Record<string, unknown> = {}
  if (typeof descriptor.description === "string") meta.description = descriptor.description
  return t(types.enum(descriptor.value.map((v) => v.name)), meta)
}

function messageToTypeRef(
  descriptor: ProtoMessageDescriptor,
  registry: Map<string, RegistryEntry>,
  selfPath: string,
  pkg?: string,
): TypeRef {
  const fields: Record<string, TypeRef> = {}

  // Group fields by oneofIndex (proto3 "Using Oneof":
  // https://protobuf.dev/programming-guides/proto3/#oneof) — each oneof
  // collapses to ONE object field named after the oneof, typed as a union of
  // its member fields' types (each variant tagged with the original proto
  // field name/number in meta, since `union.variants` carries only TypeRefs,
  // no names).
  const oneofFields = new Map<number, ProtoFieldDescriptor[]>()
  const plainFields: ProtoFieldDescriptor[] = []
  for (const field of descriptor.field ?? []) {
    if (field.oneofIndex !== undefined) {
      const group = oneofFields.get(field.oneofIndex) ?? []
      group.push(field)
      oneofFields.set(field.oneofIndex, group)
    } else {
      plainFields.push(field)
    }
  }

  for (const field of plainFields) {
    fields[field.name] = fromProtoField(field, registry, selfPath, pkg)
  }

  const oneofDecl = descriptor.oneofDecl ?? []
  for (const [index, groupFields] of oneofFields) {
    const oneofName = oneofDecl[index]?.name ?? `oneof${index}`
    const variants = groupFields.map((field) =>
      withMeta(fromProtoField(field, registry, selfPath, pkg), { protoFieldName: field.name, protoFieldNumber: field.number }),
    )
    // A oneof may be entirely unset — it's inherently optional presence.
    fields[oneofName] = withMeta(t(types.union(variants)), { optional: true })
  }

  const meta: Record<string, unknown> = {}
  if (typeof descriptor.description === "string") meta.description = descriptor.description
  return t(types.object(fields), meta)
}

// ============================================================================
// File-level entry point
// ============================================================================

/**
 * Convert a protobuf `FileDescriptorProto`-shaped JSON value into a
 * `TypeRefDocument`: every message/enum in the file (top-level and nested)
 * becomes a `defs` entry keyed by its dotted path, `root` is a `ref` to the
 * first top-level declaration (or `unknown` if the file declares none), and
 * every message/enum-typed field becomes a `{ kind: "ref", target }` pointing
 * into `defs` — so recursive and mutually-referential messages (common in
 * real-world .proto files) round-trip without infinite inlining.
 */
export function fromProtoDescriptor(file: ProtoFileDescriptor): TypeRefDocument {
  const registry = new Map<string, RegistryEntry>()
  registerMessages(file.messageType ?? [], "", registry)
  registerEnums(file.enumType ?? [], "", registry)

  const defs: Record<string, TypeRef> = {}
  for (const [name, entry] of registry) {
    if (entry.kind === "message") {
      // Synthetic map-entry messages are resolved inline by `fieldBaseType`
      // and are never a user-facing named type — see ProtoMessageDescriptor's
      // `options.mapEntry` doc comment.
      if (entry.descriptor.options?.mapEntry === true) continue
      defs[name] = messageToTypeRef(entry.descriptor, registry, name, file.package)
    } else {
      defs[name] = enumToTypeRef(entry.descriptor)
    }
  }

  const topNames = [...(file.messageType ?? []).map((m) => m.name), ...(file.enumType ?? []).map((e) => e.name)]
  const root = topNames.length > 0 ? t(types.ref(topNames[0]!)) : t(types.unknown)
  return typeRefDocument(root, defs)
}

// ============================================================================
// .proto text parser — convenience layer over fromProtoDescriptor
// ============================================================================

const protoKeywordToType: Record<string, ProtoFieldType> = {
  double: "TYPE_DOUBLE",
  float: "TYPE_FLOAT",
  int32: "TYPE_INT32",
  int64: "TYPE_INT64",
  uint32: "TYPE_UINT32",
  uint64: "TYPE_UINT64",
  sint32: "TYPE_SINT32",
  sint64: "TYPE_SINT64",
  fixed32: "TYPE_FIXED32",
  fixed64: "TYPE_FIXED64",
  sfixed32: "TYPE_SFIXED32",
  sfixed64: "TYPE_SFIXED64",
  bool: "TYPE_BOOL",
  string: "TYPE_STRING",
  bytes: "TYPE_BYTES",
}

/** Resolve a bare type-string token from `protobufjs`'s reflection tree (a
 * `Field#type`/`MapField#keyType`, always unqualified as written — parsing
 * doesn't resolve type references) into a field's `type`/`typeName`. Scalars
 * map to their real `TYPE_*` code (preserving fidelity, e.g. `sint32` stays
 * distinguishable from `int32` at the descriptor level — the int32()/int64()
 * collapse happens later, only at TypeRef-selection time via
 * `scalarHandlers`). Anything else is tagged `TYPE_MESSAGE` provisionally;
 * `fieldBaseType` corrects this against the registry's actual entry kind
 * during conversion (see its doc comment) — this converter never needs to
 * know whether an identifier names a message or an enum, since both message
 * and enum declarations may appear anywhere in the file (including after
 * first use), and `fromProtoDescriptor`'s registry-based resolution already
 * handles that scoping. */
function resolveTokenType(token: string): { type: ProtoFieldType; typeName?: string } {
  const scalar = protoKeywordToType[token]
  if (scalar !== undefined) return { type: scalar }
  return { type: "TYPE_MESSAGE", typeName: token }
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1)
}

function fieldOptionsOf(options: { readonly [k: string]: unknown } | undefined): { deprecated?: boolean } | undefined {
  if (options?.deprecated === true) return { deprecated: true }
  return undefined
}

/** Convert a `protobufjs` map field into its `ProtoFieldDescriptor` plus the
 * synthetic `<Field>Entry` nested message it references — proto3's own wire
 * representation of `map<K, V>` fields (see `ProtoMessageDescriptor`'s
 * `options.mapEntry` doc comment), which `protobufjs`'s reflection tree
 * doesn't materialize as a nested type the way real `descriptor.proto` JSON
 * does, so it's synthesized here to keep both `parseProtoText` and
 * `fromProtoDescriptor` working from the same descriptor shape. */
function convertMapField(field: InstanceType<typeof protobuf.MapField>): { field: ProtoFieldDescriptor; entry: ProtoMessageDescriptor } {
  const entryName = `${capitalize(field.name)}Entry`
  const keyResolved = resolveTokenType(field.keyType)
  const valueResolved = resolveTokenType(field.type)
  const entry: ProtoMessageDescriptor = {
    name: entryName,
    options: { mapEntry: true },
    field: [
      { name: "key", number: 1, type: keyResolved.type, ...(keyResolved.typeName !== undefined ? { typeName: keyResolved.typeName } : {}) },
      { name: "value", number: 2, type: valueResolved.type, ...(valueResolved.typeName !== undefined ? { typeName: valueResolved.typeName } : {}) },
    ],
  }
  const options = fieldOptionsOf(field.options)
  const descriptor: ProtoFieldDescriptor = {
    name: field.name,
    number: field.id,
    type: "TYPE_MESSAGE",
    typeName: entryName,
    label: "LABEL_REPEATED",
    ...(typeof field.comment === "string" ? { description: field.comment } : {}),
    ...(options !== undefined ? { options } : {}),
  }
  return { field: descriptor, entry }
}

/** Convert a `protobufjs` message field into a `ProtoFieldDescriptor`.
 * `oneofIndexOf` maps each *real* (user-declared) oneof to its index in the
 * message's `oneofDecl` — proto3's explicit `optional` keyword is
 * represented internally by `protobufjs` (and by real `descriptor.proto`) as
 * a synthetic single-member oneof (`OneOf#isProto3Optional`); such synthetic
 * oneofs are excluded from `oneofIndexOf` (see `convertMessage`), so a field
 * belonging to one falls through to the plain `proto3Optional: true` case
 * here rather than an `oneofIndex`. */
function convertField(field: InstanceType<typeof protobuf.Field>, oneofIndexOf: ReadonlyMap<InstanceType<typeof protobuf.OneOf>, number>): ProtoFieldDescriptor {
  const resolved = resolveTokenType(field.type)
  const proto3Optional = field.options?.proto3_optional === true
  const oneofIndex = !proto3Optional && field.partOf !== null ? oneofIndexOf.get(field.partOf) : undefined
  const options = fieldOptionsOf(field.options)
  return {
    name: field.name,
    number: field.id,
    type: resolved.type,
    ...(resolved.typeName !== undefined ? { typeName: resolved.typeName } : {}),
    ...(field.repeated ? { label: "LABEL_REPEATED" as const } : {}),
    ...(proto3Optional ? { proto3Optional: true } : {}),
    ...(oneofIndex !== undefined ? { oneofIndex } : {}),
    ...(typeof field.comment === "string" ? { description: field.comment } : {}),
    ...(options !== undefined ? { options } : {}),
  }
}

function convertEnum(node: InstanceType<typeof protobuf.Enum>): ProtoEnumDescriptor {
  const value: ProtoEnumValueDescriptor[] = Object.entries(node.values).map(([name, number]) => {
    const description = node.comments[name]
    return { name, number, ...(typeof description === "string" ? { description } : {}) }
  })
  return { name: node.name, value, ...(typeof node.comment === "string" ? { description: node.comment } : {}) }
}

function convertMessage(node: InstanceType<typeof protobuf.Type>): ProtoMessageDescriptor {
  const nestedType: ProtoMessageDescriptor[] = []
  const enumType: ProtoEnumDescriptor[] = []
  for (const nested of node.nestedArray) {
    if (nested instanceof protobuf.Type) nestedType.push(convertMessage(nested))
    else if (nested instanceof protobuf.Enum) enumType.push(convertEnum(nested))
    // Other nested kinds (nested services) aren't message/enum schema — see
    // parseProtoText's doc comment on why services are out of scope here.
  }

  // Real (user-declared) oneofs only — see convertField's doc comment on why
  // proto3's synthetic `optional`-field oneofs are excluded.
  const realOneofs = node.oneofsArray.filter((o) => !o.isProto3Optional)
  const oneofDecl: ProtoOneofDescriptor[] = realOneofs.map((o) => ({ name: o.name }))
  const oneofIndexOf = new Map(realOneofs.map((o, i) => [o, i] as const))

  const field: ProtoFieldDescriptor[] = []
  for (const f of node.fieldsArray) {
    if (f instanceof protobuf.MapField) {
      const converted = convertMapField(f)
      field.push(converted.field)
      nestedType.push(converted.entry)
    } else {
      field.push(convertField(f, oneofIndexOf))
    }
  }

  return {
    name: node.name,
    field,
    nestedType,
    enumType,
    oneofDecl,
    ...(typeof node.comment === "string" ? { description: node.comment } : {}),
  }
}

/**
 * Parse `.proto` text via `protobufjs`'s own grammar (`protobuf.parse`) and
 * adapt the resulting reflection tree (`Type`/`Enum`/`Field`/`OneOf`) into
 * the same descriptor shape `fromProtoDescriptor` consumes. Type references
 * (`Field#type`/`MapField#keyType`) are read as written, unresolved —
 * `resolveAll()` is deliberately never called, since that would require
 * well-known types (`google.protobuf.Timestamp` etc.) and any `import`ed
 * files to actually be loadable, which callers passing standalone `.proto`
 * snippets can't generally provide. Resolution instead happens the same way
 * it always has, in `fromProtoDescriptor`'s own registry (self/enclosing
 * scope search, then a well-known-types table, then a dangling `ref` as a
 * last resort — see `resolveTypeName`'s doc comment).
 *
 * `protobufjs` defaults to proto2 semantics when a file has no `syntax`
 * declaration (relevant to how it treats the `optional` keyword: proto2's
 * plain field-presence `optional` vs. proto3's explicit-presence `optional`,
 * which synthesizes a single-member oneof under the hood — see
 * `convertField`'s doc comment); since this ingester's domain is proto3
 * (per this module's header comment), a missing `syntax` statement is
 * treated as `proto3` rather than `protobufjs`'s own proto2 default.
 *
 * `service`/`rpc` blocks parse into `protobufjs` `Service` nodes, which
 * `convertMessage`'s nested-node walk simply doesn't recognize (only `Type`
 * and `Enum` are matched) — so they're structurally skipped without any
 * special-casing, matching this ingester's message/enum-schema-only scope
 * (RPCs are a projector-output-only concept in this package's protobuf.ts,
 * via `toProtoService`).
 */
export function parseProtoText(source: string): ProtoFileDescriptor {
  const withSyntax = /^\s*syntax\s*=/m.test(source) ? source : `syntax = "proto3";\n${source}`
  const parsed = protobuf.parse(withSyntax, { keepCase: true, alternateCommentMode: true })

  const messageType: ProtoMessageDescriptor[] = []
  const enumType: ProtoEnumDescriptor[] = []
  for (const node of parsed.root.nestedArray) {
    if (node instanceof protobuf.Type) messageType.push(convertMessage(node))
    else if (node instanceof protobuf.Enum) enumType.push(convertEnum(node))
  }

  return {
    ...(parsed.package !== undefined ? { package: parsed.package } : {}),
    messageType,
    enumType,
  }
}

/** Convenience: parse `.proto` text and convert it in one call. */
export function fromProtoText(source: string): TypeRefDocument {
  return fromProtoDescriptor(parseProtoText(source))
}
