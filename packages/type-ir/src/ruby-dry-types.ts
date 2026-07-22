import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

// Ruby/dry-types projector — a second Ruby target alongside ruby-sorbet.ts,
// but a different convention entirely: dry-types (https://dry-rb.org/gems/
// dry-types) is a *runtime* composable type system (coercion + constraints +
// validation), not a static-typing annotation layer like Sorbet. Where
// ruby-sorbet.ts emits `sig`-decorated `T::Struct`s that a separate static
// checker verifies, this projector emits `Dry::Struct` classes built from
// `Types::` constants — the types themselves coerce/validate values at
// construction time, with no external type-checker involved.
//
// Two output shapes mirror ruby-sorbet.ts's own split:
//   - `toDryType`: a bare `Types::` expression (e.g. `Types::String`,
//     `Types::Array.of(Types::Integer)`) — usable inline wherever a dry-types
//     type constant is expected (an `attribute` call, another combinator).
//   - `toDryStruct`/`toDryEnum`/`toDry`: named declarations — a `Dry::Struct`
//     class for `object` shapes, a `Name = Types::String.enum(...)` constant
//     binding for `enum` shapes (dry-types has no dedicated enum *class*
//     construct the way Sorbet has `T::Enum` — an enum is just a constrained
//     type, so the named form is a constant assignment, not a class).
//
// Same "honest degrade" convention as every other projector in this package
// (see typescript.ts, protobuf.ts, ruby-sorbet.ts): a shape dry-types has no
// native combinator for (callable, service surface, nominal class instance
// treated structurally) degrades to `Types::Any` rather than fabricating
// syntax dry-types doesn't have.
//
// Every generated file assumes a `Types` module already in scope, built via
// `include Dry.Types()` (https://dry-rb.org/gems/dry-types/main/getting-
// started/#basic-usage) — `dryTypesPreamble()` below is that boilerplate,
// exported so a caller assembling a full file emits it once rather than this
// projector re-emitting it per type.

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target)
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1)
}

/**
 * The `module Types; include Dry.Types(); end` boilerplate every generated
 * file's `Types::` references depend on
 * (https://dry-rb.org/gems/dry-types/main/getting-started/#basic-usage). A
 * caller assembling a full `.rb` file emits this once near the top, before
 * any `toDryStruct`/`toDryType` output — kept as a standalone export (not
 * auto-prepended by `toDryStruct` itself) since a file with several
 * generated structs only wants it once.
 */
export function dryTypesPreamble(): string {
  return ["require \"dry-types\"", "require \"dry-struct\"", "", "module Types", "  include Dry.Types()", "end"].join(
    "\n",
  )
}

// Render a `meta.default`/literal value (JSON-ish: string/number/boolean/
// null/array/object) as a Ruby literal expression. Strings get `.freeze`
// (Ruby string literals are otherwise mutable, and a shared frozen literal is
// the idiomatic default-value convention); arrays/hashes are NOT frozen here
// because `defaultClause` below wraps them in a `.default { ... }` block
// instead, so each struct instance gets its own object rather than one
// literal mutated across instances.
function rubyLiteral(value: unknown): string {
  if (value === null || value === undefined) return "nil"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return `${quote(value)}.freeze`
  if (Array.isArray(value)) return `[${value.map(rubyLiteral).join(", ")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    return `{ ${entries.map(([k, v]) => `${quote(k)}: ${rubyLiteral(v)}`).join(", ")} }`
  }
  return "nil"
}

// dry-types' `.default(...)` combinator takes a plain value for immutable
// scalars, but a mutable literal (array/hash) needs the block form —
// `.default { [...] }` — so each instantiation gets its own object instead of
// every instance sharing (and potentially mutating) the same literal.
function defaultClause(value: unknown): string {
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    return `.default { ${rubyLiteral(value)} }`
  }
  return `.default(${rubyLiteral(value)})`
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

const handlers: Record<string, Converter> = {
  boolean: leaf("Types::Bool"),
  number: leaf("Types::Float"),
  integer: leaf("Types::Integer"),
  string: leaf("Types::String"),
  // Same reasoning as ruby-sorbet.ts's datetime/date handlers: no native
  // calendar-only Date-vs-DateTime split matters here (see date-time.ts's doc
  // comment) — Ruby's `Time` covers the wall-clock instant either way.
  datetime: leaf("Types::Time"),
  date: leaf("Types::Time"),
  bytes: leaf("Types::String"),
  null: leaf("Types::Nil"),
  // `void`/`unknown` have no dedicated dry-types construct — both degrade to
  // the unconstrained `Types::Any`.
  void: leaf("Types::Any"),
  unknown: leaf("Types::Any"),
  // dry-types has no bottom/uninhabited type — `Types::Any` is the honest
  // (if imprecise) degrade, same as ruby-sorbet.ts falling back for anything
  // it can't express natively.
  never: leaf("Types::Any"),
  // No context (field name) is available here to name an anonymous nested
  // struct — `structField` below special-cases object-typed fields to emit a
  // properly named nested `Dry::Struct` instead of falling through to this
  // generic handler (same convention as ruby-sorbet.ts's `object` handler).
  object: () => "Types::Hash",
  // A class instance carries only nominal identity (className/source), never
  // fields (see type-ir's TypeKinds.instance doc comment) — renders as a bare
  // Ruby class reference wrapped in `Types.Instance(...)`
  // (https://dry-rb.org/gems/dry-types/main/instance-types/), dry-types'
  // dedicated combinator for "value must be an instance of this class."
  instance: (shape) => `Types.Instance(${(shape as TypeShape & { kind: "instance" }).className})`,
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return `Types::Array.of(${toDryType(s.element)})`
  },
  // dry-types has no native tuple combinator; a uniform tuple degrades to
  // `Types::Array.of(T)`, a heterogeneous one to an array of the unioned
  // element types (same lossy-but-honest degrade ruby-sorbet.ts uses for
  // tuples via `T::Array[T.any(...)]`).
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    const elementTypes = [...new Set(s.elements.map(toDryType))]
    const [first] = elementTypes
    return `Types::Array.of(${elementTypes.length <= 1 ? (first ?? "Types::Any") : elementTypes.join(" | ")})`
  },
  // No lazy/asynchronous-sequence combinator in dry-types (it models values,
  // not enumeration timing) — degrades to the materialized array form, same
  // honest-degrade reasoning as ruby-sorbet.ts's `T::Enumerator` choice picks
  // a *different* (but still lossy) Ruby analogue; here there's no runtime
  // constraint that can express "lazily produced," so array is the closest
  // dry-types can get.
  stream: (shape) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `Types::Array.of(${toDryType(s.element)})`
  },
  // No native pagination construct — degrades to the element array, same
  // convention as every other structural projector in this package.
  page: (shape) => {
    const s = shape as TypeShape & { kind: "page" }
    return `Types::Array.of(${toDryType(s.element)})`
  },
  // `Types::Hash.map(key_type, value_type)` is dry-types' homogeneous-map
  // combinator (dry-types >= 1.5) — every key must satisfy `key_type`, every
  // value `value_type`; distinct from `Types::Hash.schema(...)`, which
  // declares a FIXED set of named keys (that's `object`'s job here, not
  // `map`'s).
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return `Types::Hash.map(${toDryType(s.key)}, ${toDryType(s.value)})`
  },
  // A two-variant union with `null` collapses to dry-types' `.optional`
  // sugar (equivalent to `T | Types::Nil`) rather than the general `|`-chain
  // form — same sugar-when-possible convention ruby-sorbet.ts uses for
  // `T.nilable`.
  union: (shape) => {
    const s = shape as TypeShape & { kind: "union" }
    if (s.variants.length === 2) {
      const nullIndex = s.variants.findIndex((v) => v.shape.kind === "null")
      if (nullIndex !== -1) {
        const other = s.variants[nullIndex === 0 ? 1 : 0]!
        return `${toDryType(other)}.optional`
      }
    }
    // dry-types unions are built with the `|` operator
    // (https://dry-rb.org/gems/dry-types/main/sum/); parenthesized so the
    // expression composes safely as an argument or receiver of a further
    // combinator (e.g. `.optional`, `Types::Array.of(...)`).
    return `(${s.variants.map(toDryType).join(" | ")})`
  },
  // dry-types has no dedicated literal-value type — `.enum(value)`
  // constrains the base type down to that single value while keeping its
  // coercion behavior, the closest honest analogue.
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (s.value === null) return "Types::Nil"
    if (typeof s.value === "string") return `Types::String.enum(${quote(s.value)})`
    if (typeof s.value === "boolean") return `Types::Bool.enum(${s.value})`
    return Number.isInteger(s.value) ? `Types::Integer.enum(${s.value})` : `Types::Float.enum(${s.value})`
  },
  // `Types::String.enum(...)` is dry-types' native closed-set-of-values
  // combinator (https://dry-rb.org/gems/dry-types/main/enum/) — every enum
  // member in this IR is a string (see TypeKinds.enum), so no coercion type
  // parameter is needed the way ruby-sorbet.ts needs `meta.enumName` to name
  // a `T::Enum` class; the bare expression is already self-contained.
  enum: (shape) => `Types::String.enum(${(shape as TypeShape & { kind: "enum" }).members.map(quote).join(", ")})`,
  ref: (shape) => (shape as TypeShape & { kind: "ref" }).target,
  // dry-types has no intersection combinator (`&`-composing two type
  // constraints isn't part of its vocabulary the way `|` for unions is) —
  // degrades to `Types::Any`, same honest-degrade choice ruby-sorbet.ts's
  // `T.all` alternative doesn't need to make (Sorbet DOES have `T.all`) but
  // that dry-types genuinely has no analogue for.
  intersection: () => "Types::Any",
  // dry-types models data types, not callables — there's no proc/lambda type
  // combinator — degrades to `Types::Any`, same as ruby-sorbet.ts falls back
  // for shapes it can't express (there, `T.proc` IS available; here it isn't).
  function: () => "Types::Any",
  // A service surface (`interface`) has no dry-types value-type equivalent —
  // it's a method surface, not a value dry-types coerces/validates — degrades
  // honestly to `Types::Any`, same as ruby-sorbet.ts's `interface` handler.
  interface: leaf("Types::Any"),
}

function coreDryType(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  return converter === undefined ? "Types::Any" : converter(ref.shape, ref.meta)
}

/** A dry-types type expression for `ref` — suitable for an `attribute`
 * declaration, a `Types::Array.of(...)`/`Types::Hash.map(...)` argument, or
 * any other place a `Types::` constant is expected. */
export function toDryType(ref: TypeRef): string {
  const core = coreDryType(ref)
  return ref.meta.nullable === true ? `${core}.optional` : core
}

// attribute/const declaration for one Dry::Struct field, handling the
// nowhere-to-hang-a-name cases (nested `object`/`enum`, or an array of
// either) by synthesizing `<StructName><Capitalized field name>` — same
// convention ruby-sorbet.ts's `structField` and protobuf.ts's nested-message
// naming use — and collecting the synthesized declaration alongside it.
function structField(
  structName: string,
  fieldName: string,
  fieldRef: TypeRef,
): { declaration: string; nested: string[] } {
  const nested: string[] = []
  let core: string
  if (isA(fieldRef.shape.kind, "object")) {
    const nestedName = `${structName}${capitalize(fieldName)}`
    nested.push(toDryStruct(nestedName, fieldRef))
    core = nestedName
  } else if (fieldRef.shape.kind === "enum") {
    const nestedName = `${structName}${capitalize(fieldName)}Type`
    nested.push(toDryEnum(nestedName, fieldRef))
    core = nestedName
  } else if (
    fieldRef.shape.kind === "array" &&
    isA((fieldRef.shape as TypeShape & { kind: "array" }).element.shape.kind, "object")
  ) {
    const element = (fieldRef.shape as TypeShape & { kind: "array" }).element
    const nestedName = `${structName}${capitalize(fieldName)}`
    nested.push(toDryStruct(nestedName, element))
    core = `Types::Array.of(${nestedName})`
  } else if (
    fieldRef.shape.kind === "array" &&
    (fieldRef.shape as TypeShape & { kind: "array" }).element.shape.kind === "enum"
  ) {
    const element = (fieldRef.shape as TypeShape & { kind: "array" }).element
    const nestedName = `${structName}${capitalize(fieldName)}Type`
    nested.push(toDryEnum(nestedName, element))
    core = `Types::Array.of(${nestedName})`
  } else {
    core = coreDryType(fieldRef)
  }

  const optional = fieldRef.meta.optional === true
  const nullable = fieldRef.meta.nullable === true
  const hasDefault = fieldRef.meta.default !== undefined

  let type = nullable ? `${core}.optional` : core
  if (hasDefault) type = `${type}${defaultClause(fieldRef.meta.default)}`

  // `attribute?` is dry-struct's "this key may be omitted entirely" macro
  // (https://dry-rb.org/gems/dry-struct/main/#optional-attributes) —
  // distinct from `.optional` on the TYPE (which allows `nil` as a present
  // value). A field carrying a `.default(...)` doesn't need `attribute?`:
  // the default already covers the omitted-key case, so the plain
  // `attribute` macro is used (matching python-pydantic.ts's parallel
  // "explicit default subsumes optionality" reasoning).
  const macro = optional && !hasDefault ? "attribute?" : "attribute"
  const deprecatedComment = fieldRef.meta.deprecated === true ? " # @deprecated" : ""
  const description = typeof fieldRef.meta.description === "string" ? `  # ${fieldRef.meta.description}\n` : ""
  return {
    declaration: `${description}  ${macro} :${fieldName}, ${type}${deprecatedComment}`,
    nested,
  }
}

/**
 * Lower an `object` TypeRef to a named `Dry::Struct` class
 * (https://dry-rb.org/gems/dry-struct/main/) — dry-struct's typed data-class
 * convention. `transform_keys(&:to_sym)` is included so the struct accepts a
 * string-keyed Hash (e.g. `JSON.parse(json)`'s default output) directly,
 * without requiring the caller to symbolize keys first.
 */
export function toDryStruct(name: string, ref: TypeRef): string {
  const shape = ref.shape as TypeShape & { kind: "object" }
  const nestedDecls: string[] = []
  const fieldLines: string[] = []

  for (const [fieldName, fieldRef] of Object.entries(shape.fields)) {
    const { declaration, nested } = structField(name, fieldName, fieldRef)
    nestedDecls.push(...nested)
    fieldLines.push(declaration)
  }

  const lines: string[] = []
  if (typeof ref.meta.description === "string") lines.push(`# ${ref.meta.description}`)
  if (ref.meta.deprecated === true) lines.push("# @deprecated")
  lines.push(`class ${name} < Dry::Struct`)
  lines.push("  transform_keys(&:to_sym)")
  if (fieldLines.length > 0) {
    lines.push("")
    lines.push(...fieldLines)
  }
  lines.push("end")

  return [...nestedDecls, lines.join("\n")].join("\n\n")
}

/**
 * Lower an `enum` TypeRef to a named constant binding — dry-types has no
 * dedicated enum *class* the way Sorbet has `T::Enum`
 * (https://sorbet.org/docs/tenum); an enum is just a constrained `Types::`
 * value, so the named form is `Name = Types::String.enum(...)`, referenced by
 * name from a struct's `attribute` line the same way a `Dry::Struct` class
 * name is.
 */
export function toDryEnum(name: string, ref: TypeRef): string {
  const shape = ref.shape as TypeShape & { kind: "enum" }
  const lines: string[] = []
  if (typeof ref.meta.description === "string") lines.push(`# ${ref.meta.description}`)
  lines.push(`${name} = Types::String.enum(${shape.members.map(quote).join(", ")})`)
  return lines.join("\n")
}

/**
 * Top-level entry point: `object` and `enum` TypeRefs (given a `name`) lower
 * to a full `Dry::Struct` class declaration / enum constant binding;
 * anything else lowers to a `Name = <dry-types expression>` constant binding
 * when `name` is given, or a bare dry-types type expression (suitable for
 * inlining into an `attribute` declaration or another combinator) when it
 * isn't.
 */
export function toDry(ref: TypeRef, name?: string): string {
  if (name !== undefined) {
    if (ref.shape.kind === "object") return toDryStruct(name, ref)
    if (ref.shape.kind === "enum") return toDryEnum(name, ref)
    return `${name} = ${toDryType(ref)}`
  }
  return toDryType(ref)
}
