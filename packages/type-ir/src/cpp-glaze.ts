import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// packages/type-ir/src/cpp-glaze.ts — @rhi-zone/fractal-type-ir/cpp-glaze
//
// TypeRef -> C++17/20 struct/enum-class declarations with glaze
// (https://github.com/stephenberry/glaze) compile-time-reflection
// serialization support. glaze reads a struct's shape through a
// `glz::meta<T>` specialization (`glz::object("field", &T::field, ...)`) the
// same way Boost.Describe or nlohmann's macro read a struct's field list —
// but unlike cpp-boost-json.ts's tag_invoke (a pair of hand-written
// conversion functions per type) or cpp-rapidjson.ts's manual AddMember/Get*
// walk, glaze only needs the *shape declared once*: `glz::read_json`/
// `glz::write_json` then handle std::vector/std::optional/std::map/nested
// meta-annotated structs generically at compile time on their own, closer in
// spirit to cpp-nlohmann.ts's macro (declare the field list, get both
// directions for free) than to cpp-rapidjson.ts's per-field codegen.
//
// `glz::json_t` (glaze's own dynamic-JSON value type) is the fallback/
// degrade target, filling the role nlohmann::json/rapidjson::Document/
// boost::json::value play in their sibling files. Enum members get a
// `glz::meta` specialization built from `glz::enumerate(...)` instead of
// `glz::object(...)` — glaze's dedicated string<->enumerator mapping
// construct, used in place of cpp-nlohmann.ts's hand-written switch-based
// toString/fromString pair (glaze generates that string mapping itself from
// the `glz::enumerate` table, so no toString/fromString helpers are emitted
// here at all).

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

function quote(value: string): string {
  return JSON.stringify(value)
}

function fallback(ctx: Ctx): string {
  ctx.headers.add("<glaze/glaze.hpp>")
  return "glz::json_t"
}

const leaf =
  (type: string, header?: string): Converter =>
  (_shape, _meta, ctx) => {
    if (header !== undefined) ctx.headers.add(header)
    return type
  }

// glaze's `glz::enumerate` table (https://github.com/stephenberry/glaze/blob/main/docs/enums.md)
// is the compile-time equivalent of cpp-nlohmann.ts's hand-written
// toString/fromString switch — a single `glz::meta<T>` specialization gives
// glaze both directions, so this file emits no free functions for enums at
// all, unlike every sibling projector.
function emitEnumDecl(name: string, members: readonly string[], ctx: Ctx, description?: string): string {
  if (ctx.declaredNames.has(name)) return name
  ctx.declaredNames.add(name)
  ctx.headers.add("<glaze/glaze.hpp>")

  const enumerators = members.map(pascalCase)
  const lines: string[] = []
  if (description !== undefined) lines.push(`// ${description}`)
  lines.push(`enum class ${name} {`)
  lines.push(enumerators.map((e) => `  ${e},`).join("\n"))
  lines.push(`};`)
  lines.push("")
  lines.push(`template <>`)
  lines.push(`struct glz::meta<${name}> {`)
  lines.push(`  using enum ${name};`)
  const entries = members.map((member, i) => `${enumerators[i]}, ${quote(member)}`).join(", ")
  lines.push(`  static constexpr auto value = glz::enumerate(${entries});`)
  lines.push(`};`)
  ctx.decls.push(lines.join("\n"))
  return name
}

// glaze's `glz::object(...)` table (https://github.com/stephenberry/glaze/blob/main/docs/reflection.md)
// is a name/member-pointer list, the compile-time-reflection analogue of
// cpp-nlohmann.ts's NLOHMANN_DEFINE_TYPE_INTRUSIVE field list — glz::read_json/
// glz::write_json walk std::vector/std::optional/std::map/nested
// glz::meta-annotated struct fields recursively on their own from this one
// declaration, so (like cpp-boost-json.ts's tag_invoke, but even more so)
// no per-field container-walking code is generated here.
function emitStructDecl(
  name: string,
  fields: Readonly<Record<string, TypeRef>>,
  ctx: Ctx,
  description?: string,
): string {
  if (ctx.declaredNames.has(name)) return name
  ctx.declaredNames.add(name)
  ctx.headers.add("<glaze/glaze.hpp>")

  const fieldNames = Object.keys(fields)
  const memberLines = fieldNames.map((fieldName) => {
    const fieldRef = fields[fieldName]!
    const type = glzType(fieldRef, ctx, pascalCase(fieldName))
    return `  ${type} ${fieldName};`
  })

  const objectEntries = fieldNames.map((fieldName) => `${quote(fieldName)}, &${name}::${fieldName}`).join(", ")

  const lines: string[] = []
  if (description !== undefined) lines.push(`// ${description}`)
  lines.push(`struct ${name} {`)
  lines.push(...memberLines)
  lines.push(`};`)
  lines.push("")
  lines.push(`template <>`)
  lines.push(`struct glz::meta<${name}> {`)
  lines.push(`  using T = ${name};`)
  lines.push(`  static constexpr auto value = glz::object(${objectEntries});`)
  lines.push(`};`)
  ctx.decls.push(lines.join("\n"))
  return name
}

// `interface`'s methods have no data-field analogue — same abstract-class
// rendering cpp-nlohmann.ts uses, since a method surface has no
// glz::meta-reflectable shape either way.
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
    const params = m.params.map((p) => `${glzType(p.type, ctx, pascalCase(p.name))} ${p.name}`)
    const ret = glzType(m.returnType, ctx, `${pascalCase(methodName)}Result`)
    lines.push(`  virtual ${ret} ${methodName}(${params.join(", ")}) = 0;`)
  }
  lines.push(`};`)
  ctx.decls.push(lines.join("\n"))
  return name
}

const handlers: Record<string, Converter> = {
  boolean: leaf("bool"),
  number: leaf("double"),
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
  never: (_shape, _meta, ctx) => {
    ctx.headers.add("<variant>")
    return "std::monostate"
  },
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  array: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "array" }
    ctx.headers.add("<vector>")
    return `std::vector<${glzType(s.element, ctx, hint)}>`
  },
  stream: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "stream" }
    ctx.headers.add("<vector>")
    return `std::vector<${glzType(s.element, ctx, hint)}>`
  },
  page: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "page" }
    ctx.headers.add("<vector>")
    return `std::vector<${glzType(s.element, ctx, hint)}>`
  },
  tuple: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "tuple" }
    ctx.headers.add("<tuple>")
    return `std::tuple<${s.elements.map((e) => glzType(e, ctx, hint)).join(", ")}>`
  },
  map: (shape, meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "map" }
    const key = glzType(s.key, ctx, hint)
    const value = glzType(s.value, ctx, hint)
    const unordered = meta.unordered === true
    ctx.headers.add(unordered ? "<unordered_map>" : "<map>")
    return `${unordered ? "std::unordered_map" : "std::map"}<${key}, ${value}>`
  },
  // glaze supports std::variant natively (dispatched on parse by trying each
  // alternative), so unlike cpp-boost-json.ts/cpp-nlohmann.ts, std::variant<...>
  // here is a fully working glaze-serializable type, not just a type-position
  // mapping with no generated glue — no extra glz::meta entry is needed since
  // glaze's variant support is built into the library itself, not opt-in
  // per-type the way object/enum reflection is.
  union: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "union" }
    ctx.headers.add("<variant>")
    return `std::variant<${s.variants.map((v) => glzType(v, ctx, hint)).join(", ")}>`
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
  intersection: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    return first === undefined ? fallback(ctx) : glzType(first, ctx, hint)
  },
  function: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "function" }
    ctx.headers.add("<functional>")
    const params = s.params.map((p) => glzType(p.type, ctx, pascalCase(p.name)))
    const ret = glzType(s.returnType, ctx, `${hint}Result`)
    return `std::function<${ret}(${params.join(", ")})>`
  },
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

function glzType(ref: TypeRef, ctx: Ctx, hint: string): string {
  const converter = resolve(ref.shape.kind, handlers)
  let type = converter === undefined ? fallback(ctx) : converter(ref.shape, ref.meta, ctx, hint)
  if (ref.meta.optional === true || ref.meta.nullable === true) {
    ctx.headers.add("<optional>")
    type = `std::optional<${type}>`
  }
  return type
}

/**
 * Lower a `TypeRef` to a C++17/20 header-shaped string targeting glaze:
 * `#include` directives, every named declaration the tree required (nested
 * object/enum fields hoisted to their own top-level struct/enum class, in
 * dependency order — see the file-level doc comment), then the root type's
 * own declaration. Struct/enum declarations carry a `glz::meta<T>`
 * specialization (`glz::object(...)`/`glz::enumerate(...)`) — glaze's
 * compile-time reflection registration, read by `glz::read_json`/
 * `glz::write_json` for both directions from one declaration, unlike every
 * sibling projector's per-direction functions.
 *
 * An `object`/`enum`/`interface` root becomes a named `struct`/`enum class`/
 * class declaration named `name` (default `"Root"`); any other root kind
 * becomes a `using name = ...;` alias over the computed type expression.
 */
export function toGlaze(ref: TypeRef, name = "Root"): string {
  const ctx: Ctx = { headers: new Set(), decls: [], declaredNames: new Set() }
  const isNamedDecl = ref.shape.kind === "object" || ref.shape.kind === "enum" || ref.shape.kind === "interface"
  const typeExpr = glzType(ref, ctx, name)
  const body = isNamedDecl ? ctx.decls.join("\n\n") : [...ctx.decls, `using ${name} = ${typeExpr};`].join("\n\n")
  const headerLines = [...ctx.headers].sort().map((header) => `#include ${header}`)
  return [...headerLines, "", body].join("\n").trimEnd() + "\n"
}
