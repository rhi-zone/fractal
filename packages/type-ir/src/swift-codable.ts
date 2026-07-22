import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// packages/type-ir/src/swift.ts — @rhi-zone/fractal-type-ir/swift
//
// TypeRef -> idiomatic Swift type declarations (Codable structs/enums).
// Mirrors typescript.ts's/protobuf.ts's projector shape: a `kind`-keyed
// handler table for the primitive/leaf cases, plus dedicated declaration
// builders for the "has its own name" kinds (object -> struct, enum -> enum,
// union -> enum-with-associated-values). Unlike typescript.ts (which can
// always inline an anonymous type literal), Swift has no anonymous
// struct/enum literal syntax, so a named type nested inside a field position
// (an object-typed field, an array of objects, …) is hoisted to a sibling
// declaration nested inside the parent's body — see `fieldType`'s object/
// enum/union branches, which push onto `Ctx.nested` and return just the new
// type's name for the enclosing field to reference.

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1)
}

// snake_case / kebab-case / space-separated -> lowerCamelCase (Swift's
// idiomatic property-name casing). `structDecl` compares the result against
// the original JSON key to decide whether a `CodingKeys` enum is needed.
function toCamelCase(name: string): string {
  const camel = name.replace(/[-_\s]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))
  return camel.length === 0 ? camel : camel[0]!.toLowerCase() + camel.slice(1)
}

// A Swift identifier: camelCase, stripped of characters Swift doesn't allow
// bare, and never leading with a digit (an enum member/case name derived
// from arbitrary IR string data — e.g. `enum.members`, a discriminator's
// literal tag value — has none of Swift's identifier guarantees).
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

// Every built-in leaf kind (plus the pre-1.0 extension kinds — int/float
// widths, semantic strings, bytes, temporal — bundled in kinds/common.ts and
// already referenced by name in typescript.ts/protobuf.ts the same way).
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
  uuid: "UUID",
  uri: "URL",
  email: "String",
  datetime: "Date",
  date: "Date",
  time: "String",
  duration: "String",
  bytes: "Data",
  // `null` has no Swift bottom type to alias directly; `Never?` (an Optional
  // that can only ever be `nil`) is the closest honest analogue.
  null: "Never?",
  void: "Void",
  unknown: "Any",
  never: "Never",
}

function literalType(value: string | number | boolean | null): string {
  if (value === null) return "Never?"
  if (typeof value === "string") return "String"
  if (typeof value === "boolean") return "Bool"
  return Number.isInteger(value) ? "Int" : "Double"
}

/** Declarations hoisted out of a field/element position, to be nested inside
 * the enclosing struct/enum's body (Swift has no anonymous struct/enum
 * literal syntax — see file header). */
interface Ctx {
  nested: string[]
}

/**
 * The Swift type expression for `ref` in a field/element/key/value position.
 * `hint` names a nested declaration if `ref` turns out to need one (an
 * object/enum/union with no `meta.typeName` of its own) — callers pass
 * something derived from the enclosing field/parameter name, capitalized,
 * matching protobuf.ts's `toProtoMessage` nested-message-naming convention.
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
  } else if (kind === "array") {
    const s = ref.shape as TypeShape & { kind: "array" }
    base = `[${fieldType(s.element, `${hint}Element`, ctx)}]`
  } else if (kind === "map") {
    const s = ref.shape as TypeShape & { kind: "map" }
    const keyType = fieldType(s.key, `${hint}Key`, ctx)
    const valueType = fieldType(s.value, `${hint}Value`, ctx)
    base = `[${keyType}: ${valueType}]`
  } else if (kind === "tuple") {
    const s = ref.shape as TypeShape & { kind: "tuple" }
    base = `(${s.elements.map((element, i) => fieldType(element, `${hint}${i}`, ctx)).join(", ")})`
  } else if (kind === "ref") {
    base = capitalize((ref.shape as TypeShape & { kind: "ref" }).target)
  } else if (kind === "instance") {
    // Nominal-only (see TypeKinds.instance's doc comment in index.ts) — the
    // caller assembling generated Swift is responsible for the className
    // actually resolving (import/module membership), same convention
    // typescript.ts's `instance` handler documents.
    base = (ref.shape as TypeShape & { kind: "instance" }).className
  } else if (kind === "literal") {
    base = literalType((ref.shape as TypeShape & { kind: "literal" }).value)
  } else if (kind === "stream" || kind === "page") {
    // Swift has no native streaming/pagination-window construct — degrades
    // honestly to an array of the element type, same convention json-
    // schema.ts/protobuf.ts use for these two kinds.
    const s = ref.shape as TypeShape & { element: TypeRef }
    base = `[${fieldType(s.element, hint, ctx)}]`
  } else if (kind === "intersection") {
    // Swift has no structural intersection/mixin construct; lossy fallback
    // to the first member, same honest-degrade convention protobuf.ts's
    // `intersection` handler uses.
    const s = ref.shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    base = first === undefined ? "Any" : fieldType(first, hint, ctx)
  } else {
    // Primitives/extension leaf kinds, plus function/method/interface (no
    // Swift callable-type-in-field-position construct — degrades to `Any`,
    // same honest-degrade convention protobuf.ts's `function`/`interface`
    // handlers use).
    base = resolve(kind, primitiveHandlers) ?? "Any"
  }

  if ((ref.meta.optional === true || ref.meta.nullable === true) && !base.endsWith("?")) {
    base = `${base}?`
  }
  return base
}

function structDecl(name: string, ref: TypeRef): string {
  const s = ref.shape as TypeShape & { kind: "object" }
  const ctx: Ctx = { nested: [] }
  const propLines: string[] = []
  const codingKeyLines: string[] = []
  let needsCodingKeys = false

  for (const [fieldName, fieldRef] of Object.entries(s.fields)) {
    const swiftName = swiftIdentifier(fieldName)
    if (swiftName !== fieldName) needsCodingKeys = true
    const readonly = fieldRef.meta.readonly === true
    const typeName = fieldType(fieldRef, capitalize(fieldName), ctx)
    propLines.push(`    ${readonly ? "let" : "var"} ${swiftName}: ${typeName}`)
    codingKeyLines.push(swiftName === fieldName ? `        case ${swiftName}` : `        case ${swiftName} = ${quote(fieldName)}`)
  }

  const lines = [`struct ${name}: Codable {`, ...propLines]
  if (needsCodingKeys) {
    lines.push("", "    enum CodingKeys: String, CodingKey {", ...codingKeyLines, "    }")
  }
  if (ctx.nested.length > 0) {
    lines.push("")
    for (const decl of ctx.nested) lines.push(...indent(decl, 4))
  }
  lines.push("}")
  return lines.join("\n")
}

function enumDecl(name: string, ref: TypeRef): string {
  const s = ref.shape as TypeShape & { kind: "enum" }
  const lines = [`enum ${name}: String, Codable, CaseIterable {`]
  for (const member of s.members) {
    const ident = swiftIdentifier(member)
    lines.push(ident === member ? `    case ${ident}` : `    case ${ident} = ${quote(member)}`)
  }
  lines.push("}")
  return lines.join("\n")
}

// A variant with no `meta.typeName` of its own is named after: a `ref`'s
// target, a leaf kind's own name (e.g. a `string` variant -> `case string`),
// or (falling back for an anonymous object/union/etc. variant) positional
// `variantN` — same "hoist with a synthesized name" fallback `fieldType`
// uses for a nested object/enum/union.
function variantCaseName(ref: TypeRef, index: number): string {
  if (typeof ref.meta.typeName === "string") return swiftIdentifier(ref.meta.typeName)
  const kind = ref.shape.kind
  if (kind === "ref") return swiftIdentifier((ref.shape as TypeShape & { kind: "ref" }).target)
  if (kind in primitiveHandlers) return swiftIdentifier(kind)
  return `variant${index + 1}`
}

// Plain (non-discriminated) union -> a Codable enum with one associated
// value per variant. Swift has no native tagged-union-of-arbitrary-payloads
// decoding, so `init(from:)`/`encode(to:)` are hand-written: decoding tries
// each variant's type in turn via `singleValueContainer()` + `try?`
// (first successful decode wins — same "structural probing" approach
// several dynamically-typed union decoders use), encoding just re-encodes
// whichever payload is currently held.
function plainUnionDecl(name: string, variants: readonly TypeRef[]): string {
  const ctx: Ctx = { nested: [] }
  const cases = variants.map((variant, i) => ({
    caseName: variantCaseName(variant, i),
    typeName: fieldType(variant, capitalize(variantCaseName(variant, i)), ctx),
  }))

  const lines = [`enum ${name}: Codable {`]
  for (const c of cases) lines.push(`    case ${c.caseName}(${c.typeName})`)
  lines.push("", "    init(from decoder: Decoder) throws {", "        let container = try decoder.singleValueContainer()")
  for (const c of cases) {
    lines.push(
      `        if let value = try? container.decode(${c.typeName}.self) {`,
      `            self = .${c.caseName}(value)`,
      "            return",
      "        }",
    )
  }
  lines.push(
    `        throw DecodingError.typeMismatch(${name}.self, DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "No matching variant for ${name}"))`,
    "    }",
    "",
    "    func encode(to encoder: Encoder) throws {",
    "        var container = encoder.singleValueContainer()",
    "        switch self {",
  )
  for (const c of cases) lines.push(`        case .${c.caseName}(let value): try container.encode(value)`)
  lines.push("        }", "    }")
  if (ctx.nested.length > 0) {
    lines.push("")
    for (const decl of ctx.nested) lines.push(...indent(decl, 4))
  }
  lines.push("}")
  return lines.join("\n")
}

// The discriminator's tag value for one variant: the literal value of the
// variant object's `discriminator`-named field (the shape `meta.discriminator`-
// driven projectors elsewhere in this package — zod.ts's
// `z.discriminatedUnion`, json-schema.ts's/openapi30.ts's `discriminator:
// { propertyName }` — all assume: a discriminated union's variants are
// objects carrying a literal-valued field named by the discriminator).
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

// Discriminated union -> a Codable enum with one associated struct per
// variant, decoded by reading the discriminator key first (via a private
// `CodingKeys` naming just that one field) and switching on its value —
// idiomatic Swift for a JSON tagged union, in place of the probe-every-
// variant approach `plainUnionDecl` falls back to when there's no
// discriminator to key off of.
function discriminatedUnionDecl(name: string, variants: readonly TypeRef[], discriminator: string): string {
  const key = swiftIdentifier(discriminator)
  const ctx: Ctx = { nested: [] }
  const cases = variants.map((variant, i) => {
    const tag = discriminatorTag(variant, discriminator, i)
    const typeName = typeof variant.meta.typeName === "string" ? variant.meta.typeName : capitalize(tag)
    if (variant.shape.kind === "object") ctx.nested.push(structDecl(typeName, variant))
    return { tag, caseName: swiftIdentifier(tag), typeName }
  })

  const lines = [`enum ${name}: Codable {`]
  for (const c of cases) lines.push(`    case ${c.caseName}(${c.typeName})`)
  lines.push(
    "",
    `    private enum CodingKeys: String, CodingKey { case ${key} = ${quote(discriminator)} }`,
    "",
    "    init(from decoder: Decoder) throws {",
    "        let container = try decoder.container(keyedBy: CodingKeys.self)",
    `        let ${key} = try container.decode(String.self, forKey: .${key})`,
    `        switch ${key} {`,
  )
  for (const c of cases) {
    lines.push(`        case ${quote(c.tag)}: self = .${c.caseName}(try ${c.typeName}(from: decoder))`)
  }
  lines.push(
    `        default: throw DecodingError.dataCorruptedError(forKey: .${key}, in: container, debugDescription: "Unknown ${discriminator}: \\(${key})")`,
    "        }",
    "    }",
    "",
    "    func encode(to encoder: Encoder) throws {",
    "        switch self {",
  )
  for (const c of cases) lines.push(`        case .${c.caseName}(let value): try value.encode(to: encoder)`)
  lines.push("        }", "    }")
  if (ctx.nested.length > 0) {
    lines.push("")
    for (const decl of ctx.nested) lines.push(...indent(decl, 4))
  }
  lines.push("}")
  return lines.join("\n")
}

// `meta.discriminator` (open metadata bag convention, see CLAUDE.md and
// json-schema.ts's/openapi30.ts's/zod.ts's identical reads of this key) picks
// discriminatedUnionDecl over plainUnionDecl.
function unionDecl(name: string, ref: TypeRef): string {
  const s = ref.shape as TypeShape & { kind: "union" }
  return typeof ref.meta.discriminator === "string"
    ? discriminatedUnionDecl(name, s.variants, ref.meta.discriminator)
    : plainUnionDecl(name, s.variants)
}

/**
 * Project a `TypeRef` to a standalone Swift declaration. `object`/`enum`/
 * `union` get their own named declaration form (`struct`/`enum`/tagged
 * `enum` — see the three `*Decl` builders above); every other kind renders
 * as a `typealias`, with any object/enum/union reachable underneath (e.g.
 * inside an array or map) hoisted to a nested declaration, same as a field
 * position inside a struct.
 */
export function toSwift(ref: TypeRef, name = "Root"): string {
  const kind = ref.shape.kind
  if (kind === "object") return structDecl(name, ref)
  if (kind === "enum") return enumDecl(name, ref)
  if (kind === "union") return unionDecl(name, ref)

  const ctx: Ctx = { nested: [] }
  const typeName = fieldType(ref, name, ctx)
  const nested = ctx.nested.length > 0 ? `\n\n${ctx.nested.join("\n\n")}` : ""
  return `typealias ${name} = ${typeName}${nested}`
}
