import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// packages/type-ir/src/cpp.ts — @rhi-zone/fractal-type-ir/cpp
//
// TypeRef -> C++17 struct/enum-class declarations with nlohmann/json
// (https://github.com/nlohmann/json) serialization support. Unlike
// typescript.ts (a single expression-position converter — TS structural
// types can be written inline anywhere), C++ has no anonymous struct/enum
// expression form: an `object`/`enum` TypeRef needs an actual named
// declaration statement, not just a type-position string. So this
// projector, like protobuf.ts/capnp.ts, walks the tree collecting named
// declarations (`ctx.decls`) as a side effect of computing type-position
// expressions (`cppType`), then assembles headers + decls into one
// translation-unit-shaped string. Nested object/enum fields are hoisted to
// their own top-level named declaration (name derived from the field name,
// PascalCased) rather than nested C++ classes — same flattening protobuf.ts
// uses for nested messages/enums, since it sidesteps forward-declaration
// ordering concerns entirely.

type Ctx = {
  readonly headers: Set<string>
  readonly decls: string[]
  readonly declaredNames: Set<string>
}

type Converter = (
  shape: TypeShape,
  meta: Readonly<Record<string, unknown>>,
  ctx: Ctx,
  hint: string,
) => string

function pascalCase(name: string): string {
  const words = name.split(/[^a-zA-Z0-9]+/).filter((w) => w.length > 0)
  if (words.length === 0) return "Value"
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("")
}

function lowerFirst(name: string): string {
  return name.length === 0 ? name : name[0]!.toLowerCase() + name.slice(1)
}

function quote(value: string): string {
  return JSON.stringify(value)
}

// Degrade target for kinds this projector has no native construct for
// (`unknown`, and any kind — built-in or extension-registered — with no
// matching/ancestor handler): nlohmann::json is C++'s closest analogue to
// "arbitrary JSON value," the same role it plays as the fallback in
// projectors like jtd.ts.
function fallback(ctx: Ctx): string {
  ctx.headers.add("<nlohmann/json.hpp>")
  return "nlohmann::json"
}

const leaf =
  (type: string, header?: string): Converter =>
  (_shape, _meta, ctx) => {
    if (header !== undefined) ctx.headers.add(header)
    return type
  }

function emitEnumDecl(name: string, members: readonly string[], ctx: Ctx, description?: string): string {
  if (ctx.declaredNames.has(name)) return name
  ctx.declaredNames.add(name)
  ctx.headers.add("<string>")
  ctx.headers.add("<stdexcept>")
  ctx.headers.add("<nlohmann/json.hpp>")

  const enumerators = members.map(pascalCase)
  const lines: string[] = []
  if (description !== undefined) lines.push(`// ${description}`)
  lines.push(`enum class ${name} {`)
  lines.push(enumerators.map((e) => `  ${e},`).join("\n"))
  lines.push(`};`)
  lines.push("")
  lines.push(`inline std::string toString(${name} value) {`)
  lines.push(`  switch (value) {`)
  for (const [i, member] of members.entries()) {
    lines.push(`    case ${name}::${enumerators[i]}: return ${quote(member)};`)
  }
  lines.push(`  }`)
  lines.push(`  throw std::invalid_argument("invalid ${name}");`)
  lines.push(`}`)
  lines.push("")
  lines.push(`inline ${name} ${lowerFirst(name)}FromString(const std::string& value) {`)
  for (const [i, member] of members.entries()) {
    lines.push(`  if (value == ${quote(member)}) return ${name}::${enumerators[i]};`)
  }
  lines.push(`  throw std::invalid_argument("invalid ${name}: " + value);`)
  lines.push(`}`)
  lines.push("")
  lines.push(`inline void to_json(nlohmann::json& j, const ${name}& value) { j = toString(value); }`)
  lines.push(
    `inline void from_json(const nlohmann::json& j, ${name}& value) { value = ${lowerFirst(name)}FromString(j.get<std::string>()); }`,
  )
  ctx.decls.push(lines.join("\n"))
  return name
}

function emitStructDecl(
  name: string,
  fields: Readonly<Record<string, TypeRef>>,
  ctx: Ctx,
  description?: string,
): string {
  if (ctx.declaredNames.has(name)) return name
  ctx.declaredNames.add(name)
  ctx.headers.add("<nlohmann/json.hpp>")

  const fieldNames = Object.keys(fields)
  const memberLines = fieldNames.map((fieldName) => {
    const fieldRef = fields[fieldName]!
    const type = cppType(fieldRef, ctx, pascalCase(fieldName))
    return `  ${type} ${fieldName};`
  })

  const lines: string[] = []
  if (description !== undefined) lines.push(`// ${description}`)
  lines.push(`struct ${name} {`)
  lines.push(...memberLines)
  lines.push("")
  lines.push(
    fieldNames.length > 0
      ? `  NLOHMANN_DEFINE_TYPE_INTRUSIVE(${name}, ${fieldNames.join(", ")})`
      : `  NLOHMANN_DEFINE_TYPE_INTRUSIVE(${name})`,
  )
  lines.push(`};`)
  ctx.decls.push(lines.join("\n"))
  return name
}

// `interface`'s methods have no data-field analogue (see index.ts's
// TypeKinds.interface doc comment) — the closest native C++ construct is an
// abstract base class of pure-virtual methods, one per interface method.
function emitInterfaceDecl(
  name: string,
  methods: Readonly<Record<string, TypeRef>>,
  ctx: Ctx,
  description?: string,
): string {
  if (ctx.declaredNames.has(name)) return name
  ctx.declaredNames.add(name)

  const lines: string[] = []
  if (description !== undefined) lines.push(`// ${description}`)
  lines.push(`class ${name} {`)
  lines.push(` public:`)
  lines.push(`  virtual ~${name}() = default;`)
  for (const [methodName, methodRef] of Object.entries(methods)) {
    const m = methodRef.shape as TypeShape & {
      kind: "method" | "function"
      params: readonly { name: string; type: TypeRef }[]
      returnType: TypeRef
    }
    const params = m.params.map((p) => `${cppType(p.type, ctx, pascalCase(p.name))} ${p.name}`)
    const ret = cppType(m.returnType, ctx, `${pascalCase(methodName)}Result`)
    lines.push(`  virtual ${ret} ${methodName}(${params.join(", ")}) = 0;`)
  }
  lines.push(`};`)
  ctx.decls.push(lines.join("\n"))
  return name
}

const handlers: Record<string, Converter> = {
  boolean: leaf("bool"),
  number: leaf("double"),
  // Bare `integer` carries no width — int64_t is the safest default (widest
  // common case); `int8`/`int16`/`int32`/`int64`/`uint8`/`uint16`/`uint32`/
  // `uint64` (kinds/int-widths.ts) below pick the exact stdint type instead.
  integer: leaf("int64_t", "<cstdint>"),
  int8: leaf("int8_t", "<cstdint>"),
  int16: leaf("int16_t", "<cstdint>"),
  int32: leaf("int32_t", "<cstdint>"),
  int64: leaf("int64_t", "<cstdint>"),
  uint8: leaf("uint8_t", "<cstdint>"),
  uint16: leaf("uint16_t", "<cstdint>"),
  uint32: leaf("uint32_t", "<cstdint>"),
  uint64: leaf("uint64_t", "<cstdint>"),
  float32: leaf("float"),
  float64: leaf("double"),
  string: leaf("std::string", "<string>"),
  uuid: leaf("std::string", "<string>"),
  uri: leaf("std::string", "<string>"),
  email: leaf("std::string", "<string>"),
  time: leaf("std::string", "<string>"),
  duration: leaf("std::string", "<string>"),
  bytes: (_shape, _meta, ctx) => {
    ctx.headers.add("<vector>")
    ctx.headers.add("<cstdint>")
    return "std::vector<uint8_t>"
  },
  null: leaf("std::nullptr_t", "<cstddef>"),
  void: leaf("void"),
  unknown: (_shape, _meta, ctx) => fallback(ctx),
  // Uninhabited — std::monostate (from <variant>) is C++'s closest "value
  // that carries no information" type, the same construct `std::variant`
  // itself uses for its empty alternative.
  never: (_shape, _meta, ctx) => {
    ctx.headers.add("<variant>")
    return "std::monostate"
  },
  // A class instance carries only nominal identity (className/source), never
  // fields (see index.ts's TypeKinds.instance doc comment) — the caller
  // assembling this emitted source is responsible for #include-ing className's
  // own declaration, same convention typescript.ts/protobuf.ts use.
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "array" }
    ctx.headers.add("<vector>")
    return `std::vector<${cppType(s.element, ctx, hint)}>`
  },
  // No native streaming construct — degrades to its vector equivalent, same
  // honest-degrade convention typescript.ts/protobuf.ts use for `stream`.
  stream: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "stream" }
    ctx.headers.add("<vector>")
    return `std::vector<${cppType(s.element, ctx, hint)}>`
  },
  // No native pagination construct — degrades to its vector equivalent over
  // the page's element type, same convention as `stream` above.
  page: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "page" }
    ctx.headers.add("<vector>")
    return `std::vector<${cppType(s.element, ctx, hint)}>`
  },
  tuple: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "tuple" }
    ctx.headers.add("<tuple>")
    return `std::tuple<${s.elements.map((e) => cppType(e, ctx, hint)).join(", ")}>`
  },
  map: (shape, meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "map" }
    const key = cppType(s.key, ctx, hint)
    const value = cppType(s.value, ctx, hint)
    // `meta.unordered: boolean` — opt-in convention (like `meta.optional`/
    // `meta.nullable` elsewhere) for callers that want std::unordered_map's
    // O(1) lookup over std::map's ordered-iteration guarantee.
    const unordered = meta.unordered === true
    ctx.headers.add(unordered ? "<unordered_map>" : "<map>")
    return `${unordered ? "std::unordered_map" : "std::map"}<${key}, ${value}>`
  },
  union: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "union" }
    ctx.headers.add("<variant>")
    return `std::variant<${s.variants.map((v) => cppType(v, ctx, hint)).join(", ")}>`
  },
  literal: (shape, _meta, ctx) => {
    const s = shape as TypeShape & { kind: "literal" }
    if (s.value === null) {
      ctx.headers.add("<cstddef>")
      return "std::nullptr_t"
    }
    if (typeof s.value === "string") {
      ctx.headers.add("<string>")
      return "std::string"
    }
    if (typeof s.value === "boolean") return "bool"
    ctx.headers.add("<cstdint>")
    return Number.isInteger(s.value) ? "int64_t" : "double"
  },
  enum: (shape, meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "enum" }
    return emitEnumDecl(hint, s.members, ctx, typeof meta.description === "string" ? meta.description : undefined)
  },
  ref: (shape) => (shape as TypeShape & { kind: "ref" }).target,
  // No native intersection construct — lossy: degrades to the first member's
  // type, same fallback protobuf.ts uses for `intersection`.
  intersection: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    return first === undefined ? fallback(ctx) : cppType(first, ctx, hint)
  },
  function: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "function" }
    ctx.headers.add("<functional>")
    const params = s.params.map((p) => cppType(p.type, ctx, pascalCase(p.name)))
    const ret = cppType(s.returnType, ctx, `${hint}Result`)
    return `std::function<${ret}(${params.join(", ")})>`
  },
  // `method` has no explicit entry — falls back to `function`'s
  // std::function<...> rendering via registerParent("method", "function")
  // for the standalone/field-position case. The `interface` handler below
  // renders each method as a pure-virtual member instead, since that's the
  // idiomatic C++ form once a callable belongs to a type's method surface.
  object: (shape, meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "object" }
    return emitStructDecl(hint, s.fields, ctx, typeof meta.description === "string" ? meta.description : undefined)
  },
  interface: (shape, meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "interface" }
    return emitInterfaceDecl(
      hint,
      s.methods,
      ctx,
      typeof meta.description === "string" ? meta.description : undefined,
    )
  },
}

function cppType(ref: TypeRef, ctx: Ctx, hint: string): string {
  const converter = resolve(ref.shape.kind, handlers)
  let type = converter === undefined ? fallback(ctx) : converter(ref.shape, ref.meta, ctx, hint)
  // `meta.optional`/`meta.nullable` (see index.ts's meta-convention doc
  // comment) both wrap in std::optional<T> — C++ has no separate "may be
  // absent" vs. "may be null" value construct the way a dynamically-typed
  // wire format does, so both collapse to the same "T or nothing" idiom.
  if (ref.meta.optional === true || ref.meta.nullable === true) {
    ctx.headers.add("<optional>")
    type = `std::optional<${type}>`
  }
  return type
}

/**
 * Lower a `TypeRef` to a C++17 header-shaped string: `#include` directives
 * followed by every named declaration the tree required (nested object/enum
 * fields hoisted to their own top-level struct/enum class, in dependency
 * order — see the file-level doc comment), followed by the root type's own
 * declaration.
 *
 * An `object`/`enum`/`interface` root becomes a named `struct`/`enum class`/
 * class declaration named `name` (default `"Root"`); any other root kind
 * (primitive, array, map, tuple, union, …) becomes a `using name = ...;`
 * alias over the computed type expression, so the returned name is always
 * usable as a type in either case.
 */
export function toCpp(ref: TypeRef, name = "Root"): string {
  const ctx: Ctx = { headers: new Set(), decls: [], declaredNames: new Set() }
  const isNamedDecl = ref.shape.kind === "object" || ref.shape.kind === "enum" || ref.shape.kind === "interface"
  const typeExpr = cppType(ref, ctx, name)
  const body = isNamedDecl ? ctx.decls.join("\n\n") : [...ctx.decls, `using ${name} = ${typeExpr};`].join("\n\n")
  const headerLines = [...ctx.headers].sort().map((header) => `#include ${header}`)
  return [...headerLines, "", body].join("\n").trimEnd() + "\n"
}
