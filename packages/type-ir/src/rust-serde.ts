import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target)
}

function quote(value: string): string {
  return JSON.stringify(value)
}

// Rust identifiers are conventionally snake_case (fields) / PascalCase
// (types, enum variants). IR field/member names are wire-format strings
// (arbitrary camelCase/kebab-case/whatever the source used) — converting to
// idiomatic Rust casing and emitting a `#[serde(rename = "...")]` whenever
// the converted form doesn't round-trip is the standard serde convention
// (https://serde.rs/field-attrs.html#rename) for keeping the Rust identifier
// idiomatic while the wire representation stays byte-for-byte unchanged.
function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
}

function toPascalCase(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ""))
  return cleaned.length === 0 ? cleaned : cleaned[0]!.toUpperCase() + cleaned.slice(1)
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

// Base inline-expression handlers — the Rust analogue of typescript.ts's
// `handlers` map. Used for type positions that don't carry enough naming
// context to hoist a fresh declaration (array elements, tuple slots, map
// keys/values, standalone references): `object`/`enum`/`union` here fall
// back to a caller-supplied name (`meta.typeName`/`meta.enumName`) or an
// honest opaque escape hatch (`serde_json::Value`) rather than fabricating
// a struct with no name. `bareType` below is the field/variant-context
// counterpart that DOES have a name to hoist a declaration under.
const handlers: Record<string, Converter> = {
  boolean: leaf("bool"),
  number: leaf("f64"),
  integer: leaf("i64"),
  int8: leaf("i8"),
  int16: leaf("i16"),
  int32: leaf("i32"),
  int64: leaf("i64"),
  uint8: leaf("u8"),
  uint16: leaf("u16"),
  uint32: leaf("u32"),
  uint64: leaf("u64"),
  float32: leaf("f32"),
  float64: leaf("f64"),
  string: leaf("String"),
  uuid: leaf("String"),
  uri: leaf("String"),
  email: leaf("String"),
  datetime: leaf("String"),
  date: leaf("String"),
  time: leaf("String"),
  duration: leaf("String"),
  bytes: leaf("Vec<u8>"),
  null: leaf("()"),
  void: leaf("()"),
  unknown: leaf("serde_json::Value"),
  never: leaf("std::convert::Infallible"),
  // A class instance carries only nominal identity (className/source), never
  // fields (see type-ir's TypeKinds.instance doc comment) — referenced by
  // className, trusting a struct of that name is declared/imported elsewhere.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return `Vec<${toRustType(s.element)}>`
  },
  // No streaming construct in a plain data type — materializes to Vec<T>,
  // same honest-degrade convention protobuf.ts/flatbuffers.ts use.
  stream: (shape) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `Vec<${toRustType(s.element)}>`
  },
  page: (shape) => {
    const s = shape as TypeShape & { kind: "page" }
    return `Vec<${toRustType(s.element)}>`
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return `(${s.elements.map(toRustType).join(", ")})`
  },
  // Default to HashMap<K, V>; a map TypeRef whose own `meta.ordered` is true
  // (project convention — no prior art in this codebase to match, since no
  // existing projector distinguishes ordered/unordered maps) renders as
  // BTreeMap<K, V> instead.
  map: (shape, meta) => {
    const s = shape as TypeShape & { kind: "map" }
    const container = meta.ordered === true ? "BTreeMap" : "HashMap"
    return `${container}<${toRustType(s.key)}, ${toRustType(s.value)}>`
  },
  // No naming context here — see the `bareType`/`buildStruct` field-context
  // hoisting path below for the real (named) struct-generating case.
  object: (_shape, meta) => (typeof meta.typeName === "string" ? meta.typeName : "serde_json::Value"),
  enum: (shape, meta) => {
    const s = shape as TypeShape & { kind: "enum" }
    return typeof meta.enumName === "string" ? meta.enumName : `Enum${s.members.length}`
  },
  union: (_shape, meta) => (typeof meta.typeName === "string" ? meta.typeName : "serde_json::Value"),
  // Rust has no literal-type construct usable in a serde-derived struct field
  // (const generics don't cover strings/floats generally) — degrades to the
  // literal's base scalar type, same lossy convention protobuf.ts/flatbuffers.ts
  // use for their own literal handling.
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (s.value === null) return "()"
    if (typeof s.value === "string") return "String"
    if (typeof s.value === "boolean") return "bool"
    return Number.isInteger(s.value) ? "i64" : "f64"
  },
  ref: (shape) => (shape as TypeShape & { kind: "ref" }).target,
  // No struct-merge/mixin construct in Rust — lossy: falls back to the first
  // member's type, dropping the rest (same convention as protobuf.ts/flatbuffers.ts).
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    return first === undefined ? "serde_json::Value" : toRustType(first)
  },
  // Not serializable data — degrades honestly to serde_json::Value, same as
  // `unknown` above.
  function: leaf("serde_json::Value"),
  interface: leaf("serde_json::Value"),
}

/** Inline Rust type expression for `ref`, wrapping in `Option<T>` when
 * `meta.nullable` is set. Used for positions with no naming context of their
 * own (array elements, tuple slots, map keys/values) — see `bareType` for the
 * named-declaration-hoisting counterpart used inside struct fields / enum
 * variants. */
export function toRustType(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  const base = converter === undefined ? "serde_json::Value" : converter(ref.shape, ref.meta)
  return ref.meta.nullable === true ? `Option<${base}>` : base
}

/**
 * Field/variant-context inline type: same as `toRustType`, except `object`,
 * `enum`, and `union` (undiscriminated or discriminated) hoist a fresh named
 * declaration into `decls` under `nameHint` (PascalCase) instead of falling
 * back to a generic placeholder — mirroring flatbuffers.ts's `buildTable`
 * nested-field hoisting (FlatBuffers, like Rust, has no anonymous nested
 * struct/enum syntax). `Vec<object>`/`Vec<enum>`/`Vec<union>` hoist the
 * element type under the same name hint and wrap it in `Vec<...>`.
 */
function bareType(nameHint: string, ref: TypeRef, decls: string[]): string {
  const kind = ref.shape.kind
  if (isA(kind, "object")) {
    decls.push(buildStruct(nameHint, ref, decls))
    return nameHint
  }
  if (kind === "enum") {
    decls.push(buildEnum(nameHint, ref))
    return nameHint
  }
  if (kind === "union") {
    decls.push(
      typeof ref.meta.discriminator === "string"
        ? buildTaggedEnum(nameHint, ref, decls)
        : buildUntaggedEnum(nameHint, ref, decls),
    )
    return nameHint
  }
  if (kind === "array") {
    const s = ref.shape as TypeShape & { kind: "array" }
    const elementKind = s.element.shape.kind
    if (isA(elementKind, "object") || elementKind === "enum" || elementKind === "union") {
      return `Vec<${bareType(nameHint, s.element, decls)}>`
    }
    return `Vec<${toRustType(s.element)}>`
  }
  const converter = resolve(kind, handlers)
  return converter === undefined ? "serde_json::Value" : converter(ref.shape, ref.meta)
}

/** Field type + whether it needs `#[serde(skip_serializing_if = "Option::is_none")]`.
 * `meta.optional` (may be absent from the wire) and `meta.nullable` (present
 * but may carry JSON `null`) both map onto Rust's single `Option<T>` — Rust's
 * serde convention doesn't distinguish "missing key" from "explicit null" the
 * way the IR's two flags do, so both collapse onto one `Option` wrap rather
 * than `Option<Option<T>>`. */
function fieldType(fieldName: string, fieldRef: TypeRef, decls: string[]): { type: string; skip: boolean } {
  const bare = bareType(toPascalCase(fieldName), fieldRef, decls)
  const optional = fieldRef.meta.optional === true || fieldRef.meta.nullable === true
  return optional ? { type: `Option<${bare}>`, skip: true } : { type: bare, skip: false }
}

function docComment(indent: string, meta: Readonly<Record<string, unknown>>): string[] {
  return typeof meta.description === "string" ? [`${indent}/// ${meta.description}`] : []
}

const DERIVE = "#[derive(Debug, Clone, Serialize, Deserialize)]"

function buildStruct(name: string, ref: TypeRef, decls: string[]): string {
  const shape = ref.shape as TypeShape & { kind: "object" }
  const lines: string[] = [...docComment("", ref.meta)]
  if (ref.meta.deprecated === true) lines.push("#[deprecated]")
  lines.push(DERIVE, `pub struct ${name} {`)

  for (const [fieldName, fieldRef] of Object.entries(shape.fields)) {
    const rustName = toSnakeCase(fieldName)
    const { type, skip } = fieldType(fieldName, fieldRef, decls)
    lines.push(...docComment("    ", fieldRef.meta))
    if (rustName !== fieldName) lines.push(`    #[serde(rename = ${quote(fieldName)})]`)
    if (skip) lines.push('    #[serde(skip_serializing_if = "Option::is_none")]')
    if (fieldRef.meta.deprecated === true) lines.push("    #[deprecated]")
    lines.push(`    pub ${rustName}: ${type},`)
  }

  lines.push("}")
  return lines.join("\n")
}

function buildEnum(name: string, ref: TypeRef): string {
  const shape = ref.shape as TypeShape & { kind: "enum" }
  const lines: string[] = [...docComment("", ref.meta), DERIVE, `pub enum ${name} {`]

  for (const member of shape.members) {
    const variant = toPascalCase(member)
    if (variant !== member) lines.push(`    #[serde(rename = ${quote(member)})]`)
    lines.push(`    ${variant},`)
  }

  lines.push("}")
  return lines.join("\n")
}

// Internally-tagged enum (https://serde.rs/enum-representations.html#internally-tagged) —
// `#[serde(tag = "discriminator")]`. Each union variant is (per
// from-jtd.ts's/json-schema.ts's shared `meta.discriminator` convention) an
// `object` TypeRef whose discriminator field is a `literal` string tag; that
// literal's value becomes both the Rust variant name and its
// `#[serde(rename = ...)]`, and is excluded from the variant's own field list
// since serde synthesizes the tag from the variant selection itself, not from
// a real struct field.
function buildTaggedEnum(name: string, ref: TypeRef, decls: string[]): string {
  const shape = ref.shape as TypeShape & { kind: "union" }
  const discriminator = ref.meta.discriminator as string
  const lines: string[] = [
    ...docComment("", ref.meta),
    DERIVE,
    `#[serde(tag = ${quote(discriminator)})]`,
    `pub enum ${name} {`,
  ]

  shape.variants.forEach((variant, i) => {
    const variantShape = variant.shape as TypeShape & { kind: "object" }
    const tagField = variantShape.fields?.[discriminator]
    const tagValue =
      tagField !== undefined && tagField.shape.kind === "literal" && typeof (tagField.shape as { value: unknown }).value === "string"
        ? ((tagField.shape as { value: string }).value as string)
        : `Variant${i}`
    const variantName = toPascalCase(tagValue)
    const otherFields = Object.entries(variantShape.fields ?? {}).filter(([k]) => k !== discriminator)

    if (variantName !== tagValue) lines.push(`    #[serde(rename = ${quote(tagValue)})]`)
    if (otherFields.length === 0) {
      lines.push(`    ${variantName},`)
      return
    }
    lines.push(`    ${variantName} {`)
    for (const [fieldName, fieldRef] of otherFields) {
      const rustName = toSnakeCase(fieldName)
      const { type, skip } = fieldType(fieldName, fieldRef, decls)
      if (rustName !== fieldName) lines.push(`        #[serde(rename = ${quote(fieldName)})]`)
      if (skip) lines.push('        #[serde(skip_serializing_if = "Option::is_none")]')
      lines.push(`        ${rustName}: ${type},`)
    }
    lines.push("    },")
  })

  lines.push("}")
  return lines.join("\n")
}

// Untagged enum (https://serde.rs/enum-representations.html#untagged) — used
// for a plain union with no `meta.discriminator`. Each variant is a
// single-element tuple variant wrapping the member type; variant names are
// synthesized (`Variant0`, `Variant1`, ...) since a bare union carries no
// per-arm naming of its own.
function buildUntaggedEnum(name: string, ref: TypeRef, decls: string[]): string {
  const shape = ref.shape as TypeShape & { kind: "union" }
  const lines: string[] = [...docComment("", ref.meta), DERIVE, "#[serde(untagged)]", `pub enum ${name} {`]

  shape.variants.forEach((variant, i) => {
    const variantName = `Variant${i}`
    const type = bareType(`${name}${variantName}`, variant, decls)
    lines.push(`    ${variantName}(${type}),`)
  })

  lines.push("}")
  return lines.join("\n")
}

/**
 * Lower a `TypeRef` to idiomatic Rust source. With `name`, emits a named
 * top-level declaration — `struct` for `object`, `enum` for `enum`/`union`
 * (tagged when `meta.discriminator` is set, untagged otherwise), or a
 * `pub type` alias for anything else (primitives, `array`, `tuple`, `map`,
 * ...) — preceded by any struct/enum declarations hoisted out of nested
 * fields (Rust, like FlatBuffers, has no anonymous nested struct/enum
 * syntax; see `bareType`). Without `name`, returns just the inline type
 * expression for `ref` (`toRustType`) — the field-type building block other
 * projections (or a caller assembling its own struct) can plug into their
 * own declarations.
 */
export function toRust(ref: TypeRef, name?: string): string {
  if (name === undefined) return toRustType(ref)

  const decls: string[] = []
  const kind = ref.shape.kind
  let mainDecl: string
  if (isA(kind, "object")) {
    mainDecl = buildStruct(name, ref, decls)
  } else if (kind === "enum") {
    mainDecl = buildEnum(name, ref)
  } else if (kind === "union") {
    mainDecl =
      typeof ref.meta.discriminator === "string"
        ? buildTaggedEnum(name, ref, decls)
        : buildUntaggedEnum(name, ref, decls)
  } else {
    mainDecl = `pub type ${name} = ${toRustType(ref)};`
  }

  return [...decls, mainDecl].join("\n\n")
}
