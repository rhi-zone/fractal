import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

// Crystal (https://crystal-lang.org/reference/) output projector.
//
// Crystal has no anonymous/structural object type — every `object` or `enum`
// TypeRef needs a NAME to become a `class`/`enum` declaration, same
// name-dependency `capnp.ts`'s `struct` has (see that file's `object` handler
// doc comment). `toCrystal(ref, name?)` is the entry point: given a name, an
// `object`/`enum` TypeRef renders a full declaration (nested `object`/`enum`
// fields render as their own sibling declarations, named
// `${OuterName}${CapitalizedFieldName}`, flat rather than lexically nested —
// Crystal supports lexical nesting via `class Outer; class Inner; end; end`
// referenced as `Outer::Inner`, but flat siblings avoid that indentation/
// qualified-name bookkeeping for the same referential outcome). Without a
// name (or for any other kind), it degrades to the inline type expression via
// `toCrystalType` — the same fallback capnp's generic `object` handler uses
// (`meta.structName` if the caller supplied one, else an honest opaque
// degrade), since Crystal simply has no way to spell an anonymous struct
// inline.

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

function quote(value: string): string {
  return JSON.stringify(value)
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1)
}

// camelCase (the assumed JSON-wire convention) -> snake_case (Crystal's own
// property-naming convention, https://crystal-lang.org/reference/conventions/coding_style.html).
function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
}

// Crystal enum members are conventionally PascalCase constants
// (https://crystal-lang.org/reference/syntax_and_semantics/enum.html) —
// capitalize whatever the IR's raw member string is, leaving the rest as-is
// (assumes an already-valid identifier body; this projector doesn't attempt
// to sanitize arbitrary characters, same scope capnp.ts's enum handling has).
function toEnumMemberName(member: string): string {
  return capitalize(member)
}

// Wrap a Crystal type expression as nilable (`T?`) — Crystal's shorthand for
// `T | Nil` (https://crystal-lang.org/reference/syntax_and_semantics/union_types.html).
// A no-op if the type is already nilable (own `?` suffix, or a union that
// already spelled out `| Nil` explicitly — see the `union` handler below).
function nilable(type: string): string {
  if (type.endsWith("?") || type.includes(" | Nil")) return type
  return `${type}?`
}

function isObjectKind(kind: string): boolean {
  return kind === "object" || ancestors(kind).includes("object")
}

// Fixed-width/semantic/temporal kinds are optional extension modules
// (src/kinds/*) that augment TypeKinds via declaration merging — this
// projector names them directly as handler keys (same as typescript.ts and
// capnp.ts do) without importing those modules, since `resolve()` only needs
// the kind's string name to match, not its type.
const handlers: Record<string, Converter> = {
  boolean: leaf("Bool"),
  number: leaf("Float64"),
  integer: leaf("Int32"),
  int8: leaf("Int8"),
  int16: leaf("Int16"),
  int32: leaf("Int32"),
  int64: leaf("Int64"),
  uint8: leaf("UInt8"),
  uint16: leaf("UInt16"),
  uint32: leaf("UInt32"),
  uint64: leaf("UInt64"),
  float32: leaf("Float32"),
  float64: leaf("Float64"),
  string: leaf("String"),
  uuid: leaf("String"),
  uri: leaf("String"),
  email: leaf("String"),
  // datetime/date are the domain `Time` type (Crystal stdlib), not a wire
  // format — same "describes what a value IS" reasoning kinds/date-time.ts
  // documents for why these aren't subtypes of `string`.
  datetime: leaf("Time"),
  date: leaf("Time"),
  time: leaf("String"),
  // Crystal's stdlib `Time::Span` is an elapsed-duration type — the direct
  // analogue of the IR's `duration` domain kind.
  duration: leaf("Time::Span"),
  bytes: leaf("Bytes"),
  null: leaf("Nil"),
  void: leaf("Nil"),
  unknown: leaf("JSON::Any"),
  // Crystal has no bottom type usable in value position; `NoReturn` is the
  // closest stdlib construct (used for methods that never return) — an
  // honest degrade rather than a fabricated construct.
  never: leaf("NoReturn"),
  // Nested objects need field-name context to be named (see the module doc
  // comment) — `fieldDeclarations` below special-cases object-kind fields to
  // emit a properly named sibling class instead of falling through here.
  // Without that context (a bare `toCrystalType` call, or an object nested
  // inside e.g. a union/map where no field name exists), this degrades to
  // `meta.structName` if the caller supplied one, else an opaque `JSON::Any`
  // — Crystal has no anonymous-struct construct to fall back to.
  object: (_shape, meta) => (typeof meta.structName === "string" ? meta.structName : "JSON::Any"),
  // A class instance carries only nominal identity (className/source), never
  // fields (see type-ir's TypeKinds.instance doc comment) — rendered as a
  // bare reference to that class name, same convention typescript.ts's
  // `instance` handler uses (the caller assembling the emitted source is
  // responsible for the type actually being in scope).
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return `Array(${toCrystalType(s.element)})`
  },
  // No native async-iterable construct — degrades to the same `Array(T)`
  // encoding `array` uses above (same honest-degrade convention capnp.ts's
  // `stream` handler documents).
  stream: (shape) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `Array(${toCrystalType(s.element)})`
  },
  // No native pagination construct — degrades to `Array(T)` over the page's
  // element type, same reasoning as `stream` above.
  page: (shape) => {
    const s = shape as TypeShape & { kind: "page" }
    return `Array(${toCrystalType(s.element)})`
  },
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    return `Tuple(${s.elements.map(toCrystalType).join(", ")})`
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return `Hash(${toCrystalType(s.key)}, ${toCrystalType(s.value)})`
  },
  // Crystal union types (https://crystal-lang.org/reference/syntax_and_semantics/union_types.html):
  // `T1 | T2`. A `null` variant collapses to the `T?` nilable shorthand only
  // when it's the sole non-null variant — a multi-variant union alongside
  // `null` spells `Nil` out explicitly (`A | B | Nil`) rather than guessing
  // whether Crystal's `?` shorthand parses over a parenthesized union.
  union: (shape) => {
    const s = shape as TypeShape & { kind: "union" }
    const rendered = s.variants.map(toCrystalType)
    const nonNil = rendered.filter((r) => r !== "Nil")
    const hasNil = nonNil.length !== rendered.length
    if (!hasNil) return rendered.join(" | ")
    return nonNil.length === 1 ? nilable(nonNil[0]!) : `${nonNil.join(" | ")} | Nil`
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (s.value === null) return "Nil"
    if (typeof s.value === "boolean") return "Bool"
    if (typeof s.value === "string") return "String"
    return Number.isInteger(s.value) ? "Int32" : "Float64"
  },
  // Nested enums need field-name context to be named (same as `object`
  // above) — `fieldDeclarations` special-cases enum-kind fields to emit a
  // named sibling enum. Without that context, degrades to `meta.enumName`
  // if supplied, else the raw member strings as a `String` (an opaque
  // degrade — Crystal has no anonymous-enum/literal-union construct).
  enum: (_shape, meta) => (typeof meta.enumName === "string" ? meta.enumName : "String"),
  ref: (shape) => (shape as TypeShape & { kind: "ref" }).target,
  // No structural intersection/mixin construct — lossy: falls back to the
  // first member's type, dropping the rest (same degrade capnp.ts's
  // `intersection` handler documents).
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    return first === undefined ? "JSON::Any" : toCrystalType(first)
  },
  // Crystal's stdlib `Proc(*Args, Return)` is a first-class callable type —
  // the direct analogue of the IR's `function`/`method` kinds (`method`
  // falls back here via `registerParent("method", "function")` in index.ts,
  // same as every other projector in this package).
  function: (shape) => {
    const s = shape as TypeShape & { kind: "function" }
    const params = s.params.map((p) => toCrystalType(p.type))
    return `Proc(${[...params, toCrystalType(s.returnType)].join(", ")})`
  },
  // No construct for a bare method-surface value in field position (same
  // reasoning as capnp.ts's `interface` handler) — degrades to `JSON::Any`.
  interface: leaf("JSON::Any"),
}

/** Inline Crystal type expression for a `TypeRef` — the leaf-level converter
 * every declaration builder below composes with. */
export function toCrystalType(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  let type = converter === undefined ? "JSON::Any" : converter(ref.shape, ref.meta)
  return ref.meta.nullable === true ? nilable(type) : type
}

// Crystal doc comments (`#` immediately above a declaration — Crystal has no
// dedicated doc-comment keyword, https://crystal-lang.org/reference/syntax_and_semantics/documenting_code.html)
// driven by `meta.description`/`meta.deprecated`, same open-metadata-bag
// convention typescript.ts's `docComment` uses. Crystal's stdlib
// `@[Deprecated]` annotation (https://crystal-lang.org/api/Deprecated.html)
// is the idiomatic `@deprecated` equivalent.
function docComment(meta: Readonly<Record<string, unknown>>): string {
  const description = typeof meta.description === "string" ? meta.description : undefined
  const deprecated = meta.deprecated === true
  const lines: string[] = []
  if (description !== undefined) lines.push(`# ${description}`)
  if (deprecated) lines.push("@[Deprecated]")
  return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

type ObjectShape = TypeShape & { kind: "object" }
type EnumShape = TypeShape & { kind: "enum" }

/** One field's rendered lines (doc comment, `@[JSON::Field]` if the JSON key
 * differs from the snake_case property name, and the `property` line
 * itself) plus any sibling class/enum declarations a nested object/enum
 * field needed. */
function fieldLines(
  outerName: string,
  fieldName: string,
  fieldRef: TypeRef,
): { lines: string[]; nested: string[] } {
  const propName = toSnakeCase(fieldName)
  const nestedName = `${outerName}${capitalize(fieldName)}`
  const nested: string[] = []
  let fieldType: string

  if (isObjectKind(fieldRef.shape.kind)) {
    nested.push(renderClass(nestedName, fieldRef))
    fieldType = nestedName
  } else if (fieldRef.shape.kind === "enum") {
    nested.push(renderEnum(nestedName, fieldRef))
    fieldType = nestedName
  } else if (fieldRef.shape.kind === "array" && isObjectKind((fieldRef.shape as TypeShape & { kind: "array" }).element.shape.kind)) {
    const element = (fieldRef.shape as TypeShape & { kind: "array" }).element
    nested.push(renderClass(nestedName, element))
    fieldType = `Array(${nestedName})`
  } else if (fieldRef.shape.kind === "array" && (fieldRef.shape as TypeShape & { kind: "array" }).element.shape.kind === "enum") {
    const element = (fieldRef.shape as TypeShape & { kind: "array" }).element
    nested.push(renderEnum(nestedName, element))
    fieldType = `Array(${nestedName})`
  } else {
    fieldType = toCrystalType(fieldRef)
  }

  if (fieldRef.meta.optional === true || fieldRef.meta.nullable === true) fieldType = nilable(fieldType)

  const lines: string[] = []
  const description = typeof fieldRef.meta.description === "string" ? fieldRef.meta.description : undefined
  if (description !== undefined) lines.push(`  # ${description}`)
  if (fieldRef.meta.deprecated === true) lines.push("  @[Deprecated]")
  if (fieldName !== propName) lines.push(`  @[JSON::Field(key: ${quote(fieldName)})]`)
  lines.push(`  property ${propName} : ${fieldType}`)

  return { lines, nested }
}

/** Render an `object` TypeRef as a `class` declaration — `include
 * JSON::Serializable` plus one `property` per field, JSON key mapping via
 * `@[JSON::Field(key:)]` where the wire name (assumed camelCase) differs
 * from Crystal's own snake_case property-naming convention. Nested
 * object/enum fields render as sibling declarations ahead of the class that
 * references them (see the module doc comment for why flat-sibling rather
 * than lexically nested). */
export function renderClass(name: string, ref: TypeRef): string {
  const shape = ref.shape as ObjectShape
  const nested: string[] = []
  const fieldBlocks: string[] = []
  for (const [fieldName, fieldRef] of Object.entries(shape.fields)) {
    const { lines, nested: fieldNested } = fieldLines(name, fieldName, fieldRef)
    fieldBlocks.push(lines.join("\n"))
    nested.push(...fieldNested)
  }

  const body = [`class ${name}`, "  include JSON::Serializable", ...(fieldBlocks.length > 0 ? ["", ...fieldBlocks] : []), "end"]
  const classText = `${docComment(ref.meta)}${body.join("\n")}`
  return nested.length > 0 ? `${nested.join("\n\n")}\n\n${classText}` : classText
}

/** Render an `enum` TypeRef as a Crystal `enum` declaration — members
 * capitalized to Crystal's PascalCase constant convention. Crystal's stdlib
 * (de)serializes an `enum`'s member-name string automatically via
 * `JSON::Serializable`/`Enum#to_json`, so no `@[JSON::Field(converter:)]`
 * is needed for an enum-typed property. */
export function renderEnum(name: string, ref: TypeRef): string {
  const shape = ref.shape as EnumShape
  const members = shape.members.map((m) => `  ${toEnumMemberName(m)}`)
  return `${docComment(ref.meta)}enum ${name}\n${members.join("\n")}\nend`
}

/**
 * Convert a `TypeRef` to idiomatic Crystal. Given `name` and an `object`/
 * `enum`-kind (or `object`-descendant-kind) ref, renders a full `class`/
 * `enum` declaration. Otherwise (no name, or any other kind) degrades to
 * the inline type expression via `toCrystalType` — Crystal has no
 * anonymous-struct construct to declare without a name.
 */
export function toCrystal(ref: TypeRef, name?: string): string {
  if (name !== undefined) {
    if (isObjectKind(ref.shape.kind)) return renderClass(name, ref)
    if (ref.shape.kind === "enum") return renderEnum(name, ref)
  }
  return toCrystalType(ref)
}

/** One `toCrystal(ref, name)` declaration per registry entry, joined with
 * blank lines — the multi-type-registry counterpart to `toCrystal`, same
 * shape as `typescript.ts`'s `toTypeDeclarations`. */
export function toCrystalDeclarations(registry: Record<string, TypeRef>): string {
  return Object.entries(registry)
    .map(([name, ref]) => toCrystal(ref, name))
    .join("\n\n")
}
