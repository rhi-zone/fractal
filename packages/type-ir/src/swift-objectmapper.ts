import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// packages/type-ir/src/swift-objectmapper.ts — @rhi-zone/fractal-type-ir/swift-objectmapper
//
// TypeRef -> idiomatic Swift types for ObjectMapper
// (https://github.com/tristanhimmelman/ObjectMapper): a struct/class opts
// into mapping by conforming to `Mappable` (`init?(map: Map)` +
// `mutating func mapping(map: Map)`) and wiring each property with the `<-`
// custom operator (`name <- map["name"]`), which — unlike swift-codable.ts's
// compiler-synthesized Codable conformance and swift-swiftyjson.ts's
// hand-written accessor calls — dispatches to the right bidirectional
// to/from-JSON transform purely from the property's static type (including,
// via ObjectMapper's own operator overloads, nested Mappable structs, arrays
// and dictionaries of Mappable values, and RawRepresentable enums). Required
// fields are declared implicitly-unwrapped (`T!`) rather than given an
// arbitrary IR-invented default value — the conventional ObjectMapper
// pattern for "no sensible zero value, but `init?(map:)`'s body must
// construct something before `mapping(map:)` runs" — while optional/nullable
// fields are plain `T?`, matching `<-`'s own optional-property overload.

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1)
}

function toCamelCase(name: string): string {
  const camel = name.replace(/[-_\s]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))
  return camel.length === 0 ? camel : camel[0]!.toLowerCase() + camel.slice(1)
}

function swiftIdentifier(name: string): string {
  let ident = toCamelCase(name).replace(/[^A-Za-z0-9_]/g, "")
  if (ident.length === 0) ident = "_"
  if (/^[0-9]/.test(ident)) ident = `_${ident}`
  return ident
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function indent(text: string, spaces: number): string[] {
  const pad = " ".repeat(spaces)
  return text.split("\n").map((line) => (line.length === 0 ? line : `${pad}${line}`))
}

// Every leaf/primitive kind's underlying Swift property type — ObjectMapper
// reads/writes these through `<-`'s built-in transforms, so (unlike
// swift-swiftyjson.ts, which needs a matching accessor-method name per kind)
// no per-kind mapping-side metadata is needed here beyond the type itself.
// Same primitive vocabulary swift-codable.ts covers.
const primitiveHandlers: Record<string, string> = {
  boolean: "Bool",
  string: "String",
  number: "Double",
  integer: "Int",
  int8: "Int8",
  int16: "Int16",
  int32: "Int32",
  int64: "Int64",
  uint8: "UInt8",
  uint16: "UInt16",
  uint32: "UInt32",
  uint64: "UInt64",
  float32: "Float",
  float64: "Double",
  uuid: "String",
  uri: "String",
  email: "String",
  // ObjectMapper's built-in transforms don't include a Date parser out of
  // the box (only via the optional DateTransform() add-on, which needs a
  // format string this IR doesn't carry) — degrades honestly to String,
  // same convention swift-swiftyjson.ts uses for the same reason.
  datetime: "String",
  date: "String",
  time: "String",
  duration: "String",
  // Likewise no built-in base64 Data transform — degrades to the raw
  // base64 String, caller decodes.
  bytes: "String",
  null: "Any",
  void: "Any",
  unknown: "Any",
  never: "Any",
}

interface Ctx {
  nested: string[]
}

/**
 * The Swift type expression for `ref` in a field/element/key/value
 * position, with a plain `?` suffix for optional/nullable — same shape as
 * swift-codable.ts's/swift-swiftyjson.ts's own `fieldType`/`swiftType`. This
 * does NOT decide `T!` vs `T` — that implicitly-unwrapped-vs-bare choice is
 * a struct-*property*-declaration concern (see `propertyType` below), not a
 * property of the type itself: an array's element type or a tuple's member
 * type must stay a clean `T`/`T?`, never `T!` — nesting an implicitly
 * -unwrapped optional inside `[...]`/`(...)` is both needless (the
 * container itself is what's left uninitialized before `mapping(map:)`
 * runs, not each element) and produces the discouraged `[T!]` array-of
 * -IUO spelling. `hint` names a nested declaration if `ref` needs one
 * (object/enum/union with no `meta.typeName` of its own), matching
 * swift-codable.ts's/swift-swiftyjson.ts's own hint-naming convention.
 */
function fieldType(ref: TypeRef, hint: string, ctx: Ctx): string {
  const kind = ref.shape.kind
  let base: string

  if (kind === "object") {
    const name = typeof ref.meta.typeName === "string" ? ref.meta.typeName : capitalize(hint)
    ctx.nested.push(structDecl(name, ref))
    base = name
  } else if (kind === "enum") {
    const name = typeof ref.meta.typeName === "string" ? ref.meta.typeName : capitalize(hint)
    ctx.nested.push(enumDecl(name, ref))
    base = name
  } else if (kind === "union") {
    const name = typeof ref.meta.typeName === "string" ? ref.meta.typeName : capitalize(hint)
    ctx.nested.push(unionDecl(name, ref))
    base = name
  } else if (kind === "array" || kind === "stream" || kind === "page") {
    // No native ObjectMapper streaming/pagination-window transform —
    // degrades honestly to an array of the element type, same convention
    // swift-codable.ts uses for `stream`/`page`. ObjectMapper's `<-` maps a
    // `[T]` property transparently as long as `T` is itself Mappable or a
    // basic type.
    const s = ref.shape as TypeShape & { element: TypeRef }
    base = `[${fieldType(s.element, `${hint}Element`, ctx)}]`
  } else if (kind === "map") {
    const s = ref.shape as TypeShape & { kind: "map" }
    // JSON object keys are always strings — ObjectMapper's dictionary
    // transform is keyed by String, same assumption swift-swiftyjson.ts's
    // `map` branch documents.
    base = `[String: ${fieldType(s.value, `${hint}Value`, ctx)}]`
  } else if (kind === "tuple") {
    // ObjectMapper's `<-` operator has no tuple overload — a Swift tuple
    // isn't itself Mappable/Transformable, so there's no built-in way to
    // wire one up. `mappingLine` below skips emitting a `<-` line for a
    // tuple-typed field and leaves a comment instead; the type is still
    // rendered here so the property declaration itself is honest about what
    // it holds.
    const s = ref.shape as TypeShape & { kind: "tuple" }
    base = `(${s.elements.map((element, i) => fieldType(element, `${hint}${i}`, ctx)).join(", ")})`
  } else if (kind === "ref") {
    base = capitalize((ref.shape as TypeShape & { kind: "ref" }).target)
  } else if (kind === "instance") {
    base = (ref.shape as TypeShape & { kind: "instance" }).className
  } else if (kind === "literal") {
    const s = ref.shape as TypeShape & { kind: "literal" }
    const value = s.value
    base =
      value === null
        ? "Any"
        : typeof value === "string"
          ? "String"
          : typeof value === "boolean"
            ? "Bool"
            : Number.isInteger(value)
              ? "Int"
              : "Double"
  } else if (kind === "intersection") {
    const s = ref.shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    base = first === undefined ? "Any" : fieldType(first, hint, ctx)
  } else {
    base = resolve(kind, primitiveHandlers) ?? "Any"
  }

  const optional = ref.meta.optional === true || ref.meta.nullable === true
  if (optional && !base.endsWith("?")) return `${base}?`
  return base
}

/** The struct-property spelling of `fieldType`'s result: implicitly
 * -unwrapped (`T!`) for a required field — the conventional ObjectMapper
 * pattern this file's header comment documents — or the plain `T?` `fieldType`
 * already produced for an optional/nullable one. Struct-property
 * declarations are the only place this file emits `!`; see `fieldType`'s
 * doc comment for why it doesn't happen recursively. */
function propertyType(ref: TypeRef, hint: string, ctx: Ctx): string {
  const type = fieldType(ref, hint, ctx)
  const optional = ref.meta.optional === true || ref.meta.nullable === true
  return optional ? type : `${type}!`
}

function docComment(ref: TypeRef): string[] {
  const description = typeof ref.meta.description === "string" ? ref.meta.description : undefined
  const deprecatedMessage = typeof ref.meta.deprecated === "string" ? ref.meta.deprecated : undefined
  const isDeprecated = ref.meta.deprecated === true || deprecatedMessage !== undefined
  const lines: string[] = []
  if (description !== undefined) lines.push(`/// ${description}`)
  if (isDeprecated) {
    lines.push(
      deprecatedMessage !== undefined
        ? `@available(*, deprecated, message: ${quote(deprecatedMessage)})`
        : "@available(*, deprecated)",
    )
  }
  return lines
}

/** The `<- map[...]` mapping line for one field, or a degrade comment for a
 * kind ObjectMapper's operator has no overload for (tuple — see fieldType's
 * `tuple` branch). Enum-typed fields lean on ObjectMapper's own
 * RawRepresentable operator overload (EnumOperators.swift) — no explicit
 * `EnumTransform()` needed for a plain String-backed enum. */
function mappingLine(fieldName: string, swiftName: string, fieldRef: TypeRef): string {
  if (fieldRef.shape.kind === "tuple") {
    return `        // ObjectMapper has no tuple transform — ${swiftName} is not wired to map[${quote(fieldName)}]; split into separate fields or provide a custom TransformType.`
  }
  return `        ${swiftName} <- map[${quote(fieldName)}]`
}

// `struct Name: Mappable { var field: T!; init?(map: Map) {}; mutating func
// mapping(map: Map) { field <- map["field"] } }` — the ObjectMapper analogue
// of swift-codable.ts's structDecl (Codable) and swift-swiftyjson.ts's
// structDecl (hand-written init(json:)). No CodingKeys-equivalent needed:
// the JSON key is simply the subscript literal used directly in `mapping`,
// same as swift-swiftyjson.ts.
function structDecl(name: string, ref: TypeRef): string {
  const s = ref.shape as TypeShape & { kind: "object" }
  const ctx: Ctx = { nested: [] }
  const propLines: string[] = []
  const mappingLines: string[] = []

  for (const [fieldName, fieldRef] of Object.entries(s.fields)) {
    const swiftName = swiftIdentifier(fieldName)
    const typeName = propertyType(fieldRef, capitalize(fieldName), ctx)
    propLines.push(`    var ${swiftName}: ${typeName}`)
    mappingLines.push(mappingLine(fieldName, swiftName, fieldRef))
  }

  const lines = [
    ...docComment(ref),
    `struct ${name}: Mappable {`,
    ...propLines,
    "",
    "    init?(map: Map) {}",
    "",
    "    mutating func mapping(map: Map) {",
    ...mappingLines,
    "    }",
  ]
  if (ctx.nested.length > 0) {
    lines.push("")
    for (const decl of ctx.nested) lines.push(...indent(decl, 4))
  }
  lines.push("}")
  return lines.join("\n")
}

function enumDecl(name: string, ref: TypeRef): string {
  const s = ref.shape as TypeShape & { kind: "enum" }
  const lines = [...docComment(ref), `enum ${name}: String, CaseIterable {`]
  for (const member of s.members) {
    const ident = swiftIdentifier(member)
    lines.push(ident === member ? `    case ${ident}` : `    case ${ident} = ${quote(member)}`)
  }
  lines.push("}")
  return lines.join("\n")
}

function variantCaseName(ref: TypeRef, index: number): string {
  if (typeof ref.meta.typeName === "string") return swiftIdentifier(ref.meta.typeName)
  const kind = ref.shape.kind
  if (kind === "ref") return swiftIdentifier((ref.shape as TypeShape & { kind: "ref" }).target)
  if (kind in primitiveHandlers) return swiftIdentifier(kind)
  return `variant${index + 1}`
}

// ObjectMapper's `Map` wraps a keyed JSON *object* — `Map.JSON` (see
// ObjectMapper's Map.swift) is typed `[String: Any]`, not `Any`, so there is
// no ObjectMapper-native way to even ask "is the value this Map wraps a bare
// string/number/bool/array" the way swift-codable.ts's
// `singleValueContainer()` probing or swift-swiftyjson.ts's `json.type`
// switch can. A plain (non-discriminated) union can therefore only resolve
// through ObjectMapper for its object-shaped (Mappable) variants — each
// tried in turn via that variant's own `init?(map:)` — while a scalar/array
// -shaped variant has no Map-native decode path at all and is left as a
// declared-but-unreachable case, flagged with a comment rather than
// papering over the gap with a cast that wouldn't type-check (`Map.JSON`
// can't be cast to `String`/`Int`/etc. — it's always a dictionary).
function plainUnionDecl(name: string, ref: TypeRef, variants: readonly TypeRef[]): string {
  const ctx: Ctx = { nested: [] }
  const cases = variants.map((variant, i) => ({
    caseName: variantCaseName(variant, i),
    typeName: fieldType(variant, capitalize(variantCaseName(variant, i)), ctx),
    isMappable: variant.shape.kind === "object" || variant.shape.kind === "union",
  }))

  const lines = [...docComment(ref), `enum ${name} {`]
  for (const c of cases) lines.push(`    case ${c.caseName}(${c.typeName})`)
  lines.push("", `    static func from(map: Map) -> ${name}? {`)
  const mappableCases = cases.filter((c) => c.isMappable)
  const unmappableCases = cases.filter((c) => !c.isMappable)
  for (const c of mappableCases) {
    lines.push(`        if let value = ${c.typeName}(map: map) { return .${c.caseName}(value) }`)
  }
  if (unmappableCases.length > 0) {
    lines.push(
      `        // ObjectMapper's Map only wraps a keyed JSON object (Map.JSON: [String: Any]) — ` +
        `it has no native way to decode a scalar/array-shaped variant, so ${unmappableCases
          .map((c) => `.${c.caseName}`)
          .join(", ")} ${unmappableCases.length === 1 ? "is" : "are"} unreachable here; ` +
        `provide a custom TransformType if the wire format actually needs ${unmappableCases.length === 1 ? "it" : "them"}.`,
    )
  }
  lines.push("        return nil", "    }", "}")
  if (ctx.nested.length > 0) {
    return [...lines.slice(0, -1), "", ...ctx.nested.flatMap((decl) => indent(decl, 4)), "}"].join("\n")
  }
  return lines.join("\n")
}

function discriminatorTag(ref: TypeRef, discriminator: string, index: number): string {
  if (ref.shape.kind === "object") {
    const field = (ref.shape as TypeShape & { kind: "object" }).fields[discriminator]
    if (field !== undefined && field.shape.kind === "literal") {
      const value = (field.shape as TypeShape & { kind: "literal" }).value
      if (typeof value === "string") return value
    }
  }
  return `variant${index + 1}`
}

// Discriminated union -> an enum of Mappable-wrapped variants, resolved by
// reading the discriminator key straight out of `map.JSON` and switching on
// it before delegating to the matching variant struct's own `init?(map:)` —
// idiomatic ObjectMapper for a JSON tagged union, in place of the
// probe-every-variant approach `plainUnionDecl` falls back to when there's
// no discriminator to key off of.
function discriminatedUnionDecl(
  name: string,
  ref: TypeRef,
  variants: readonly TypeRef[],
  discriminator: string,
): string {
  const nested: string[] = []
  const cases = variants.map((variant, i) => {
    const tag = discriminatorTag(variant, discriminator, i)
    const typeName = typeof variant.meta.typeName === "string" ? variant.meta.typeName : capitalize(tag)
    if (variant.shape.kind === "object") nested.push(structDecl(typeName, variant))
    return { tag, caseName: swiftIdentifier(tag), typeName }
  })

  const lines = [...docComment(ref), `enum ${name} {`]
  for (const c of cases) lines.push(`    case ${c.caseName}(${c.typeName})`)
  lines.push(
    "",
    `    static func from(map: Map) -> ${name}? {`,
    `        guard let ${swiftIdentifier(discriminator)} = map.JSON[${quote(discriminator)}] as? String else { return nil }`,
    `        switch ${swiftIdentifier(discriminator)} {`,
  )
  for (const c of cases) {
    lines.push(
      `        case ${quote(c.tag)}: return ${c.typeName}(map: map).map { .${c.caseName}($0) }`,
    )
  }
  lines.push("        default: return nil", "        }", "    }")
  if (nested.length > 0) {
    lines.push("")
    for (const decl of nested) lines.push(...indent(decl, 4))
  }
  lines.push("}")
  return lines.join("\n")
}

function unionDecl(name: string, ref: TypeRef): string {
  const s = ref.shape as TypeShape & { kind: "union" }
  return typeof ref.meta.discriminator === "string"
    ? discriminatedUnionDecl(name, ref, s.variants, ref.meta.discriminator)
    : plainUnionDecl(name, ref, s.variants)
}

/**
 * Project a `TypeRef` to standalone ObjectMapper-flavored Swift source:
 * `object` gets a `Mappable`-conforming `struct` (`<-`-wired `mapping(map:)`,
 * implicitly-unwrapped required properties — see `fieldType`'s header
 * comment); `enum` gets a plain `String`-backed enum (ObjectMapper's
 * RawRepresentable `<-` overload handles it with no extra ceremony);
 * `union` gets a hand-written `from(map:)` factory (ObjectMapper has no sum
 * -type construct of its own — see `plainUnionDecl`/`discriminatedUnionDecl`).
 * Every other kind renders as a `typealias`, with any object/enum/union
 * reachable underneath hoisted to a nested declaration, same as a field
 * position inside a struct.
 */
export function toObjectMapper(ref: TypeRef, name = "Root"): string {
  const kind = ref.shape.kind
  if (kind === "object") return structDecl(name, ref)
  if (kind === "enum") return enumDecl(name, ref)
  if (kind === "union") return unionDecl(name, ref)

  const ctx: Ctx = { nested: [] }
  const typeName = fieldType(ref, name, ctx)
  const nested = ctx.nested.length > 0 ? `\n\n${ctx.nested.join("\n\n")}` : ""
  return `typealias ${name} = ${typeName}${nested}`
}
