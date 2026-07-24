import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// packages/type-ir/src/cpp-boost-json.ts — @rhi-zone/fractal-type-ir/cpp-boost-json
//
// TypeRef -> C++17 struct/enum-class declarations with Boost.JSON
// (https://www.boost.org/doc/libs/release/libs/json/) serialization support
// via the `tag_invoke` customization-point pattern
// (https://www.boost.org/doc/libs/release/libs/json/doc/html/json/ref/boost__json__value_from.html).
// Unlike cpp-rapidjson.ts's target library, Boost.JSON *does* have generic,
// ADL-found conversion for the standard containers this IR needs
// (std::vector, std::map<std::string, T>, std::optional, nested tag_invoke-
// enabled structs) — `boost::json::value_from`/`value_to` recurse through
// them on their own, the same way nlohmann's adl_serializer does. So a
// struct's `tag_invoke` overloads only need to name its own fields, not walk
// their types by hand the way cpp-rapidjson.ts's rjToJson/rjFromJson do —
// this file's shape is much closer to cpp-nlohmann.ts's than to
// cpp-rapidjson.ts's. `boost::json::value` (Boost.JSON's own "arbitrary JSON
// value" handle) is the fallback/degrade target, filling the role
// nlohmann::json/rapidjson::Document/simdjson::dom::element play in their
// sibling files.
//
// `union` still gets no generated tag_invoke of its own: Boost.JSON has no
// built-in std::variant support, and this IR carries no discriminator to
// synthesize one honestly — same "type mapping only, no serialization
// glue" scope cpp-nlohmann.ts leaves union at.

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

function fallback(ctx: Ctx): string {
  ctx.headers.add("<boost/json.hpp>")
  return "boost::json::value"
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
  ctx.headers.add("<boost/json.hpp>")

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
  lines.push(`inline void tag_invoke(const boost::json::value_from_tag&, boost::json::value& jv, ${name} value) {`)
  lines.push(`  jv = toString(value);`)
  lines.push(`}`)
  lines.push("")
  lines.push(
    `inline ${name} tag_invoke(const boost::json::value_to_tag<${name}>&, const boost::json::value& jv) {`,
  )
  lines.push(`  return ${lowerFirst(name)}FromString(std::string(jv.as_string()));`)
  lines.push(`}`)
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
  ctx.headers.add("<boost/json.hpp>")

  const fieldNames = Object.keys(fields)
  const memberLines = fieldNames.map((fieldName) => {
    const fieldRef = fields[fieldName]!
    const type = bjType(fieldRef, ctx, pascalCase(fieldName))
    return `  ${type} ${fieldName};`
  })

  // boost::json::value's initializer-list object constructor calls
  // boost::json::value_from on each entry via ADL, recursing through
  // containers/optional/nested tag_invoke-enabled types on its own — this
  // struct's tag_invoke only has to name its fields, same reason
  // cpp-nlohmann.ts's NLOHMANN_DEFINE_TYPE_INTRUSIVE only needs a field list.
  const toEntries = fieldNames.map((fieldName) => `{${quote(fieldName)}, value.${fieldName}}`).join(", ")

  const fromFields = fieldNames
    .map((fieldName) => {
      const fieldRef = fields[fieldName]!
      const fieldType = bjType(fieldRef, ctx, pascalCase(fieldName))
      return `    boost::json::value_to<${fieldType}>(obj.at(${quote(fieldName)})),`
    })
    .join("\n")

  const lines: string[] = []
  if (description !== undefined) lines.push(`// ${description}`)
  lines.push(`struct ${name} {`)
  lines.push(...memberLines)
  lines.push(`};`)
  lines.push("")
  lines.push(`inline void tag_invoke(const boost::json::value_from_tag&, boost::json::value& jv, const ${name}& value) {`)
  lines.push(`  jv = { ${toEntries} };`)
  lines.push(`}`)
  lines.push("")
  lines.push(
    `inline ${name} tag_invoke(const boost::json::value_to_tag<${name}>&, const boost::json::value& jv) {`,
  )
  lines.push(`  const auto& obj = jv.as_object();`)
  lines.push(`  return ${name}{`)
  lines.push(fromFields)
  lines.push(`  };`)
  lines.push(`}`)
  ctx.decls.push(lines.join("\n"))
  return name
}

// `interface`'s methods have no data-field analogue — same abstract-class
// rendering cpp-nlohmann.ts uses, since a method surface has no
// tag_invoke-serialization concern either way.
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
    const params = m.params.map((p) => `${bjType(p.type, ctx, pascalCase(p.name))} ${p.name}`)
    const ret = bjType(m.returnType, ctx, `${pascalCase(methodName)}Result`)
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
    return `std::vector<${bjType(s.element, ctx, hint)}>`
  },
  stream: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "stream" }
    ctx.headers.add("<vector>")
    return `std::vector<${bjType(s.element, ctx, hint)}>`
  },
  page: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "page" }
    ctx.headers.add("<vector>")
    return `std::vector<${bjType(s.element, ctx, hint)}>`
  },
  tuple: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "tuple" }
    ctx.headers.add("<tuple>")
    return `std::tuple<${s.elements.map((e) => bjType(e, ctx, hint)).join(", ")}>`
  },
  // Boost.JSON's built-in map support keys on std::string specifically
  // (boost::json::object itself is string-keyed) — same assumption
  // cpp-nlohmann.ts's std::map<K, V> mapping leaves implicit, made explicit
  // here only because it constrains which K actually round-trips through
  // value_from/value_to without a custom tag_invoke for the key type.
  map: (shape, meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "map" }
    const key = bjType(s.key, ctx, hint)
    const value = bjType(s.value, ctx, hint)
    const unordered = meta.unordered === true
    ctx.headers.add(unordered ? "<unordered_map>" : "<map>")
    return `${unordered ? "std::unordered_map" : "std::map"}<${key}, ${value}>`
  },
  union: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "union" }
    ctx.headers.add("<variant>")
    return `std::variant<${s.variants.map((v) => bjType(v, ctx, hint)).join(", ")}>`
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
    return first === undefined ? fallback(ctx) : bjType(first, ctx, hint)
  },
  function: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "function" }
    ctx.headers.add("<functional>")
    const params = s.params.map((p) => bjType(p.type, ctx, pascalCase(p.name)))
    const ret = bjType(s.returnType, ctx, `${hint}Result`)
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

function bjType(ref: TypeRef, ctx: Ctx, hint: string): string {
  const converter = resolve(ref.shape.kind, handlers)
  let type = converter === undefined ? fallback(ctx) : converter(ref.shape, ref.meta, ctx, hint)
  if (ref.meta.optional === true || ref.meta.nullable === true) {
    ctx.headers.add("<optional>")
    type = `std::optional<${type}>`
  }
  return type
}

/**
 * Lower a `TypeRef` to a C++17 header-shaped string targeting Boost.JSON:
 * `#include` directives, every named declaration the tree required (nested
 * object/enum fields hoisted to their own top-level struct/enum class, in
 * dependency order — see the file-level doc comment), then the root type's
 * own declaration. Struct/enum declarations carry a `tag_invoke` overload
 * pair (`value_from_tag`/`value_to_tag<T>`) — Boost.JSON's ADL customization
 * point, found the same way nlohmann's `to_json`/`from_json` are, but named
 * differently and dispatched through a tag type instead of an overload set.
 *
 * An `object`/`enum`/`interface` root becomes a named `struct`/`enum class`/
 * class declaration named `name` (default `"Root"`); any other root kind
 * becomes a `using name = ...;` alias over the computed type expression.
 */
export function toBoostJson(ref: TypeRef, name = "Root"): string {
  const ctx: Ctx = { headers: new Set(), decls: [], declaredNames: new Set() }
  const isNamedDecl = ref.shape.kind === "object" || ref.shape.kind === "enum" || ref.shape.kind === "interface"
  const typeExpr = bjType(ref, ctx, name)
  const body = isNamedDecl ? ctx.decls.join("\n\n") : [...ctx.decls, `using ${name} = ${typeExpr};`].join("\n\n")
  const headerLines = [...ctx.headers].sort().map((header) => `#include ${header}`)
  return [...headerLines, "", body].join("\n").trimEnd() + "\n"
}
