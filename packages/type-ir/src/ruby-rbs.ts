import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

// RBS (https://github.com/ruby/rbs, bundled with Ruby 3+) — Ruby's own type
// signature-file format. Unlike ruby-sorbet.ts's Sorbet mode (inline `sig`
// blocks living alongside the `.rb` source they describe), RBS lives in a
// SEPARATE `.rbs` file next to the Ruby source — it describes an existing
// class's shape, it does not define the class. This projector's top-level
// entry point (`toRbsFile`) therefore emits a full `.rbs`-file-shaped
// `class`/`type` declaration set, the RBS analogue of what ruby-sorbet.ts's
// `toRubyClass`/`toRuby` do for `.rb` source.
//
// Divergences from ruby-sorbet.ts's RBS-type-expression helpers
// (`toRbsType`/`coreRbsType`, which this file duplicates rather than
// imports — see the note below `toRbsType`):
//
//   - `class` declarations here carry BOTH the read accessors ruby-sorbet.ts
//     already emits AND a `def initialize: (...) -> void` signature — a real
//     `.rbs` file describes a class's full public interface, not just its
//     attribute readers, and `initialize`'s keyword-argument signature is
//     how RBS expresses "this attribute is required vs. has a default"
//     (there's no default-value syntax in RBS itself — defaults are a
//     runtime-`.rb` concern, invisible to the signature file).
//   - Nested `object` fields promote to their own sibling `class`
//     declarations (named `<ClassName><Capitalized field name>`, same
//     synthesis convention as ruby-sorbet.ts's `structField`) rather than
//     degrading inline to `Hash[Symbol, untyped]` the way
//     ruby-sorbet.ts's bare `toRbsClass` does — a real `.rbs` file has
//     nowhere else to put a nested class's signature, so (unlike
//     ruby-sorbet.ts's simpler single-class `toRbsClass`, which is only ever
//     asked to describe one flat class at a time) this file's `toRbsFile`
//     walks the whole object graph the way ruby-sorbet.ts's Sorbet mode
//     does.
//   - `enum` promotes to an RBS `type <name> = "a" | "b" | ...` alias
//     declaration (RBS has no native enum construct — a plain literal-union
//     type alias is the closest fit, https://github.com/ruby/rbs/blob/master/docs/syntax.md#type-syntax)
//     rather than being inlined at every use site.
//   - Discriminated unions (`meta.discriminator`): RBS has no native
//     discriminated-union construct either — degrades to a plain `|` union
//     with a comment, same honest-degrade convention python-attrs.ts uses,
//     naming pattern matching on the discriminant field as the idiomatic
//     Ruby-level escape hatch (RBS itself has no dispatch syntax to point
//     at — dispatch is a `.rb`-source concern).
//
// Everything else (scalar mapping, collections, union/nilable rendering,
// literal types, function `^(...) -> R` syntax) is IDENTICAL to
// ruby-sorbet.ts's RBS mode — RBS's own type-expression grammar doesn't
// change based on which projector emits it.

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target)
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1)
}

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

// ============================================================================
// RBS type-expression grammar — identical to ruby-sorbet.ts's `rbsHandlers`/
// `coreRbsType`/`toRbsType`. Duplicated (not imported) so this file's
// `class`-graph walk (which needs its own `Ctx`-threading `object`/`enum`
// promotion, absent from ruby-sorbet.ts's flat single-class `toRbsClass`)
// can call back into it without ruby-sorbet.ts needing to know about this
// file's promotion convention.
// ============================================================================

const handlers: Record<string, Converter> = {
  boolean: leaf("bool"),
  number: leaf("Float"),
  integer: leaf("Integer"),
  string: leaf("String"),
  datetime: leaf("Time"),
  date: leaf("Time"),
  bytes: leaf("String"),
  null: leaf("nil"),
  void: leaf("void"),
  unknown: leaf("untyped"),
  never: leaf("bot"),
  object: () => "Hash[Symbol, untyped]",
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape) => `Array[${toRbsType((shape as TypeShape & { kind: "array" }).element)}]`,
  tuple: (shape) => `[${(shape as TypeShape & { kind: "tuple" }).elements.map(toRbsType).join(", ")}]`,
  stream: (shape) => `Enumerator[${toRbsType((shape as TypeShape & { kind: "stream" }).element)}]`,
  page: (shape) => `Array[${toRbsType((shape as TypeShape & { kind: "page" }).element)}]`,
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return `Hash[${toRbsType(s.key)}, ${toRbsType(s.value)}]`
  },
  union: (shape) => {
    const s = shape as TypeShape & { kind: "union" }
    if (s.variants.length === 2) {
      const nullIndex = s.variants.findIndex((v) => v.shape.kind === "null")
      if (nullIndex !== -1) {
        const other = s.variants[nullIndex === 0 ? 1 : 0]!
        return `${toRbsType(other)}?`
      }
    }
    return s.variants.map(toRbsType).join(" | ")
  },
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (s.value === null) return "nil"
    if (typeof s.value === "string") return quote(s.value)
    return String(s.value)
  },
  enum: (shape, meta) =>
    typeof meta.enumName === "string" ? meta.enumName : (shape as TypeShape & { kind: "enum" }).members.map(quote).join(" | "),
  ref: (shape) => (shape as TypeShape & { kind: "ref" }).target,
  intersection: (shape) => (shape as TypeShape & { kind: "intersection" }).members.map(toRbsType).join(" & "),
  function: (shape) => {
    const s = shape as TypeShape & { kind: "function" }
    const params = s.params.map((p) => `${toRbsType(p.type)} ${p.name}`)
    return `^(${params.join(", ")}) -> ${toRbsType(s.returnType)}`
  },
  interface: leaf("untyped"),
}

function coreRbsType(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  return converter === undefined ? "untyped" : converter(ref.shape, ref.meta)
}

/** An RBS type expression for `ref` — suitable for an `attr_reader`,
 * `initialize` parameter, or `type` alias body. */
export function toRbsType(ref: TypeRef): string {
  const core = coreRbsType(ref)
  return ref.meta.nullable === true ? `${core}?` : core
}

// ============================================================================
// Class/type-alias graph walk — the part specific to this file (RBS's own
// type-expression grammar above is identical to ruby-sorbet.ts's RBS mode).
// ============================================================================

interface Ctx {
  declarations: string[]
  declaredNames: Set<string>
}

/**
 * One `initialize` keyword parameter (`name: Type` for a required field,
 * `?name: Type` for an optional one — RBS's own required/optional keyword-arg
 * syntax, https://github.com/ruby/rbs/blob/master/docs/syntax.md#method-types) —
 * and the matching `attr_reader` line, for a single object field. Nested
 * `object`/`enum` fields (and arrays of either) synthesize a sibling
 * declaration named `<className><Capitalized field name>`, the same
 * promotion convention ruby-sorbet.ts's `structField` uses for Sorbet
 * `T::Struct`s.
 */
function classField(
  className: string,
  fieldName: string,
  fieldRef: TypeRef,
  ctx: Ctx,
): { attrLine: string; initParam: string } {
  let core: string
  if (isA(fieldRef.shape.kind, "object")) {
    const nestedName = `${className}${capitalize(fieldName)}`
    core = emitClass(nestedName, fieldRef, ctx)
  } else if (fieldRef.shape.kind === "enum") {
    const nestedName = `${className}${capitalize(fieldName)}`
    core = emitEnumAlias(nestedName, fieldRef, ctx)
  } else if (fieldRef.shape.kind === "array" && isA((fieldRef.shape as TypeShape & { kind: "array" }).element.shape.kind, "object")) {
    const element = (fieldRef.shape as TypeShape & { kind: "array" }).element
    const nestedName = `${className}${capitalize(fieldName)}`
    core = `Array[${emitClass(nestedName, element, ctx)}]`
  } else if (fieldRef.shape.kind === "array" && (fieldRef.shape as TypeShape & { kind: "array" }).element.shape.kind === "enum") {
    const element = (fieldRef.shape as TypeShape & { kind: "array" }).element
    const nestedName = `${className}${capitalize(fieldName)}`
    core = `Array[${emitEnumAlias(nestedName, element, ctx)}]`
  } else {
    core = coreRbsType(fieldRef)
  }

  const optional = fieldRef.meta.optional === true
  const nullable = fieldRef.meta.nullable === true
  const type = nullable ? `${core}?` : core
  const attrLine = `  attr_reader ${fieldName}: ${type}`
  const initParam = `${optional ? "?" : ""}${fieldName}: ${type}`
  return { attrLine, initParam }
}

/**
 * Emit a full `.rbs` `class` declaration: one `attr_reader` per field plus a
 * `def initialize: (...) -> void` keyword-argument signature — RBS's way of
 * expressing which attributes are required vs. optional (no default-value
 * syntax exists in RBS itself, see the file-header comment).
 */
export function emitClass(name: string, ref: TypeRef, ctx: Ctx): string {
  if (ctx.declaredNames.has(name)) return name
  ctx.declaredNames.add(name)

  const shape = ref.shape as TypeShape & { kind: "object" }
  const attrLines: string[] = []
  const initParams: string[] = []

  for (const [fieldName, fieldRef] of Object.entries(shape.fields)) {
    const { attrLine, initParam } = classField(name, fieldName, fieldRef, ctx)
    attrLines.push(attrLine)
    initParams.push(initParam)
  }

  const lines: string[] = []
  if (typeof ref.meta.description === "string") lines.push(`# ${ref.meta.description}`)
  if (ref.meta.deprecated === true) lines.push(`# @deprecated`)
  lines.push(`class ${name}`)
  lines.push(`  def initialize: (${initParams.length > 0 ? `${initParams.join(", ")}` : ""}) -> void`)
  lines.push(...attrLines)
  lines.push("end")

  ctx.declarations.push(lines.join("\n"))
  return name
}

/**
 * Emit an RBS `type` alias for an `enum` TypeRef — a plain literal-value
 * union, since RBS has no dedicated enum construct
 * (https://github.com/ruby/rbs/blob/master/docs/syntax.md#type-syntax).
 */
export function emitEnumAlias(name: string, ref: TypeRef, ctx: Ctx): string {
  if (ctx.declaredNames.has(name)) return name
  ctx.declaredNames.add(name)

  const shape = ref.shape as TypeShape & { kind: "enum" }
  const members = shape.members.map(quote).join(" | ")
  const lines: string[] = []
  if (typeof ref.meta.description === "string") lines.push(`# ${ref.meta.description}`)
  lines.push(`type ${name} = ${members}`)

  ctx.declarations.push(lines.join("\n"))
  return name
}

const discriminatorComment = (propertyName: string): string =>
  `  # discriminated by ${quote(propertyName)} — RBS has no native discriminated-union support;` +
  ` dispatch on this field with a Ruby-level \`case\`/pattern match at the call site`

/**
 * Top-level entry point: render `ref` as the full contents of a `.rbs`
 * signature file. An `object` TypeRef (given a `name`) walks its field graph
 * into one `class` declaration per object/enum encountered (promoting nested
 * shapes the same way `classField` does); an `enum` TypeRef becomes a single
 * `type` alias; anything else becomes a bare `type <name> = <expr>` alias
 * over the RBS type-expression grammar above.
 */
export function toRbsFile(ref: TypeRef, name = "Root"): string {
  const ctx: Ctx = { declarations: [], declaredNames: new Set() }

  if (ref.shape.kind === "object") {
    emitClass(name, ref, ctx)
  } else if (ref.shape.kind === "enum") {
    emitEnumAlias(name, ref, ctx)
  } else {
    const expr = toRbsType(ref)
    const comment =
      ref.shape.kind === "union" && typeof ref.meta.discriminator === "string" ? discriminatorComment(ref.meta.discriminator) : ""
    ctx.declarations.push(`type ${name} = ${expr}${comment}`)
  }

  return `${ctx.declarations.join("\n\n")}\n`
}
