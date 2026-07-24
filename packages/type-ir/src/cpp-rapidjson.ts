import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// packages/type-ir/src/cpp-rapidjson.ts — @rhi-zone/fractal-type-ir/cpp-rapidjson
//
// TypeRef -> C++17 struct/enum-class declarations with RapidJSON
// (https://github.com/Tencent/rapidjson) serialization support. Unlike
// cpp-nlohmann.ts's target library, RapidJSON has no ADL-based generic
// serialization (no `to_json`/`from_json` free-function dispatch nlohmann's
// adl_serializer picks up automatically for std::vector/std::optional/
// std::map/nested types) — every conversion has to be spelled out by hand
// against RapidJSON's Document/Value API (`AddMember`, `GetString`, `SetObject`,
// …). So alongside the same type-position mapping (`rjType`, structurally
// identical to cpp-nlohmann.ts's `cppType`) this file carries a second,
// expression-position generator (`rjToJson`/`rjFromJson`) that recursively
// builds a single C++ expression per field — nested containers become
// immediately-invoked lambdas (`[&]{ ...; return result; }()`) so a loop or
// multi-statement body can still compose as one expression, the same trick
// used to keep AddMember/emplace calls inline instead of hoisting temporaries.
// A `rapidjson::Document` (not `rapidjson::Value`) is the degrade target for
// `unknown` specifically because it owns its own allocator — a bare Value
// can't safely outlive the Document::AllocatorType it was built with once
// copied into a struct field.
//
// `union`'s degrade is lossier here than cpp-nlohmann.ts's std::variant<...>
// type mapping alone: RapidJSON carries no discriminator, so serializing a
// union field requires runtime dispatch over the *currently held* alternative
// (std::visit + `if constexpr`) and deserializing requires probing the JSON
// value's RapidJSON-reported shape (IsString/IsBool/IsArray/IsObject/IsNumber)
// against each alternative in declaration order, first match wins — a
// heuristic, not a guarantee, same honesty-about-lossy-degrade spirit as
// cpp-nlohmann.ts's `intersection` (first-member) fallback.

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
// matching/ancestor handler). rapidjson::Document (not rapidjson::Value) so
// the field owns its own allocator — see file-level doc comment.
function fallback(ctx: Ctx): string {
  ctx.headers.add("<rapidjson/document.h>")
  return "rapidjson::Document"
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
  ctx.headers.add("<rapidjson/document.h>")

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
  lines.push(
    `inline rapidjson::Value toJson(${name} value, rapidjson::Document::AllocatorType& allocator) {`,
  )
  lines.push(`  return rapidjson::Value(toString(value).c_str(), allocator);`)
  lines.push(`}`)
  lines.push("")
  lines.push(`inline ${name} ${lowerFirst(name)}FromJson(const rapidjson::Value& v) {`)
  lines.push(`  return ${lowerFirst(name)}FromString(std::string(v.GetString(), v.GetStringLength()));`)
  lines.push(`}`)
  ctx.decls.push(lines.join("\n"))
  return name
}

// Predicate string testing whether a rapidjson::Value (`expr`) holds the
// runtime shape `ref` would serialize to — used only for union-member
// deserialization dispatch (see file-level doc comment).
function rjIsCheck(ref: TypeRef, expr: string): string {
  const kind = ref.shape.kind
  switch (kind) {
    case "boolean":
      return `${expr}.IsBool()`
    case "string":
    case "uuid":
    case "uri":
    case "email":
    case "time":
    case "duration":
    case "enum":
      return `${expr}.IsString()`
    case "array":
    case "stream":
    case "page":
    case "tuple":
    case "bytes":
      return `${expr}.IsArray()`
    case "map":
    case "object":
    case "instance":
    case "ref":
      return `${expr}.IsObject()`
    case "null":
      return `${expr}.IsNull()`
    case "number":
    case "float32":
    case "float64":
    case "integer":
    case "int8":
    case "int16":
    case "int32":
    case "int64":
    case "uint8":
    case "uint16":
    case "uint32":
    case "uint64":
      return `${expr}.IsNumber()`
    default:
      return "true"
  }
}

function rjToJsonBase(ref: TypeRef, expr: string, ctx: Ctx, hint: string): string {
  const shape = ref.shape
  switch (shape.kind) {
    case "boolean":
      return `rapidjson::Value(${expr})`
    case "number":
    case "float64":
      return `rapidjson::Value(${expr})`
    case "float32":
      return `rapidjson::Value(${expr})`
    case "integer":
    case "int64":
      return `rapidjson::Value(static_cast<int64_t>(${expr}))`
    case "int8":
    case "int16":
    case "int32":
      return `rapidjson::Value(static_cast<int32_t>(${expr}))`
    case "uint8":
    case "uint16":
    case "uint32":
      return `rapidjson::Value(static_cast<unsigned>(${expr}))`
    case "uint64":
      return `rapidjson::Value(static_cast<uint64_t>(${expr}))`
    case "string":
    case "uuid":
    case "uri":
    case "email":
    case "time":
    case "duration":
      return `rapidjson::Value(${expr}.c_str(), allocator)`
    case "bytes":
      return (
        `[&]{ rapidjson::Value arr(rapidjson::kArrayType); ` +
        `for (uint8_t byte : ${expr}) arr.PushBack(rapidjson::Value(static_cast<unsigned>(byte)), allocator); ` +
        `return arr; }()`
      )
    case "null":
    case "void":
    case "never":
      return `rapidjson::Value(rapidjson::kNullType)`
    case "unknown": {
      fallback(ctx)
      return `[&]{ rapidjson::Value copy; copy.CopyFrom(${expr}, allocator); return copy; }()`
    }
    case "instance":
    case "ref":
      return `${expr}.toJson(allocator)`
    case "array":
    case "stream":
    case "page": {
      const s = shape as TypeShape & { kind: "array" | "stream" | "page"; element: TypeRef }
      return (
        `[&]{ rapidjson::Value arr(rapidjson::kArrayType); ` +
        `for (const auto& item : ${expr}) arr.PushBack(${rjToJson(s.element, "item", ctx, hint)}, allocator); ` +
        `return arr; }()`
      )
    }
    case "tuple": {
      const s = shape as TypeShape & { kind: "tuple" }
      const pushes = s.elements
        .map((e, i) => `arr.PushBack(${rjToJson(e, `std::get<${i}>(${expr})`, ctx, hint)}, allocator);`)
        .join(" ")
      return `[&]{ rapidjson::Value arr(rapidjson::kArrayType); ${pushes} return arr; }()`
    }
    case "map": {
      const s = shape as TypeShape & { kind: "map"; key: TypeRef; value: TypeRef }
      return (
        `[&]{ rapidjson::Value obj(rapidjson::kObjectType); ` +
        `for (const auto& [key, val] : ${expr}) obj.AddMember(rapidjson::Value(key.c_str(), allocator), ${rjToJson(s.value, "val", ctx, hint)}, allocator); ` +
        `return obj; }()`
      )
    }
    case "union": {
      const s = shape as TypeShape & { kind: "union" }
      const branches = s.variants
        .map((v, i) => {
          const altType = rjType(v, ctx, `${hint}Variant${i}`)
          const body = rjToJson(v, "v", ctx, hint)
          return `if constexpr (std::is_same_v<T_, ${altType}>) { return ${body}; }`
        })
        .join(" else ")
      ctx.headers.add("<type_traits>")
      ctx.headers.add("<variant>")
      return (
        `std::visit([&](const auto& v) -> rapidjson::Value { using T_ = std::decay_t<decltype(v)>; ` +
        `${branches} else { return rapidjson::Value(rapidjson::kNullType); } }, ${expr})`
      )
    }
    case "literal": {
      const s = shape as TypeShape & { kind: "literal" }
      if (s.value === null) return `rapidjson::Value(rapidjson::kNullType)`
      if (typeof s.value === "string") return `rapidjson::Value(${quote(s.value)}, allocator)`
      if (typeof s.value === "boolean") return `rapidjson::Value(${s.value})`
      return `rapidjson::Value(${Number.isInteger(s.value) ? `static_cast<int64_t>(${s.value})` : s.value})`
    }
    case "enum": {
      const s = shape as TypeShape & { kind: "enum" }
      emitEnumDecl(hint, s.members, ctx, undefined)
      return `toJson(${expr}, allocator)`
    }
    case "object":
      return `${expr}.toJson(allocator)`
    case "interface":
    case "function":
    case "method":
      return `rapidjson::Value(rapidjson::kNullType)`
    case "intersection": {
      const s = shape as TypeShape & { kind: "intersection" }
      const [first] = s.members
      return first === undefined ? `rapidjson::Value(rapidjson::kNullType)` : rjToJson(first, expr, ctx, hint)
    }
    default:
      return `rapidjson::Value(rapidjson::kNullType)`
  }
}

function rjToJson(ref: TypeRef, expr: string, ctx: Ctx, hint: string): string {
  if (ref.meta.optional === true || ref.meta.nullable === true) {
    return `(${expr}.has_value() ? ${rjToJsonBase(ref, `(*${expr})`, ctx, hint)} : rapidjson::Value(rapidjson::kNullType))`
  }
  return rjToJsonBase(ref, expr, ctx, hint)
}

function rjFromJsonBase(ref: TypeRef, expr: string, ctx: Ctx, hint: string): string {
  const shape = ref.shape
  switch (shape.kind) {
    case "boolean":
      return `${expr}.GetBool()`
    case "number":
    case "float64":
      return `${expr}.GetDouble()`
    case "float32":
      return `${expr}.GetFloat()`
    case "integer":
    case "int64":
      return `${expr}.GetInt64()`
    case "int8":
      return `static_cast<int8_t>(${expr}.GetInt())`
    case "int16":
      return `static_cast<int16_t>(${expr}.GetInt())`
    case "int32":
      return `${expr}.GetInt()`
    case "uint8":
      return `static_cast<uint8_t>(${expr}.GetUint())`
    case "uint16":
      return `static_cast<uint16_t>(${expr}.GetUint())`
    case "uint32":
      return `${expr}.GetUint()`
    case "uint64":
      return `${expr}.GetUint64()`
    case "string":
    case "uuid":
    case "uri":
    case "email":
    case "time":
    case "duration":
      return `std::string(${expr}.GetString(), ${expr}.GetStringLength())`
    case "bytes": {
      ctx.headers.add("<vector>")
      ctx.headers.add("<cstdint>")
      return (
        `[&]{ std::vector<uint8_t> result; for (const auto& item : ${expr}.GetArray()) ` +
        `result.push_back(static_cast<uint8_t>(item.GetUint())); return result; }()`
      )
    }
    case "null":
      return `nullptr`
    case "void":
    case "never":
      return `{}`
    case "unknown": {
      fallback(ctx)
      return `[&]{ rapidjson::Document doc; doc.CopyFrom(${expr}, doc.GetAllocator()); return doc; }()`
    }
    case "instance":
    case "ref": {
      const name = shape.kind === "instance" ? (shape as TypeShape & { kind: "instance" }).className : (shape as TypeShape & { kind: "ref" }).target
      return `${name}::fromJson(${expr})`
    }
    case "array":
    case "stream":
    case "page": {
      const s = shape as TypeShape & { kind: "array" | "stream" | "page"; element: TypeRef }
      const containerType = rjType(ref, ctx, hint)
      return (
        `[&]{ ${containerType} result; for (const auto& item : ${expr}.GetArray()) ` +
        `result.push_back(${rjFromJson(s.element, "item", ctx, hint)}); return result; }()`
      )
    }
    case "tuple": {
      const s = shape as TypeShape & { kind: "tuple" }
      const elems = s.elements.map((e, i) => rjFromJson(e, `arr[${i}]`, ctx, hint)).join(", ")
      return `[&]{ const auto& arr = ${expr}.GetArray(); return std::make_tuple(${elems}); }()`
    }
    case "map": {
      const s = shape as TypeShape & { kind: "map"; key: TypeRef; value: TypeRef }
      const containerType = rjType(ref, ctx, hint)
      return (
        `[&]{ ${containerType} result; for (auto it = ${expr}.MemberBegin(); it != ${expr}.MemberEnd(); ++it) ` +
        `result.emplace(std::string(it->name.GetString(), it->name.GetStringLength()), ${rjFromJson(s.value, "it->value", ctx, hint)}); return result; }()`
      )
    }
    case "union": {
      const s = shape as TypeShape & { kind: "union" }
      const variantType = rjType(ref, ctx, hint)
      const checks = s.variants
        .map((v) => `if (${rjIsCheck(v, expr)}) return ${variantType}{${rjFromJson(v, expr, ctx, hint)}};`)
        .join(" ")
      return `[&]() -> ${variantType} { ${checks} throw std::invalid_argument("no matching variant for ${hint}"); }()`
    }
    case "literal": {
      const s = shape as TypeShape & { kind: "literal" }
      if (s.value === null) return "nullptr"
      if (typeof s.value === "string") return quote(s.value)
      if (typeof s.value === "boolean") return String(s.value)
      return String(s.value)
    }
    case "enum": {
      const s = shape as TypeShape & { kind: "enum" }
      emitEnumDecl(hint, s.members, ctx, undefined)
      return `${lowerFirst(hint)}FromJson(${expr})`
    }
    case "object":
      return `${rjType(ref, ctx, hint)}::fromJson(${expr})`
    case "interface":
    case "function":
    case "method":
      return `{}`
    case "intersection": {
      const s = shape as TypeShape & { kind: "intersection" }
      const [first] = s.members
      return first === undefined ? `{}` : rjFromJson(first, expr, ctx, hint)
    }
    default:
      return `{}`
  }
}

function rjFromJson(ref: TypeRef, expr: string, ctx: Ctx, hint: string): string {
  return rjFromJsonBase(ref, expr, ctx, hint)
}

function emitStructDecl(
  name: string,
  fields: Readonly<Record<string, TypeRef>>,
  ctx: Ctx,
  description?: string,
): string {
  if (ctx.declaredNames.has(name)) return name
  ctx.declaredNames.add(name)
  ctx.headers.add("<rapidjson/document.h>")

  const fieldNames = Object.keys(fields)
  const memberLines = fieldNames.map((fieldName) => {
    const fieldRef = fields[fieldName]!
    const type = rjType(fieldRef, ctx, pascalCase(fieldName))
    return `  ${type} ${fieldName};`
  })

  const toJsonLines = fieldNames.map((fieldName) => {
    const fieldRef = fields[fieldName]!
    return `    v.AddMember(${quote(fieldName)}, ${rjToJson(fieldRef, fieldName, ctx, pascalCase(fieldName))}, allocator);`
  })

  const fromJsonLines = fieldNames.map((fieldName) => {
    const fieldRef = fields[fieldName]!
    const isOptional = fieldRef.meta.optional === true || fieldRef.meta.nullable === true
    const access = `v[${quote(fieldName)}]`
    if (isOptional) {
      ctx.headers.add("<optional>")
      const inner = rjFromJsonBase(fieldRef, access, ctx, pascalCase(fieldName))
      return `    result.${fieldName} = v.HasMember(${quote(fieldName)}) && !${access}.IsNull() ? std::make_optional(${inner}) : std::nullopt;`
    }
    return `    result.${fieldName} = ${rjFromJson(fieldRef, access, ctx, pascalCase(fieldName))};`
  })

  const lines: string[] = []
  if (description !== undefined) lines.push(`// ${description}`)
  lines.push(`struct ${name} {`)
  lines.push(...memberLines)
  lines.push("")
  lines.push(`  rapidjson::Value toJson(rapidjson::Document::AllocatorType& allocator) const {`)
  lines.push(`    rapidjson::Value v(rapidjson::kObjectType);`)
  lines.push(...toJsonLines)
  lines.push(`    return v;`)
  lines.push(`  }`)
  lines.push("")
  lines.push(`  static ${name} fromJson(const rapidjson::Value& v) {`)
  lines.push(`    ${name} result;`)
  lines.push(...fromJsonLines)
  lines.push(`    return result;`)
  lines.push(`  }`)
  lines.push(`};`)
  ctx.decls.push(lines.join("\n"))
  return name
}

// `interface`'s methods have no data-field analogue (see index.ts's
// TypeKinds.interface doc comment) — the closest native C++ construct is an
// abstract base class of pure-virtual methods, one per interface method.
// Same rendering as cpp-nlohmann.ts's emitInterfaceDecl, since a method
// surface has no serialization concern either way.
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
    const params = m.params.map((p) => `${rjType(p.type, ctx, pascalCase(p.name))} ${p.name}`)
    const ret = rjType(m.returnType, ctx, `${pascalCase(methodName)}Result`)
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
    return `std::vector<${rjType(s.element, ctx, hint)}>`
  },
  stream: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "stream" }
    ctx.headers.add("<vector>")
    return `std::vector<${rjType(s.element, ctx, hint)}>`
  },
  page: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "page" }
    ctx.headers.add("<vector>")
    return `std::vector<${rjType(s.element, ctx, hint)}>`
  },
  tuple: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "tuple" }
    ctx.headers.add("<tuple>")
    return `std::tuple<${s.elements.map((e) => rjType(e, ctx, hint)).join(", ")}>`
  },
  map: (shape, meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "map" }
    const key = rjType(s.key, ctx, hint)
    const value = rjType(s.value, ctx, hint)
    const unordered = meta.unordered === true
    ctx.headers.add(unordered ? "<unordered_map>" : "<map>")
    return `${unordered ? "std::unordered_map" : "std::map"}<${key}, ${value}>`
  },
  union: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "union" }
    ctx.headers.add("<variant>")
    return `std::variant<${s.variants.map((v) => rjType(v, ctx, hint)).join(", ")}>`
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
    return first === undefined ? fallback(ctx) : rjType(first, ctx, hint)
  },
  function: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "function" }
    ctx.headers.add("<functional>")
    const params = s.params.map((p) => rjType(p.type, ctx, pascalCase(p.name)))
    const ret = rjType(s.returnType, ctx, `${hint}Result`)
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

function rjType(ref: TypeRef, ctx: Ctx, hint: string): string {
  const converter = resolve(ref.shape.kind, handlers)
  let type = converter === undefined ? fallback(ctx) : converter(ref.shape, ref.meta, ctx, hint)
  if (ref.meta.optional === true || ref.meta.nullable === true) {
    ctx.headers.add("<optional>")
    type = `std::optional<${type}>`
  }
  return type
}

/**
 * Lower a `TypeRef` to a C++17 header-shaped string targeting RapidJSON:
 * `#include` directives, every named declaration the tree required (nested
 * object/enum fields hoisted to their own top-level struct/enum class, in
 * dependency order — see the file-level doc comment), then the root type's
 * own declaration. Struct declarations carry hand-generated `toJson`/
 * `fromJson` member functions (RapidJSON has no generic ADL-based
 * serialization to lean on the way cpp-nlohmann.ts's NLOHMANN_DEFINE_TYPE_
 * INTRUSIVE does); enum declarations carry free-function `toJson`/
 * `<lowerName>FromJson` counterparts to `toString`/`<lowerName>FromString`.
 *
 * An `object`/`enum`/`interface` root becomes a named `struct`/`enum class`/
 * class declaration named `name` (default `"Root"`); any other root kind
 * becomes a `using name = ...;` alias over the computed type expression.
 */
export function toRapidjson(ref: TypeRef, name = "Root"): string {
  const ctx: Ctx = { headers: new Set(), decls: [], declaredNames: new Set() }
  const isNamedDecl = ref.shape.kind === "object" || ref.shape.kind === "enum" || ref.shape.kind === "interface"
  const typeExpr = rjType(ref, ctx, name)
  const body = isNamedDecl ? ctx.decls.join("\n\n") : [...ctx.decls, `using ${name} = ${typeExpr};`].join("\n\n")
  const headerLines = [...ctx.headers].sort().map((header) => `#include ${header}`)
  return [...headerLines, "", body].join("\n").trimEnd() + "\n"
}
