import { resolve, type TypeRef, type TypeShape } from "./index.ts"
import { isA, quote } from "./codegen-helpers.ts"

// ============================================================================
// Elixir projector — TypeRef -> idiomatic Elixir 1.17+ struct/typespec source,
// with Jason (https://hexdocs.pm/jason) as the JSON-encoding library.
//
// Library choice: Elixir's own de facto standard for JSON has been the
// third-party `Jason` package for years; the stdlib `JSON` module added in
// 1.18 exists but hasn't displaced Jason as the ecosystem default the way,
// say, Go's `encoding/json` or Swift's `Codable` are unquestioned defaults —
// most real Elixir codebases and libraries still pull in Jason. This mirrors
// how this package's *other* "one clear default" languages were decided
// (Rust -> serde, Swift -> Codable: both picked for being the dominant
// ecosystem choice, not merely "in the stdlib") rather than the alternative
// bar Python set (`python-dataclass.ts` targets stdlib `dataclasses`, with
// Pydantic/attrs/msgspec as separate later variants) — Elixir has no
// stdlib-only serialization idiom worth targeting first the way Python's
// `dataclasses` module is a complete, self-sufficient default. Hence
// `elixir-jason.ts`, not a bare `elixir-native.ts`.
//
// Definition mechanism: plain `defstruct` + `@type t :: %__MODULE__{...}`
// Dialyzer-style typespecs — NOT `Ecto.Schema`. Every other struct-like
// projector in this package (`python-dataclass.ts`, `kotlin-kotlinx.ts`,
// `ruby-sorbet.ts`, `swift-codable.ts`, …) defaults to the plain
// language-level struct/class idiom, reserving ORM-specific mechanisms
// (Django models, ActiveRecord) for a variant nobody has actually asked for
// yet — Ecto.Schema is Elixir's ORM-flavored equivalent of Django models,
// so the same reasoning excludes it from the *default* projector.
//
// Scope: encode-only. `@derive Jason.Encoder` gives correct, recursive
// encoding (a nested struct's own derived encoder is invoked automatically
// by Jason.Encode.value/2) — but Jason deliberately ships no counterpart
// decode-into-struct API (Jason.decode!/2 only ever produces plain maps).
// Emitting a hand-rolled `from_json` here would either be wrong for nested
// structs (a shallow `struct(__MODULE__, map)` doesn't recurse) or would
// require materially more codegen than any sibling projector's scope (Python
// dataclasses/Kotlin data classes don't emit decode helpers either — only
// `ruby-sorbet.ts` does, and only because `T::Struct` already mixes in a
// genuinely-correct `from_hash`/`serialize` pair via `T::Props::Serializable`
// for its own `to_json`/`from_json` wrappers to call). No decode helper is
// emitted here for the same "don't emit code that pretends correctness it
// doesn't have" reason.
//
// Field-name fidelity over field-name idiom: struct fields keep the IR's own
// field name verbatim as the Elixir atom (`:firstName`, not `:first_name`)
// rather than converting to snake_case. This reads less idiomatically than
// typical hand-written Elixir, but `@derive Jason.Encoder` has no per-field
// rename option (unlike Rust's serde, whose derive macro supports
// `#[serde(rename = "...")]` natively per field — see `rust-serde.ts`) —
// achieving a rename would mean hand-writing a `defimpl Jason.Encoder`
// per struct, a materially larger and more error-prone generated-code
// surface than any other projector in this package emits for a cosmetic
// casing win. Preserving the wire name exactly, even at the cost of
// idiomatic casing, is the honest tradeoff. (Elixir atom literals accept
// arbitrary identifier characters when written `:"like-this"`, and even a
// literal casing mismatch like `:firstName` is syntactically legal — no
// escaping is needed beyond quoting when the name isn't bare-atom-shaped.)
//
// Discriminated unions: Elixir has no native sum-type/sealed-hierarchy
// construct (unlike Kotlin's `sealed class` or Rust's `enum`). The idiomatic
// approximation used here is "struct per variant, named from its
// discriminant value, plus a bare typespec union of their `.t()` types"
// (`@type t :: Circle.t() | Square.t()`) — no separate wrapper struct, since
// Elixir typespecs support inline `|` unions directly in any type position
// (unlike Kotlin/Ruby, whose type systems require every union to have a
// declaration site). Unlike `kotlin-kotlinx.ts`'s sealed-class encoding
// (which drops the discriminant field from each variant, since
// `@SerialName` re-derives it structurally at the protocol level), the
// discriminant field is KEPT as an ordinary required field on each variant
// struct — Jason has no equivalent mechanism to reconstruct it from the
// module name, so dropping it would silently break the JSON wire shape.
// This matches `python-dataclass.ts`'s handling of the same case (which
// also keeps the discriminant field as a plain `Literal[...]`-typed field)
// rather than Kotlin's.
//
// Enums: Elixir has no native enum construct either — atoms + a typespec
// union of atom literals is the idiomatic approximation
// (`@type t :: :active | :inactive`), wrapped in its own `defmodule` so it
// has a `.t()` to be referenced by. Unlike Python's enum member names (which
// must sanitize into valid Python identifiers — see `python-dataclass.ts`'s
// `enumMemberName`), Elixir atom literals can carry the ORIGINAL member
// string byte-for-byte via `:"quoted form"` when it isn't already a bare
// identifier, so no sanitization/lookup table is needed here at all.
//
// Declaration-per-name convention: EVERY top-level/nested named TypeRef
// (not just object/enum, unlike `python-dataclass.ts`/`kotlin-kotlinx.ts`,
// which leave bare-alias-able kinds as a plain top-level `Name = expr`
// statement) gets wrapped in its own `defmodule Name do @type t :: expr end`
// — Elixir's `@type`/`@moduledoc` attributes are only legal inside a
// `defmodule` body, so there is no bare-top-level-statement option to fall
// back to the way Python's/Kotlin's host languages allow.
//
// Nested naming: a nested object/enum/union field is promoted to its own
// FLAT top-level module named from the field name alone (not dotted under
// its parent, e.g. `Address`, not `User.Address`) — same "capitalize the
// field/context name, dedupe via a `seen` set" convention
// `python-dataclass.ts`/`kotlin-kotlinx.ts` use for their own nested
// declarations, accepting the same same-field-name-collision-across-parents
// risk they do, rather than inventing Elixir-specific dotted-module nesting
// this package's precedent doesn't otherwise establish.
// ============================================================================

type FieldDecl = {
  name: string
  type: string
  optional: boolean
  comment?: string
  deprecated?: boolean
}

type Decl =
  | { kind: "struct"; name: string; fields: FieldDecl[]; docstring?: string; deprecated?: string | true }
  | { kind: "atoms"; name: string; members: readonly string[]; docstring?: string }
  | { kind: "alias"; name: string; type: string; docstring?: string }

interface Ctx {
  decls: Decl[]
  // Module names already emitted as a top-level `defmodule` — guards
  // against re-emitting the same nested type twice and against infinite
  // recursion for a directly self-referential object graph (mirrors
  // `python-dataclass.ts`'s `ctx.seen`; `ref`/named declarations are the
  // normal way to express recursion instead — see the `ref` handler below).
  seen: Set<string>
}

type Converter = (shape: TypeShape, ref: TypeRef, ctxName: string, ctx: Ctx) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

// A valid BARE Elixir atom/identifier: lowercase-or-underscore leading
// character, alphanumerics/underscores after, optional trailing `?`/`!`.
// Anything else needs the `:"quoted"` atom form (field names) or the
// `"quoted": value` keyword form (map/struct keys) instead.
function isBareAtomIdentifier(value: string): boolean {
  return /^[a-z_][a-zA-Z0-9_]*[?!]?$/.test(value)
}

// The `key` half of a `key: value` map/keyword/struct-field entry —
// unquoted when `name` is already a legal bare atom, else the quoted-atom
// keyword form Elixir accepts directly in that position (e.g. `"Content-Type": v`).
function fieldKey(name: string): string {
  return isBareAtomIdentifier(name) ? name : quote(name)
}

// A standalone atom literal (e.g. for `@enforce_keys`/`defstruct`'s
// no-default entries, and for enum members) — `:name` when bare, `:"name"`
// otherwise.
function atomLiteral(value: string): string {
  return isBareAtomIdentifier(value) ? `:${value}` : `:${quote(value)}`
}

// Sanitizes an arbitrary field/context name into a legal Elixir module alias
// (PascalCase, starts with an uppercase ASCII letter). Non-identifier runs
// (spaces, dashes, etc.) become word boundaries, same "split on non-alnum,
// capitalize each piece" shape as other projectors' identifier sanitizers
// (e.g. `rust-serde.ts`'s `toSnakeCase`), just producing PascalCase instead
// of snake_case since Elixir module aliases require an uppercase start.
function moduleName(name: string): string {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter((part) => part.length > 0)
  const pascal = parts.map((part) => part[0]!.toUpperCase() + part.slice(1)).join("")
  if (pascal.length === 0) return "Anonymous"
  return /^[0-9]/.test(pascal) ? `Type${pascal}` : pascal
}

// True when `variant` is an object carrying a literal-string value for
// `discriminator` — same "does this union variant assert a fixed tag value"
// check `kotlin-kotlinx.ts`'s `discriminantValue` performs for its own
// sealed-class encoding.
function discriminantValue(variant: TypeRef, discriminator: string): string | undefined {
  if (!isA(variant.shape.kind, "object")) return undefined
  const field = (variant.shape as TypeShape & { kind: "object" }).fields[discriminator]
  if (field === undefined || field.shape.kind !== "literal") return undefined
  const value = (field.shape as TypeShape & { kind: "literal" }).value
  return typeof value === "string" ? value : undefined
}

/** Declares (or reuses) a `defmodule <rawName> do ... end` struct for an
 * `object`-kind TypeRef — shared by the plain `object` handler and by
 * discriminated-union variant declaration (which needs to name each variant
 * from its discriminant tag rather than from field/array context). */
function declareStruct(rawName: string, ref: TypeRef, ctx: Ctx): string {
  const shape = ref.shape as TypeShape & { kind: "object" }
  const name = moduleName(rawName)
  if (ctx.seen.has(name)) return `${name}.t()`
  ctx.seen.add(name)

  const required: FieldDecl[] = []
  const optional: FieldDecl[] = []
  for (const [fieldName, fieldRef] of Object.entries(shape.fields)) {
    const rawType = toElixirType(fieldRef, fieldName, ctx)
    const isOptional = fieldRef.meta.optional === true
    const isNullable = fieldRef.meta.nullable === true
    // `nullable` already appended `| nil` inside `toElixirType` — avoid
    // double-appending when the field is *also* omittable.
    const fieldType = isOptional && !isNullable ? `${rawType} | nil` : rawType
    const description = typeof fieldRef.meta.description === "string" ? fieldRef.meta.description : undefined
    const deprecated = fieldRef.meta.deprecated === true
    const decl: FieldDecl = { name: fieldName, type: fieldType, optional: isOptional }
    if (description !== undefined) decl.comment = description
    if (deprecated) decl.deprecated = true
    ;(isOptional ? optional : required).push(decl)
  }

  const docstring = typeof ref.meta.description === "string" ? ref.meta.description : undefined
  const deprecated =
    typeof ref.meta.deprecated === "string" ? ref.meta.deprecated : ref.meta.deprecated === true ? true : undefined
  const decl: Decl = { kind: "struct", name, fields: [...required, ...optional] }
  if (docstring !== undefined) decl.docstring = docstring
  if (deprecated !== undefined) decl.deprecated = deprecated
  ctx.decls.push(decl)
  return `${name}.t()`
}

const handlers: Record<string, Converter> = {
  boolean: leaf("boolean()"),
  number: leaf("float()"),
  integer: leaf("integer()"),
  string: leaf("String.t()"),
  null: leaf("nil"),
  // As a plain value type (not a function's own return position, which is
  // the only place Elixir has actual "no value" convention around `:ok`/
  // side-effecting functions) there's no dedicated Elixir construct — `nil`
  // is the closest honest analogue, mirroring Python's `void -> None`.
  void: leaf("nil"),
  unknown: leaf("any()"),
  never: leaf("no_return()"),
  // Fixed-width integers/floats have no narrower Elixir typespec than the
  // base numeric kinds — degrades to `integer()`/`float()`, same
  // honest-degrade `kotlin-kotlinx.ts` uses for its own numeric-width kinds
  // where the target type system doesn't distinguish widths either.
  int8: leaf("integer()"),
  int16: leaf("integer()"),
  int32: leaf("integer()"),
  int64: leaf("integer()"),
  uint8: leaf("integer()"),
  uint16: leaf("integer()"),
  uint32: leaf("integer()"),
  uint64: leaf("integer()"),
  float32: leaf("float()"),
  float64: leaf("float()"),
  // No native uuid/uri/email typespec constructs — honest degrade to
  // `String.t()`, same convention `ruby-sorbet.ts`'s RBS mode and
  // `kotlin-kotlinx.ts` use for these semantic string subtypes.
  uuid: leaf("String.t()"),
  uri: leaf("String.t()"),
  email: leaf("String.t()"),
  // Elixir's stdlib Calendar types are genuine native equivalents (unlike
  // e.g. Kotlin, which needs the external kotlinx-datetime package for
  // `Instant`/`LocalDate`) — `DateTime`/`Date`/`Time` are all in Elixir's
  // own Kernel/stdlib.
  datetime: leaf("DateTime.t()"),
  date: leaf("Date.t()"),
  time: leaf("Time.t()"),
  // `Duration` is a stdlib calendar-duration struct as of Elixir 1.17
  // (https://hexdocs.pm/elixir/Duration.html) — a genuine native type,
  // unlike most other projectors' `duration -> String`/opaque-string
  // fallback (e.g. `kotlin-kotlinx.ts`'s `time` fallback, which has no
  // equivalent stdlib construct to reach for).
  duration: leaf("Duration.t()"),
  bytes: leaf("binary()"),
  object: (_shape, ref, ctxName, ctx) => declareStruct(ctxName, ref, ctx),
  // A class instance carries only nominal identity (className/source), never
  // structure (see type-ir's TypeKinds.instance doc comment) — renders as a
  // bare module reference; the caller assembling this generated source is
  // responsible for `className` already being a resolvable Elixir alias.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "array" }
    return `list(${toElixirType(s.element, ctxName, ctx)})`
  },
  tuple: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "tuple" }
    const parts = s.elements.map((element, i) => toElixirType(element, `${ctxName}${i + 1}`, ctx))
    return `{${parts.join(", ")}}`
  },
  // No native async-stream construct — `Enumerable.t()` (the protocol every
  // lazy/eager collection implements) is the closest broad analogue, same
  // honest-degrade reasoning `ruby-sorbet.ts` uses for its own `Enumerator`
  // stream fallback.
  stream: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `Enumerable.t(${toElixirType(s.element, ctxName, ctx)})`
  },
  // No native pagination construct — degrades to the element list, same
  // convention every other structural projector in this package uses.
  page: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "page" }
    return `list(${toElixirType(s.element, ctxName, ctx)})`
  },
  map: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "map" }
    const key = toElixirType(s.key, `${ctxName}Key`, ctx)
    const value = toElixirType(s.value, `${ctxName}Value`, ctx)
    return `%{${key} => ${value}}`
  },
  union: (shape, ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "union" }
    if (s.variants.length === 0) return "any()"
    const discriminator = typeof ref.meta.discriminator === "string" ? ref.meta.discriminator : undefined
    const allObjects = s.variants.every((variant) => isA(variant.shape.kind, "object"))
    if (discriminator !== undefined && allObjects) {
      const parts = s.variants.map((variant, i) => {
        const tag = discriminantValue(variant, discriminator)
        const variantName = tag !== undefined ? tag : `Variant${i + 1}`
        return declareStruct(variantName, variant, ctx)
      })
      return [...new Set(parts)].join(" | ")
    }
    // Elixir typespecs support inline `|` unions directly in any type
    // position (field, list element, …) — unlike Kotlin/Ruby, whose type
    // systems require a named declaration site for a value with more than
    // one possible shape, a non-discriminated union here needs no promoted
    // wrapper module of its own; only object/enum VARIANTS still need one
    // (handled recursively by their own handlers below).
    const parts = s.variants.map((variant, i) => toElixirType(variant, `${ctxName}Variant${i + 1}`, ctx))
    return [...new Set(parts)].join(" | ")
  },
  // No literal-value typespec for strings (Erlang/Elixir's type system has
  // no string-singleton type the way TS/Python's `Literal[...]` do) —
  // degrades to `String.t()`. Integers, atoms (`nil`/booleans) DO have
  // native literal-typespec forms, so those render exactly.
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (s.value === null) return "nil"
    if (typeof s.value === "string") return "String.t()"
    if (typeof s.value === "boolean") return s.value ? "true" : "false"
    return Number.isInteger(s.value) ? String(s.value) : "float()"
  },
  enum: (shape, ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "enum" }
    const name = moduleName(ctxName)
    if (ctx.seen.has(name)) return `${name}.t()`
    ctx.seen.add(name)
    const docstring = typeof ref.meta.description === "string" ? ref.meta.description : undefined
    const decl: Decl = { kind: "atoms", name, members: s.members }
    if (docstring !== undefined) decl.docstring = docstring
    ctx.decls.push(decl)
    return `${name}.t()`
  },
  ref: (shape) => `${(shape as TypeShape & { kind: "ref" }).target}.t()`,
  // No intersection construct in Elixir's type vocabulary; when every member
  // is an object, the honest rendering merges their fields into one struct
  // (mirrors what an intersection of object shapes actually means
  // structurally) — same convention `python-dataclass.ts`'s intersection
  // handler uses — otherwise degrades to `any()`.
  intersection: (shape, ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "intersection" }
    if (s.members.length > 0 && s.members.every((member) => isA(member.shape.kind, "object"))) {
      const merged: Record<string, TypeRef> = {}
      for (const member of s.members) {
        Object.assign(merged, (member.shape as TypeShape & { kind: "object" }).fields)
      }
      const mergedRef: TypeRef = { shape: { kind: "object", fields: merged }, meta: ref.meta }
      return declareStruct(ctxName, mergedRef, ctx)
    }
    return "any()"
  },
  // https://hexdocs.pm/elixir/typespecs.html#anonymous-functions — Elixir's
  // `(params -> return)` anonymous-function typespec form. `thisType` has
  // no representation (Elixir functions don't rebind an implicit `self`),
  // so it's dropped, same as `ruby-sorbet.ts`'s `T.proc` handler.
  function: (shape, _ref, ctxName, ctx) => {
    const s = shape as TypeShape & { kind: "function" }
    const params = s.params.map((p, i) => toElixirType(p.type, `${ctxName}Param${i + 1}`, ctx))
    const returnType = toElixirType(s.returnType, `${ctxName}Return`, ctx)
    return params.length === 0 ? `(-> ${returnType})` : `(${params.join(", ")} -> ${returnType})`
  },
  // `method` has no explicit entry — falls back to `function`'s `(... -> ...)`
  // rendering via `registerParent("method", "function")` (index.ts), same as
  // `kotlin-kotlinx.ts`'s standalone-method fallback.
  //
  // A service surface (`interface`) has no Elixir field-position value type
  // of its own (a behaviour/protocol is a module-level contract, not a
  // struct field's type) — degrades to `any()`, same convention
  // `ruby-sorbet.ts`'s `interface -> T.untyped` handler uses.
  interface: leaf("any()"),
}

/** Convert a `TypeRef` to an Elixir type EXPRESSION (e.g. `list(String.t())`,
 * `integer() | nil`, or a `<Module>.t()` reference for object/enum/
 * discriminated-union-variant shapes) — the building block `toElixir` uses
 * for the module-level render. `ctxName` seeds any nested module this call
 * needs to declare (sanitized via `moduleName`); side effects (new `Decl`s)
 * land on `ctx`. */
export function toElixirType(ref: TypeRef, ctxName: string, ctx: Ctx): string {
  const converter = resolve(ref.shape.kind, handlers)
  let type = converter === undefined ? "any()" : converter(ref.shape, ref, ctxName, ctx)
  if (ref.meta.nullable === true && !type.split(" | ").includes("nil")) {
    type = `${type} | nil`
  }
  return type
}

function renderDecl(decl: Decl): string {
  const lines: string[] = [`defmodule ${decl.name} do`]
  if (decl.kind !== "alias" || decl.docstring !== undefined) {
    if (decl.docstring !== undefined) lines.push(`  @moduledoc ${quote(decl.docstring)}`)
  }

  if (decl.kind === "struct") {
    if (decl.deprecated !== undefined) {
      lines.push(`  # Deprecated${decl.deprecated === true ? "" : `: ${decl.deprecated}`}`)
    }
    const required = decl.fields.filter((f) => !f.optional)
    const optional = decl.fields.filter((f) => f.optional)
    if (required.length > 0) {
      lines.push(`  @enforce_keys [${required.map((f) => atomLiteral(f.name)).join(", ")}]`)
    }
    lines.push("  @derive Jason.Encoder")
    const structEntries = [
      ...required.map((f) => atomLiteral(f.name)),
      ...optional.map((f) => `${fieldKey(f.name)}: nil`),
    ]
    lines.push(structEntries.length === 0 ? "  defstruct []" : `  defstruct [${structEntries.join(", ")}]`)
    lines.push("")
    if (decl.fields.length === 0) {
      lines.push("  @type t :: %__MODULE__{}")
    } else {
      lines.push("  @type t :: %__MODULE__{")
      const all = [...required, ...optional]
      all.forEach((f, i) => {
        if (f.comment !== undefined) lines.push(`    # ${f.comment}`)
        if (f.deprecated === true) lines.push("    # @deprecated")
        const comma = i === all.length - 1 ? "" : ","
        lines.push(`    ${fieldKey(f.name)}: ${f.type}${comma}`)
      })
      lines.push("  }")
    }
  } else if (decl.kind === "atoms") {
    const members = decl.members.length === 0 ? "atom()" : decl.members.map(atomLiteral).join(" | ")
    lines.push(`  @type t :: ${members}`)
  } else {
    lines.push(`  @type t :: ${decl.type}`)
  }

  lines.push("end")
  return lines.join("\n")
}

/**
 * Render a `TypeRef` as a standalone Elixir source file: every named
 * declaration (the root ref itself, plus every nested object/enum/
 * discriminated-union-variant it promotes along the way) becomes its own
 * `defmodule <Name> do @type t :: ... end` — a struct module (`defstruct` +
 * `@enforce_keys` + `@derive Jason.Encoder`) for object shapes, an atom-union
 * module for enum shapes, or a plain type-alias module otherwise. `name`
 * seeds the root module's name and the base for any nested module names
 * derived from it (default `"Root"`, matching this package's other
 * projectors' default root name).
 */
export function toElixir(ref: TypeRef, name = "Root"): string {
  const ctx: Ctx = { decls: [], seen: new Set() }
  const expr = toElixirType(ref, name, ctx)
  const wrapperName = moduleName(name)

  // Object/enum/discriminated-union shapes already emit their own
  // `defmodule <wrapperName>` (via the `seen`-guarded pushes above) — no
  // separate alias module needed. Everything else (primitives, arrays,
  // plain unions, refs, …) gets wrapped in one now, since Elixir's
  // `@type`/`@moduledoc` have no legal bare-top-level-statement form to fall
  // back to the way `python-dataclass.ts`/`kotlin-kotlinx.ts` can.
  const hasOwnDeclaration = expr === `${wrapperName}.t()` && ctx.decls.some((decl) => decl.name === wrapperName)
  if (!hasOwnDeclaration) {
    ctx.decls.push({ kind: "alias", name: wrapperName, type: expr })
  }

  return `${ctx.decls.map(renderDecl).join("\n\n")}\n`
}
