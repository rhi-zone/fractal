import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// packages/type-ir/src/cpp-simdjson.ts — @rhi-zone/fractal-type-ir/cpp-simdjson
//
// TypeRef -> C++17 struct/enum-class declarations with simdjson
// (https://github.com/simdjson/simdjson) DOM-API *deserialization* support
// only. simdjson's dom API is read-only by design (it's a parser, not a
// serialization library — there's no `dom::element` you build up and write
// back out), so unlike cpp-nlohmann.ts/cpp-rapidjson.ts this file emits only
// `fromJson(simdjson::dom::element)` — no `toJson` counterpart exists for
// any declaration here. Same type-position mapping shape as those two
// (`sjType`, structurally identical to cpp-nlohmann.ts's `cppType`) plus one
// expression-position generator (`sjFromJson`) that recursively builds a
// single C++ expression per field, same immediately-invoked-lambda trick
// cpp-rapidjson.ts uses to keep a loop body composable as one expression.
//
// simdjson's `element.get<T>()` throws (via simdjson_result's implicit
// conversion) on a type mismatch or a missing field access — the generated
// code leans on that instead of hand-rolled presence checks wherever
// possible, except for optional/nullable struct fields, which still need an
// explicit "is this field present at all" probe (`element[name].error()`)
// since a missing field and a type-mismatched field aren't the same failure
// mode simdjson's error codes distinguish.
//
// `unknown` degrades to `simdjson::dom::element` itself — simdjson's own
// "arbitrary JSON value" handle, the same role nlohmann::json/rapidjson::
// Document play as fallback targets in their respective sibling files.

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
  ctx.headers.add("<simdjson.h>")
  return "simdjson::dom::element"
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
  ctx.headers.add("<simdjson.h>")

  const enumerators = members.map(pascalCase)
  const lines: string[] = []
  if (description !== undefined) lines.push(`// ${description}`)
  lines.push(`enum class ${name} {`)
  lines.push(enumerators.map((e) => `  ${e},`).join("\n"))
  lines.push(`};`)
  lines.push("")
  lines.push(`inline ${name} ${lowerFirst(name)}FromString(std::string_view value) {`)
  for (const [i, member] of members.entries()) {
    lines.push(`  if (value == ${quote(member)}) return ${name}::${enumerators[i]};`)
  }
  lines.push(`  throw std::invalid_argument("invalid ${name}");`)
  lines.push(`}`)
  lines.push("")
  lines.push(`inline ${name} ${lowerFirst(name)}FromJson(simdjson::dom::element element) {`)
  lines.push(`  return ${lowerFirst(name)}FromString(std::string_view(element.get_string().value()));`)
  lines.push(`}`)
  ctx.decls.push(lines.join("\n"))
  return name
}

function sjFromJsonBase(ref: TypeRef, expr: string, ctx: Ctx, hint: string): string {
  const shape = ref.shape
  switch (shape.kind) {
    case "boolean":
      return `${expr}.get_bool().value()`
    case "number":
    case "float64":
    case "float32":
      return `${expr}.get_double().value()`
    case "integer":
    case "int64":
    case "int8":
    case "int16":
    case "int32":
      return `${expr}.get_int64().value()`
    case "uint8":
    case "uint16":
    case "uint32":
    case "uint64":
      return `${expr}.get_uint64().value()`
    case "string":
    case "uuid":
    case "uri":
    case "email":
    case "time":
    case "duration":
      return `std::string(${expr}.get_string().value())`
    case "bytes":
      return (
        `[&]{ std::vector<uint8_t> result; for (simdjson::dom::element item : ${expr}.get_array()) ` +
        `result.push_back(static_cast<uint8_t>(item.get_uint64().value())); return result; }()`
      )
    case "null":
      return `nullptr`
    case "void":
    case "never":
      return `{}`
    case "unknown":
      return expr
    case "instance":
    case "ref": {
      const name =
        shape.kind === "instance"
          ? (shape as TypeShape & { kind: "instance" }).className
          : (shape as TypeShape & { kind: "ref" }).target
      return `${name}::fromJson(${expr})`
    }
    case "array":
    case "stream":
    case "page": {
      const s = shape as TypeShape & { kind: "array" | "stream" | "page"; element: TypeRef }
      const containerType = sjType(ref, ctx, hint)
      return (
        `[&]{ ${containerType} result; for (simdjson::dom::element item : ${expr}.get_array()) ` +
        `result.push_back(${sjFromJson(s.element, "item", ctx, hint)}); return result; }()`
      )
    }
    case "tuple": {
      const s = shape as TypeShape & { kind: "tuple" }
      const elems = s.elements.map((e, i) => sjFromJson(e, `arr.at(${i})`, ctx, hint)).join(", ")
      return `[&]{ simdjson::dom::array arr = ${expr}.get_array(); return std::make_tuple(${elems}); }()`
    }
    case "map": {
      const s = shape as TypeShape & { kind: "map"; key: TypeRef; value: TypeRef }
      const containerType = sjType(ref, ctx, hint)
      return (
        `[&]{ ${containerType} result; for (simdjson::dom::key_value_pair field : ${expr}.get_object()) ` +
        `result.emplace(std::string(field.key), ${sjFromJson(s.value, "field.value", ctx, hint)}); return result; }()`
      )
    }
    case "union": {
      const s = shape as TypeShape & { kind: "union" }
      const variantType = sjType(ref, ctx, hint)
      const checks = s.variants
        .map((v) => `if (${sjIsCheck(v, expr)}) return ${variantType}{${sjFromJson(v, expr, ctx, hint)}};`)
        .join(" ")
      return `[&]() -> ${variantType} { ${checks} throw std::invalid_argument("no matching variant for ${hint}"); }()`
    }
    case "literal": {
      const s = shape as TypeShape & { kind: "literal" }
      if (s.value === null) return "nullptr"
      if (typeof s.value === "string") return quote(s.value)
      return String(s.value)
    }
    case "enum": {
      const s = shape as TypeShape & { kind: "enum" }
      emitEnumDecl(hint, s.members, ctx, undefined)
      return `${lowerFirst(hint)}FromJson(${expr})`
    }
    case "object":
      return `${sjType(ref, ctx, hint)}::fromJson(${expr})`
    case "interface":
    case "function":
    case "method":
      return `{}`
    case "intersection": {
      const s = shape as TypeShape & { kind: "intersection" }
      const [first] = s.members
      return first === undefined ? `{}` : sjFromJson(first, expr, ctx, hint)
    }
    default:
      return `{}`
  }
}

function sjFromJson(ref: TypeRef, expr: string, ctx: Ctx, hint: string): string {
  return sjFromJsonBase(ref, expr, ctx, hint)
}

// Predicate probing whether a simdjson::dom::element (`expr`) holds the
// runtime shape `ref` decodes from — used only for union-member
// deserialization dispatch, same "first structural match wins" heuristic as
// cpp-rapidjson.ts's rjIsCheck.
function sjIsCheck(ref: TypeRef, expr: string): string {
  const kind = ref.shape.kind
  switch (kind) {
    case "boolean":
      return `${expr}.is_bool()`
    case "string":
    case "uuid":
    case "uri":
    case "email":
    case "time":
    case "duration":
    case "enum":
      return `${expr}.is_string()`
    case "array":
    case "stream":
    case "page":
    case "tuple":
    case "bytes":
      return `${expr}.is_array()`
    case "map":
    case "object":
    case "instance":
    case "ref":
      return `${expr}.is_object()`
    case "null":
      return `${expr}.is_null()`
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
      return `${expr}.is_number()`
    default:
      return "true"
  }
}

function emitStructDecl(
  name: string,
  fields: Readonly<Record<string, TypeRef>>,
  ctx: Ctx,
  description?: string,
): string {
  if (ctx.declaredNames.has(name)) return name
  ctx.declaredNames.add(name)
  ctx.headers.add("<simdjson.h>")

  const fieldNames = Object.keys(fields)
  const memberLines = fieldNames.map((fieldName) => {
    const fieldRef = fields[fieldName]!
    const type = sjType(fieldRef, ctx, pascalCase(fieldName))
    return `  ${type} ${fieldName};`
  })

  const fromJsonLines = fieldNames.map((fieldName) => {
    const fieldRef = fields[fieldName]!
    const isOptional = fieldRef.meta.optional === true || fieldRef.meta.nullable === true
    if (isOptional) {
      ctx.headers.add("<optional>")
      const probe = `element[${quote(fieldName)}]`
      const inner = sjFromJsonBase(fieldRef, `${probe}.value()`, ctx, pascalCase(fieldName))
      return `    result.${fieldName} = ${probe}.error() == simdjson::SUCCESS ? std::make_optional(${inner}) : std::nullopt;`
    }
    return `    result.${fieldName} = ${sjFromJson(fieldRef, `element[${quote(fieldName)}]`, ctx, pascalCase(fieldName))};`
  })

  const lines: string[] = []
  if (description !== undefined) lines.push(`// ${description}`)
  lines.push(`struct ${name} {`)
  lines.push(...memberLines)
  lines.push("")
  lines.push(`  static ${name} fromJson(simdjson::dom::element element) {`)
  lines.push(`    ${name} result;`)
  lines.push(...fromJsonLines)
  lines.push(`    return result;`)
  lines.push(`  }`)
  lines.push(`};`)
  ctx.decls.push(lines.join("\n"))
  return name
}

// `interface`'s methods have no data-field analogue — same abstract-class
// rendering cpp-nlohmann.ts/cpp-rapidjson.ts use, since a method surface has
// nothing simdjson's read-only DOM API would ever decode.
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
    const params = m.params.map((p) => `${sjType(p.type, ctx, pascalCase(p.name))} ${p.name}`)
    const ret = sjType(m.returnType, ctx, `${pascalCase(methodName)}Result`)
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
    return `std::vector<${sjType(s.element, ctx, hint)}>`
  },
  stream: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "stream" }
    ctx.headers.add("<vector>")
    return `std::vector<${sjType(s.element, ctx, hint)}>`
  },
  page: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "page" }
    ctx.headers.add("<vector>")
    return `std::vector<${sjType(s.element, ctx, hint)}>`
  },
  tuple: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "tuple" }
    ctx.headers.add("<tuple>")
    return `std::tuple<${s.elements.map((e) => sjType(e, ctx, hint)).join(", ")}>`
  },
  map: (shape, meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "map" }
    const key = sjType(s.key, ctx, hint)
    const value = sjType(s.value, ctx, hint)
    const unordered = meta.unordered === true
    ctx.headers.add(unordered ? "<unordered_map>" : "<map>")
    return `${unordered ? "std::unordered_map" : "std::map"}<${key}, ${value}>`
  },
  union: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "union" }
    ctx.headers.add("<variant>")
    return `std::variant<${s.variants.map((v) => sjType(v, ctx, hint)).join(", ")}>`
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
    return first === undefined ? fallback(ctx) : sjType(first, ctx, hint)
  },
  function: (shape, _meta, ctx, hint) => {
    const s = shape as TypeShape & { kind: "function" }
    ctx.headers.add("<functional>")
    const params = s.params.map((p) => sjType(p.type, ctx, pascalCase(p.name)))
    const ret = sjType(s.returnType, ctx, `${hint}Result`)
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

function sjType(ref: TypeRef, ctx: Ctx, hint: string): string {
  const converter = resolve(ref.shape.kind, handlers)
  let type = converter === undefined ? fallback(ctx) : converter(ref.shape, ref.meta, ctx, hint)
  if (ref.meta.optional === true || ref.meta.nullable === true) {
    ctx.headers.add("<optional>")
    type = `std::optional<${type}>`
  }
  return type
}

/**
 * Lower a `TypeRef` to a C++17 header-shaped string targeting simdjson's DOM
 * API: `#include` directives, every named declaration the tree required
 * (nested object/enum fields hoisted to their own top-level struct/enum
 * class, in dependency order — see the file-level doc comment), then the
 * root type's own declaration. Struct/enum declarations carry only a
 * `fromJson`/`<lowerName>FromJson` static/free function — simdjson's dom API
 * has no write path, so there is no `toJson` counterpart anywhere in the
 * output (see file-level doc comment).
 *
 * An `object`/`enum`/`interface` root becomes a named `struct`/`enum class`/
 * class declaration named `name` (default `"Root"`); any other root kind
 * becomes a `using name = ...;` alias over the computed type expression.
 */
export function toSimdjson(ref: TypeRef, name = "Root"): string {
  const ctx: Ctx = { headers: new Set(), decls: [], declaredNames: new Set() }
  const isNamedDecl = ref.shape.kind === "object" || ref.shape.kind === "enum" || ref.shape.kind === "interface"
  const typeExpr = sjType(ref, ctx, name)
  const body = isNamedDecl ? ctx.decls.join("\n\n") : [...ctx.decls, `using ${name} = ${typeExpr};`].join("\n\n")
  const headerLines = [...ctx.headers].sort().map((header) => `#include ${header}`)
  return [...headerLines, "", body].join("\n").trimEnd() + "\n"
}
