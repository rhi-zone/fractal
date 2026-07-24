import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// packages/type-ir/src/swift-swiftyjson.ts — @rhi-zone/fractal-type-ir/swift-swiftyjson
//
// TypeRef -> idiomatic Swift types for SwiftyJSON
// (https://github.com/SwiftyJSON/SwiftyJSON): unlike swift-codable.ts's
// protocol-conformance encoding (a struct declares `: Codable` and the
// compiler synthesizes init(from:)/encode(to:)), SwiftyJSON has no
// compiler-driven derivation at all — it's a single wrapper type, `JSON`,
// offering subscript access (`json["key"]`) plus typed accessors
// (`.stringValue`, `.intValue`, `.arrayValue`, …) that never throw (a
// missing/mismatched key degrades to the type's zero value, or `nil` for the
// optional accessor variants). So the declaration shape here is structurally
// different, not just differently-annotated: every hoisted type gets a hand
// -written `init(json: JSON)` that reads its own fields out of the wrapper
// via those accessors (recursively, for nested objects/arrays/maps/enums/
// unions), in place of Codable's compiler-synthesized initializer.
//
// SwiftyJSON has no schema-driven decode of enums or discriminated unions —
// both are hand-rolled here on top of its accessors, same "reach for the
// most idiomatic hand-written equivalent" approach swift-codable.ts's
// plainUnionDecl/discriminatedUnionDecl take for Codable's lack of a native
// union construct.

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

// Swift type + SwiftyJSON accessor pair for every leaf/primitive kind this
// projector knows how to render directly (the pre-1.0 extension kinds —
// int/float widths, semantic strings, bytes, temporal — bundled in
// kinds/common.ts, same set swift-codable.ts's primitiveHandlers covers).
// `required`/`optional` name the `JSON` instance property to read: SwiftyJSON
// pairs a non-optional "Value" accessor (returns the type's zero value on a
// missing/mismatched key) with a plain optional accessor of the same base
// name (returns nil instead) — see SwiftyJSON's SwiftyJSON.swift for the
// full int8/16/32/64 + uInt8/16/32/64 family this table draws from.
interface Accessor {
  readonly type: string
  readonly required: string
  readonly optional: string
}

function accessor(type: string, base: string): Accessor {
  return { type, required: `${base}Value`, optional: base }
}

const primitiveHandlers: Record<string, Accessor> = {
  boolean: accessor("Bool", "bool"),
  string: accessor("String", "string"),
  number: accessor("Double", "double"),
  integer: accessor("Int", "int"),
  int8: accessor("Int8", "int8"),
  int16: accessor("Int16", "int16"),
  int32: accessor("Int32", "int32"),
  int64: accessor("Int64", "int64"),
  uint8: accessor("UInt8", "uInt8"),
  uint16: accessor("UInt16", "uInt16"),
  uint32: accessor("UInt32", "uInt32"),
  uint64: accessor("UInt64", "uInt64"),
  float32: accessor("Float", "float"),
  float64: accessor("Double", "double"),
  // SwiftyJSON has no dedicated UUID/URL/Date/Data accessor — these all
  // degrade to the string accessor, with the caller responsible for the
  // extra parse step (UUID(uuidString:), URL(string:), a DateFormatter, or
  // Data(base64Encoded:)), same honest-degrade convention swift-codable.ts
  // documents for its own `time`/`duration` mapping to bare String.
  uuid: accessor("String", "string"),
  uri: accessor("String", "string"),
  email: accessor("String", "string"),
  datetime: accessor("String", "string"),
  date: accessor("String", "string"),
  time: accessor("String", "string"),
  duration: accessor("String", "string"),
  bytes: accessor("String", "string"),
  // `.object` is SwiftyJSON's fully-untyped escape hatch (`Any`) — the
  // closest analogue for null/unknown/void/never/function/method/interface,
  // none of which SwiftyJSON has a typed accessor for.
  null: accessor("Any", "object"),
  void: accessor("Any", "object"),
  unknown: accessor("Any", "object"),
  never: accessor("Any", "object"),
}

/** Declarations hoisted out of a field/element position, to be emitted as
 * sibling top-level declarations (SwiftyJSON's hand-written init(json:)
 * pattern has no natural "nested type" placement the way Codable's
 * compiler-synthesized initializer does, so — unlike swift-codable.ts, which
 * nests inside the parent struct's body — every hoisted declaration here is
 * emitted at the top level and simply referenced by name from its use site). */
interface Ctx {
  decls: string[]
  declared: Set<string>
}

// The declared Swift type name for `ref` when it's a kind that needs its own
// top-level declaration (object/enum/union); shared between `swiftType`
// (which hoists the declaration) and `accessorExpr` (which only needs to
// reference the name a sibling call already hoisted under).
function hoistedName(ref: TypeRef, hint: string): string {
  return typeof ref.meta.typeName === "string" ? ref.meta.typeName : capitalize(hint)
}

/** The Swift type expression for `ref` in a field/element/key/value
 * position, hoisting any object/enum/union it contains as a top-level
 * declaration keyed by `hint` (capitalized) or `meta.typeName`. */
function swiftType(ref: TypeRef, hint: string, ctx: Ctx): string {
  const kind = ref.shape.kind
  let base: string

  if (kind === "object") {
    const name = hoistedName(ref, hint)
    if (!ctx.declared.has(name)) {
      ctx.declared.add(name)
      ctx.decls.push(structDecl(name, ref, ctx))
    }
    base = name
  } else if (kind === "enum") {
    const name = hoistedName(ref, hint)
    if (!ctx.declared.has(name)) {
      ctx.declared.add(name)
      ctx.decls.push(enumDecl(name, ref))
    }
    base = name
  } else if (kind === "union") {
    const name = hoistedName(ref, hint)
    if (!ctx.declared.has(name)) {
      ctx.declared.add(name)
      ctx.decls.push(unionDecl(name, ref, ctx))
    }
    base = name
  } else if (kind === "array" || kind === "stream" || kind === "page") {
    // No native SwiftyJSON streaming/pagination-window construct — degrades
    // honestly to an array of the element type, same convention
    // swift-codable.ts uses for `stream`/`page`.
    const s = ref.shape as TypeShape & { element: TypeRef }
    base = `[${swiftType(s.element, `${hint}Element`, ctx)}]`
  } else if (kind === "map") {
    const s = ref.shape as TypeShape & { kind: "map" }
    // JSON object keys are always strings — SwiftyJSON's `.dictionaryValue`
    // is `[String: JSON]`, so the key type itself is fixed regardless of
    // `s.key`'s declared kind (same assumption swift-codable.ts's own `map`
    // branch makes implicitly by rendering whatever `s.key` says, which in
    // practice is always `string` for a JSON-sourced map).
    base = `[String: ${swiftType(s.value, `${hint}Value`, ctx)}]`
  } else if (kind === "tuple") {
    const s = ref.shape as TypeShape & { kind: "tuple" }
    base = `(${s.elements.map((element, i) => swiftType(element, `${hint}${i}`, ctx)).join(", ")})`
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
    base = first === undefined ? "Any" : swiftType(first, hint, ctx)
  } else {
    base = resolve(kind, primitiveHandlers)?.type ?? "Any"
  }

  if ((ref.meta.optional === true || ref.meta.nullable === true) && !base.endsWith("?")) {
    base = `${base}?`
  }
  return base
}

/** The Swift expression that extracts `ref`'s value out of `jsonExpr` (an
 * expression of type `JSON`). Mirrors `swiftType`'s branch structure —
 * `swiftType` must run first on the same `ref`/`hint` pair so any
 * object/enum/union declaration this expression references has already
 * been hoisted into `ctx.decls`. */
function accessorExpr(ref: TypeRef, jsonExpr: string, hint: string): string {
  const optional = ref.meta.optional === true || ref.meta.nullable === true
  const kind = ref.shape.kind

  if (kind === "object" || kind === "union") {
    const name = hoistedName(ref, hint)
    return optional
      ? `${jsonExpr}.exists() ? ${name}(json: ${jsonExpr}) : nil`
      : `${name}(json: ${jsonExpr})`
  }
  if (kind === "enum") {
    const name = hoistedName(ref, hint)
    return optional ? `${name}.from(json: ${jsonExpr})` : `${name}.from(json: ${jsonExpr})!`
  }
  if (kind === "array" || kind === "stream" || kind === "page") {
    const s = ref.shape as TypeShape & { element: TypeRef }
    const elementExpr = accessorExpr(s.element, "$0", `${hint}Element`)
    const mapExpr = `${jsonExpr}.arrayValue.map { ${elementExpr} }`
    return optional ? `${jsonExpr}.exists() ? ${mapExpr} : nil` : mapExpr
  }
  if (kind === "map") {
    const s = ref.shape as TypeShape & { kind: "map" }
    const valueExpr = accessorExpr(s.value, "$0.value", `${hint}Value`)
    const dictExpr = `Dictionary(uniqueKeysWithValues: ${jsonExpr}.dictionaryValue.map { ($0.key, ${valueExpr}) })`
    return optional ? `${jsonExpr}.exists() ? ${dictExpr} : nil` : dictExpr
  }
  if (kind === "tuple") {
    const s = ref.shape as TypeShape & { kind: "tuple" }
    const elements = s.elements.map((element, i) =>
      accessorExpr(element, `${jsonExpr}.arrayValue[${i}]`, `${hint}${i}`),
    )
    return `(${elements.join(", ")})`
  }
  if (kind === "ref") {
    // A `ref` target's own declaration isn't visible from here — assumed to
    // follow this file's `init(json:)` convention, same trust-the-caller
    // assumption swift-codable.ts's `ref` handler documents for a bare type
    // name reference.
    const name = capitalize((ref.shape as TypeShape & { kind: "ref" }).target)
    return optional
      ? `${jsonExpr}.exists() ? ${name}(json: ${jsonExpr}) : nil`
      : `${name}(json: ${jsonExpr})`
  }
  if (kind === "instance") {
    const name = (ref.shape as TypeShape & { kind: "instance" }).className
    return optional
      ? `${jsonExpr}.exists() ? ${name}(json: ${jsonExpr}) : nil`
      : `${name}(json: ${jsonExpr})`
  }
  if (kind === "literal") {
    const s = ref.shape as TypeShape & { kind: "literal" }
    const value = s.value
    if (value === null) return "nil"
    if (typeof value === "string") return quote(value)
    if (typeof value === "boolean") return String(value)
    return String(value)
  }
  if (kind === "intersection") {
    const s = ref.shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    return first === undefined ? `${jsonExpr}.object` : accessorExpr(first, jsonExpr, hint)
  }

  const a = resolve(kind, primitiveHandlers) ?? accessor("Any", "object")
  return optional ? `${jsonExpr}.${a.optional}` : `${jsonExpr}.${a.required}`
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

// `struct Name { let/var field: Type; init(json: JSON) { self.field = ... } }`
// — the SwiftyJSON analogue of swift-codable.ts's structDecl, minus
// CodingKeys (SwiftyJSON has no keyed-container concept; the JSON field name
// is simply the subscript literal used directly in the initializer body).
function structDecl(name: string, ref: TypeRef, ctx: Ctx): string {
  const s = ref.shape as TypeShape & { kind: "object" }
  const propLines: string[] = []
  const initLines: string[] = []

  for (const [fieldName, fieldRef] of Object.entries(s.fields)) {
    const swiftName = swiftIdentifier(fieldName)
    const readonly = fieldRef.meta.readonly === true
    const typeName = swiftType(fieldRef, `${name}${capitalize(fieldName)}`, ctx)
    propLines.push(`    ${readonly ? "let" : "var"} ${swiftName}: ${typeName}`)
    const expr = accessorExpr(fieldRef, `json[${quote(fieldName)}]`, `${name}${capitalize(fieldName)}`)
    initLines.push(`        self.${swiftName} = ${expr}`)
  }

  const lines = [
    ...docComment(ref),
    `struct ${name} {`,
    ...propLines,
    "",
    "    init(json: JSON) {",
    ...initLines,
    "    }",
    "}",
  ]
  return lines.join("\n")
}

// `enum Name: String { case a; case b; static func from(json: JSON) -> Name? { Name(rawValue: json.stringValue) } }`
// — SwiftyJSON has no compiler-driven enum decode, so `from(json:)` (a
// factory returning `nil` on an unrecognized/missing value) stands in for
// swift-codable.ts's automatic `RawRepresentable` conformance.
function enumDecl(name: string, ref: TypeRef): string {
  const s = ref.shape as TypeShape & { kind: "enum" }
  const lines = [...docComment(ref), `enum ${name}: String, CaseIterable {`]
  for (const member of s.members) {
    const ident = swiftIdentifier(member)
    lines.push(ident === member ? `    case ${ident}` : `    case ${ident} = ${quote(member)}`)
  }
  lines.push(
    "",
    `    static func from(json: JSON) -> ${name}? {`,
    `        ${name}(rawValue: json.stringValue)`,
    "    }",
    "}",
  )
  return lines.join("\n")
}

function variantCaseName(ref: TypeRef, index: number): string {
  if (typeof ref.meta.typeName === "string") return swiftIdentifier(ref.meta.typeName)
  const kind = ref.shape.kind
  if (kind === "ref") return swiftIdentifier((ref.shape as TypeShape & { kind: "ref" }).target)
  if (kind in primitiveHandlers) return swiftIdentifier(kind)
  return `variant${index + 1}`
}

// SwiftyJSON's `JSON.Type` enum (`.string`, `.number`, `.bool`, `.array`,
// `.dictionary`, `.null`) is the probe this file uses in place of Codable's
// try-each-variant `singleValueContainer()` approach (swift-codable.ts's
// plainUnionDecl) — each variant's outermost kind picks the `.type` case it
// can only plausibly match, and the first match wins, same "structural
// probing" idea, just against SwiftyJSON's own type tag instead of a thrown
// decode error.
function jsonTypeCase(kind: string): string {
  if (kind === "string" || kind === "uuid" || kind === "uri" || kind === "email" || kind === "datetime" || kind === "date" || kind === "time" || kind === "duration" || kind === "bytes") {
    return ".string"
  }
  if (kind === "boolean") return ".bool"
  if (kind === "array" || kind === "tuple" || kind === "stream" || kind === "page") return ".array"
  if (kind === "object" || kind === "map") return ".dictionary"
  if (kind === "enum") return ".string"
  return ".number"
}

function plainUnionDecl(name: string, ref: TypeRef, variants: readonly TypeRef[], ctx: Ctx): string {
  const cases = variants.map((variant, i) => ({
    caseName: variantCaseName(variant, i),
    typeName: swiftType(variant, capitalize(variantCaseName(variant, i)), ctx),
    typeCase: jsonTypeCase(variant.shape.kind),
    expr: accessorExpr(variant, "json", capitalize(variantCaseName(variant, i))),
  }))

  const lines = [...docComment(ref), `enum ${name} {`]
  for (const c of cases) lines.push(`    case ${c.caseName}(${c.typeName})`)
  lines.push("", "    init(json: JSON) {", "        switch json.type {")
  for (const c of cases) {
    lines.push(`        case ${c.typeCase}: self = .${c.caseName}(${c.expr})`)
  }
  lines.push(
    `        default: self = .${cases[0]!.caseName}(${cases[0]!.expr})`,
    "        }",
    "    }",
    "}",
  )
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

function discriminatedUnionDecl(
  name: string,
  ref: TypeRef,
  variants: readonly TypeRef[],
  discriminator: string,
  ctx: Ctx,
): string {
  const cases = variants.map((variant, i) => {
    const tag = discriminatorTag(variant, discriminator, i)
    const typeName = typeof variant.meta.typeName === "string" ? variant.meta.typeName : capitalize(tag)
    if (variant.shape.kind === "object" && !ctx.declared.has(typeName)) {
      ctx.declared.add(typeName)
      ctx.decls.push(structDecl(typeName, variant, ctx))
    }
    return { tag, caseName: swiftIdentifier(tag), typeName }
  })

  const lines = [...docComment(ref), `enum ${name} {`]
  for (const c of cases) lines.push(`    case ${c.caseName}(${c.typeName})`)
  lines.push(
    "",
    "    init(json: JSON) {",
    `        switch json[${quote(discriminator)}].stringValue {`,
  )
  for (const c of cases) {
    lines.push(`        case ${quote(c.tag)}: self = .${c.caseName}(${c.typeName}(json: json))`)
  }
  lines.push(
    `        default: self = .${cases[0]!.caseName}(${cases[0]!.typeName}(json: json))`,
    "        }",
    "    }",
    "}",
  )
  return lines.join("\n")
}

function unionDecl(name: string, ref: TypeRef, ctx: Ctx): string {
  const s = ref.shape as TypeShape & { kind: "union" }
  return typeof ref.meta.discriminator === "string"
    ? discriminatedUnionDecl(name, ref, s.variants, ref.meta.discriminator, ctx)
    : plainUnionDecl(name, ref, s.variants, ctx)
}

/**
 * Project a `TypeRef` to standalone SwiftyJSON-flavored Swift source:
 * `object`/`enum`/`union` get their own named declaration (`struct`/`enum`/
 * tagged `enum`, each carrying a hand-written `init(json: JSON)` in place of
 * Codable's compiler synthesis); every other kind renders as a `typealias`
 * plus any object/enum/union reachable underneath (inside an array, map,
 * tuple, …) hoisted to its own top-level declaration alongside it — unlike
 * swift-codable.ts's `toSwift`, hoisted declarations here are siblings
 * rather than nested, since SwiftyJSON's init(json:) pattern has no natural
 * "inside the parent's body" placement.
 */
export function toSwiftyJSON(ref: TypeRef, name = "Root"): string {
  const ctx: Ctx = { decls: [], declared: new Set() }
  const kind = ref.shape.kind

  if (kind === "object") {
    ctx.declared.add(name)
    ctx.decls.push(structDecl(name, ref, ctx))
    return ctx.decls.join("\n\n")
  }
  if (kind === "enum") {
    ctx.declared.add(name)
    ctx.decls.push(enumDecl(name, ref))
    return ctx.decls.join("\n\n")
  }
  if (kind === "union") {
    ctx.declared.add(name)
    ctx.decls.push(unionDecl(name, ref, ctx))
    return ctx.decls.join("\n\n")
  }

  const typeName = swiftType(ref, name, ctx)
  const alias = `typealias ${name} = ${typeName}`
  return ctx.decls.length > 0 ? [...ctx.decls, alias].join("\n\n") : alias
}
