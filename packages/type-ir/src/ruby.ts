import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

// Ruby projector — two independent output modes:
//
//   - Sorbet (https://sorbet.org): `toRubyType`/`toRuby` emit `T::Struct`
//     classes with `sig`-decorated static type annotations (`T::Boolean`,
//     `T.nilable`, `T.any`, …) — the mainstream static-typing convention for
//     Ruby, and the one that can express this IR's richer shapes (nilable,
//     union, generic collections) without inventing new syntax.
//   - RBS (https://github.com/ruby/rbs, bundled with Ruby 3+): `toRbsType`/
//     `toRbsClass` emit the separate `.rbs` signature-file syntax. Kept as an
//     alternative rather than the default because RBS lives in a sibling
//     file next to the `.rb` source it describes, not inline — a caller
//     that wants RBS output picks these entry points explicitly.
//
// Both modes share the same "honest degrade" convention the rest of this
// package's projectors use (see typescript.ts, protobuf.ts): a shape neither
// Sorbet nor RBS can express natively (`interface`, a callable in field
// position, an unnamed nested `object`/`enum` with nowhere to hang a class
// name) degrades to `T.untyped`/`untyped` rather than fabricating syntax.

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target)
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1)
}

// T::Enum convention: constants are SCREAMING_SNAKE_CASE identifiers bound to
// `new(<serialized value>)` — the constant name need not match the
// serialized string (https://sorbet.org/docs/tenum), so any member value
// (including ones with spaces/punctuation) can round-trip through a legal
// Ruby constant name.
function enumConstantName(member: string): string {
  const upper = member.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  return upper.length === 0 ? "VALUE" : /^[0-9]/.test(upper) ? `_${upper}` : upper
}

// ============================================================================
// Sorbet mode
// ============================================================================

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

const handlers: Record<string, Converter> = {
  boolean: leaf("T::Boolean"),
  number: leaf("Float"),
  integer: leaf("Integer"),
  string: leaf("String"),
  // No native calendar-only Date-vs-DateTime split matters here (see
  // date-time.ts's doc comment on why datetime/date aren't string subtypes) —
  // Ruby's stdlib `Time` covers the wall-clock instant either way; a
  // consumer wanting the calendar-only `Date` class can override via meta.
  datetime: leaf("Time"),
  date: leaf("Time"),
  bytes: leaf("String"),
  null: leaf("NilClass"),
  // `void` only has native meaning in Sorbet's `sig { void }` return
  // position (see `methodSig` below); as a plain value type there's no
  // dedicated Ruby construct, so it degrades to `T.untyped` like `unknown`.
  void: leaf("T.untyped"),
  unknown: leaf("T.untyped"),
  never: leaf("T.noreturn"),
  // No context (field name) is available here to name an anonymous nested
  // struct — `toRubyClass` special-cases object-typed fields to emit a
  // properly named nested `T::Struct` instead of falling through to this
  // generic handler (same convention as protobuf.ts's `object` handler).
  object: () => "T::Hash[Symbol, T.untyped]",
  // A class instance carries only nominal identity (className/source), never
  // fields (see type-ir's TypeKinds.instance doc comment) — renders as a bare
  // Ruby class reference; the caller assembling this into a file is
  // responsible for `require`-ing `source` alongside it.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    return `T::Array[${toRubyType(s.element)}]`
  },
  // Sorbet has no native tuple type; a uniform tuple degrades to
  // `T::Array[T]`, a heterogeneous one to `T::Array[T.any(...)]` over its
  // distinct element types (same lossy-but-honest degrade protobuf.ts uses
  // for tuples).
  tuple: (shape) => {
    const s = shape as TypeShape & { kind: "tuple" }
    const elementTypes = [...new Set(s.elements.map(toRubyType))]
    const [first] = elementTypes
    return `T::Array[${elementTypes.length <= 1 ? (first ?? "T.untyped") : `T.any(${elementTypes.join(", ")})`}]`
  },
  // `Enumerator` is Ruby's closest native analogue to an asynchronously (or
  // lazily) produced sequence — there's no built-in async-iterable construct
  // to target 1:1, same honest-degrade reasoning as protobuf.ts's `stream`.
  stream: (shape) => {
    const s = shape as TypeShape & { kind: "stream" }
    return `T::Enumerator[${toRubyType(s.element)}]`
  },
  // No native pagination construct — degrades to the element array, same
  // convention as every other structural projector in this package.
  page: (shape) => {
    const s = shape as TypeShape & { kind: "page" }
    return `T::Array[${toRubyType(s.element)}]`
  },
  map: (shape) => {
    const s = shape as TypeShape & { kind: "map" }
    return `T::Hash[${toRubyType(s.key)}, ${toRubyType(s.value)}]`
  },
  // A two-variant union with `null` collapses to Sorbet's dedicated
  // `T.nilable(T)` sugar rather than the general `T.any(T, NilClass)` form.
  union: (shape) => {
    const s = shape as TypeShape & { kind: "union" }
    if (s.variants.length === 2) {
      const nullIndex = s.variants.findIndex((v) => v.shape.kind === "null")
      if (nullIndex !== -1) {
        const other = s.variants[nullIndex === 0 ? 1 : 0]!
        return `T.nilable(${toRubyType(other)})`
      }
    }
    return `T.any(${s.variants.map(toRubyType).join(", ")})`
  },
  // Sorbet has no literal-value type — degrades to the value's runtime class.
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (s.value === null) return "NilClass"
    if (typeof s.value === "string") return "String"
    if (typeof s.value === "boolean") return "T::Boolean"
    return Number.isInteger(s.value) ? "Integer" : "Float"
  },
  // Mirrors protobuf.ts's `enumName` meta convention: with nowhere (no field
  // name context) to synthesize a `T::Enum` class name, falls back to the
  // serialized representation's own class (`String`, since every enum
  // member in this IR is a string) rather than fabricating one.
  enum: (shape, meta) => (typeof meta.enumName === "string" ? meta.enumName : "String"),
  ref: (shape) => (shape as TypeShape & { kind: "ref" }).target,
  // Sorbet's `T.all` composes multiple types the same way TS's `&` does.
  intersection: (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    return `T.all(${s.members.map(toRubyType).join(", ")})`
  },
  // Sorbet's `T.proc` builder is the closest native callable-type construct
  // (https://sorbet.org/docs/procs); `thisType` has no representation in a
  // `T.proc` signature (Ruby procs don't rebind `self` the way TS's `this`
  // parameter does), so it's dropped rather than misrendered.
  function: (shape) => {
    const s = shape as TypeShape & { kind: "function" }
    const params = s.params.map((p) => `${p.name}: ${toRubyType(p.type)}`)
    const paramsClause = params.length === 0 ? "" : `.params(${params.join(", ")})`
    return `T.proc${paramsClause}.returns(${toRubyType(s.returnType)})`
  },
  // A service surface (`interface`) has no Sorbet value-type equivalent —
  // it's a module's *method* surface, not a type occupying a variable/field
  // position — degrades honestly to `T.untyped`, same as protobuf.ts's
  // `interface` handler.
  interface: leaf("T.untyped"),
}

function coreRubyType(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  return converter === undefined ? "T.untyped" : converter(ref.shape, ref.meta)
}

/** A Sorbet type expression for `ref` — suitable for a `sig` param/return
 * annotation, a `T::Struct` prop declaration, or a `T.type_alias` body. */
export function toRubyType(ref: TypeRef): string {
  const core = coreRubyType(ref)
  return ref.meta.nullable === true ? `T.nilable(${core})` : core
}

// prop/const declaration for one T::Struct field, handling the
// nowhere-to-hang-a-name cases (nested `object`/`enum`, or an array of
// either) by synthesizing `<StructName><Capitalized field name>` — same
// convention protobuf.ts's `toProtoMessage` uses for nested messages/enums —
// and collecting the synthesized class alongside it.
function structField(
  structName: string,
  fieldName: string,
  fieldRef: TypeRef,
): { declaration: string; nested: string[] } {
  const nested: string[] = []
  let core: string
  if (isA(fieldRef.shape.kind, "object")) {
    const nestedName = `${structName}${capitalize(fieldName)}`
    nested.push(toRubyClass(nestedName, fieldRef))
    core = nestedName
  } else if (fieldRef.shape.kind === "enum") {
    const nestedName = `${structName}${capitalize(fieldName)}`
    nested.push(toRubyEnum(nestedName, fieldRef))
    core = nestedName
  } else if (fieldRef.shape.kind === "array" && isA((fieldRef.shape as TypeShape & { kind: "array" }).element.shape.kind, "object")) {
    const element = (fieldRef.shape as TypeShape & { kind: "array" }).element
    const nestedName = `${structName}${capitalize(fieldName)}`
    nested.push(toRubyClass(nestedName, element))
    core = `T::Array[${nestedName}]`
  } else if (fieldRef.shape.kind === "array" && (fieldRef.shape as TypeShape & { kind: "array" }).element.shape.kind === "enum") {
    const element = (fieldRef.shape as TypeShape & { kind: "array" }).element
    const nestedName = `${structName}${capitalize(fieldName)}`
    nested.push(toRubyEnum(nestedName, element))
    core = `T::Array[${nestedName}]`
  } else {
    core = coreRubyType(fieldRef)
  }

  const optional = fieldRef.meta.optional === true
  const nullable = fieldRef.meta.nullable === true
  const type = optional || nullable ? `T.nilable(${core})` : core
  // `const` for a field marked `readonly` — Sorbet's T::Props distinguishes
  // an immutable `const` from a mutable `prop`
  // (https://sorbet.org/docs/tstruct) — `prop` otherwise (the default,
  // matching plain Ruby attr_accessor semantics).
  const keyword = fieldRef.meta.readonly === true ? "const" : "prop"
  const defaultClause = optional ? ", default: nil" : ""
  const deprecatedComment = fieldRef.meta.deprecated === true ? " # @deprecated" : ""
  const description = typeof fieldRef.meta.description === "string" ? `  # ${fieldRef.meta.description}\n` : ""
  return {
    declaration: `${description}  ${keyword} :${fieldName}, ${type}${defaultClause}${deprecatedComment}`,
    nested,
  }
}

/**
 * Lower an `object` TypeRef to a named `T::Struct` class — Sorbet's typed
 * data-class convention (https://sorbet.org/docs/tstruct). Includes
 * `to_json`/`self.from_json` built atop `T::Props::Serializable`'s
 * `serialize`/`from_hash` (which `T::Struct` already mixes in), since plain
 * `T::Struct` gives you struct semantics but not JSON string (de)serialization
 * out of the box.
 */
export function toRubyClass(name: string, ref: TypeRef): string {
  const shape = ref.shape as TypeShape & { kind: "object" }
  const nestedClasses: string[] = []
  const fieldLines: string[] = []

  for (const [fieldName, fieldRef] of Object.entries(shape.fields)) {
    const { declaration, nested } = structField(name, fieldName, fieldRef)
    nestedClasses.push(...nested)
    fieldLines.push(declaration)
  }

  const lines: string[] = []
  if (typeof ref.meta.description === "string") lines.push(`# ${ref.meta.description}`)
  if (ref.meta.deprecated === true) lines.push(`# @deprecated`)
  lines.push(`class ${name} < T::Struct`)
  lines.push("  extend T::Sig")
  if (fieldLines.length > 0) {
    lines.push("")
    lines.push(...fieldLines)
  }
  lines.push("")
  lines.push("  sig { returns(String) }")
  lines.push("  def to_json(*_args)")
  lines.push("    serialize.to_json")
  lines.push("  end")
  lines.push("")
  lines.push(`  sig { params(json: String).returns(${name}) }`)
  lines.push("  def self.from_json(json)")
  lines.push("    from_hash(JSON.parse(json))")
  lines.push("  end")
  lines.push("end")

  return [...nestedClasses, lines.join("\n")].join("\n\n")
}

/**
 * Lower an `enum` TypeRef to a named `T::Enum` class
 * (https://sorbet.org/docs/tenum) — one constant per member, serialized back
 * to the member's own string value (so `T::Enum#serialize`/`.deserialize`,
 * both built into `T::Enum` already, round-trip to the original strings with
 * no extra code needed here).
 */
export function toRubyEnum(name: string, ref: TypeRef): string {
  const shape = ref.shape as TypeShape & { kind: "enum" }
  const lines: string[] = []
  if (typeof ref.meta.description === "string") lines.push(`# ${ref.meta.description}`)
  lines.push(`class ${name} < T::Enum`)
  lines.push("  enums do")
  for (const member of shape.members) {
    lines.push(`    ${enumConstantName(member)} = new(${quote(member)})`)
  }
  lines.push("  end")
  lines.push("end")
  return lines.join("\n")
}

/**
 * Sorbet `sig` block + method signature line for a `function`/`method`
 * TypeRef — used for rendering `interface.methods` entries (an
 * `interface`'s own TypeRef has no Sorbet value-type form, see the
 * `interface` handler above, but its individual methods DO have a natural
 * Sorbet rendering as instance methods).
 */
export function toRubyMethodSig(methodName: string, ref: TypeRef): string {
  const s = ref.shape as TypeShape & { kind: "method" | "function"; params: readonly { name: string; type: TypeRef }[]; returnType: TypeRef }
  const params = s.params.map((p) => `${p.name}: ${toRubyType(p.type)}`)
  const isVoid = s.returnType.shape.kind === "void"
  const sigParams = params.length === 0 ? "" : ` params(${params.join(", ")}).`
  const sigReturn = isVoid ? "void" : `returns(${toRubyType(s.returnType)})`
  const paramNames = s.params.map((p) => p.name).join(", ")
  return [`sig {${sigParams} ${sigReturn} }`, `def ${methodName}(${paramNames}); end`].join("\n")
}

/**
 * Top-level entry point: `object` and `enum` TypeRefs (given a `name`) lower
 * to a full `T::Struct`/`T::Enum` class declaration; anything else lowers to
 * a `T.type_alias` binding when `name` is given, or a bare Sorbet type
 * expression (suitable for inlining into a `sig`) when it isn't.
 */
export function toRuby(ref: TypeRef, name?: string): string {
  if (name !== undefined) {
    if (ref.shape.kind === "object") return toRubyClass(name, ref)
    if (ref.shape.kind === "enum") return toRubyEnum(name, ref)
    return `${name} = T.type_alias { ${toRubyType(ref)} }`
  }
  return toRubyType(ref)
}

// ============================================================================
// RBS mode (https://github.com/ruby/rbs) — an alternative to Sorbet's inline
// `sig`s: a separate signature-file syntax, bundled with Ruby 3+ and not
// requiring the `sorbet-runtime` gem. Entry points are independent of the
// Sorbet ones above; a caller picks one mode or the other per target file.
// ============================================================================

type RbsConverter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string

const rbsHandlers: Record<string, RbsConverter> = {
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
  // RBS does support literal types (https://github.com/ruby/rbs/blob/master/docs/syntax.md#type-syntax),
  // unlike Sorbet — rendered directly rather than degraded to a runtime class.
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
  const converter = resolve(ref.shape.kind, rbsHandlers)
  return converter === undefined ? "untyped" : converter(ref.shape, ref.meta)
}

/** An RBS type expression for `ref`. */
export function toRbsType(ref: TypeRef): string {
  const core = coreRbsType(ref)
  return ref.meta.nullable === true ? `${core}?` : core
}

/**
 * Lower an `object` TypeRef to an RBS `class` signature block — one
 * `attr_reader` per field (RBS signature files describe an existing
 * implementation's interface, not a definition, so there's no
 * prop/initializer syntax to emit the way `toRubyClass`'s `T::Struct` does).
 * Nested `object`/`enum` fields degrade to `Hash[Symbol, untyped]`/the
 * member-literal union inline (no RBS nested-class synthesis here — RBS
 * classes are declared per source file, not embedded structurally).
 */
export function toRbsClass(name: string, ref: TypeRef): string {
  const shape = ref.shape as TypeShape & { kind: "object" }
  const lines: string[] = [`class ${name}`]
  for (const [fieldName, fieldRef] of Object.entries(shape.fields)) {
    const optional = fieldRef.meta.optional === true
    const core = coreRbsType(fieldRef)
    const type = optional || fieldRef.meta.nullable === true ? `${core}?` : core
    lines.push(`  attr_reader ${fieldName}: ${type}`)
  }
  lines.push("end")
  return lines.join("\n")
}
