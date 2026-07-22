// packages/type-ir/src/from-capnp.ts — @rhi-zone/fractal-type-ir/from-capnp
//
// Cap'n Proto schema language (https://capnproto.org/language.html) -> TypeRef,
// the reverse direction of capnp.ts's TypeRef -> Cap'n Proto projector
// (toCapnpType/toCapnpStruct/toCapnpInterface).
//
// Cap'n Proto has no widely-used JS parser library and no self-describing
// JSON descriptor format analogous to protobuf's `descriptor.proto` (its
// actual self-description mechanism, `schema.capnp`, is itself a `.capnp`
// schema compiled by `capnp compile` — circular for a from-scratch ingester),
// so this module hand-rolls a recursive-descent parser over the schema
// language's structural grammar: `struct`/`enum` declarations, fields with
// `@N` ordinals, named/anonymous `union`/`group` blocks, `List(T)`, default
// values (`= …`), annotations (`$name(value)`), `#` line-comment doc strings,
// and `using`/`import`/`const`/`annotation`/`interface` declarations (the
// last four are recognized and skipped structurally — full resolution or
// interface-method conversion is out of scope here; the output projector's
// own `toCapnpInterface` is a one-way encoding with no matching field-level
// construct to invert, per capnp.ts's own doc comments).
//
// `fromCapnp(schema)` returns a flat `Record<string, TypeRef>` — every
// struct/enum in the file (top-level and nested, keyed by dotted path, e.g.
// `"Person"`, `"Person.Address"`) — rather than a `TypeRefDocument`, since
// Cap'n Proto schema files (like protobuf files) commonly declare several
// independent, mutually-referential top-level types with no single "root".
// Struct/enum-typed fields become `{ kind: "ref", target }` pointing at
// another key in the same record.

import { t, types, type TypeRef } from "./index.ts"
import { bytes, float32, float64, int16, int32, int64, int8, uint16, uint32, uint64, uint8 } from "./kinds/common.ts"

// ============================================================================
// Tokenizer
// ============================================================================

type TokenType = "id" | "num" | "str" | "punct" | "comment"
type Token = { readonly type: TokenType; readonly value: string; readonly line: number }

const PUNCT = "{}();:@=$,.-><"

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let line = 1
  const n = src.length
  while (i < n) {
    const c = src[i]!
    if (c === "\n") {
      line++
      i++
      continue
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++
      continue
    }
    if (c === "#") {
      let j = i + 1
      while (j < n && src[j] !== "\n") j++
      tokens.push({ type: "comment", value: src.slice(i + 1, j).trim(), line })
      i = j
      continue
    }
    if (c === '"') {
      let j = i + 1
      let buf = ""
      while (j < n && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < n) {
          buf += src[j + 1]
          j += 2
        } else {
          buf += src[j]
          j++
        }
      }
      tokens.push({ type: "str", value: buf, line })
      i = j + 1
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_]/.test(src[j]!)) j++
      tokens.push({ type: "id", value: src.slice(i, j), line })
      i = j
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1
      if (c === "0" && src[i + 1] === "x") {
        j = i + 2
        while (j < n && /[0-9a-fA-F]/.test(src[j]!)) j++
      } else {
        while (j < n && /[0-9.eE+-]/.test(src[j]!)) j++
      }
      tokens.push({ type: "num", value: src.slice(i, j), line })
      i = j
      continue
    }
    if (PUNCT.includes(c)) {
      tokens.push({ type: "punct", value: c, line })
      i++
      continue
    }
    // Unrecognized character (whitespace variant, stray symbol) — skip rather
    // than throw, matching this package's honest-degrade convention for
    // malformed/unanticipated input elsewhere (e.g. from-protobuf.ts's
    // dangling-ref fallback).
    i++
  }
  return tokens
}

function parseNumber(raw: string): number {
  return raw.startsWith("0x") || raw.startsWith("-0x") ? Number.parseInt(raw, 16) : Number(raw)
}

// ============================================================================
// AST — the subset of the schema grammar this converter cares about
// ============================================================================

export type CapnpTypeDesc = { readonly name: string; readonly args?: readonly CapnpTypeDesc[] }

export type CapnpAnnotation = { readonly name: string; readonly value?: string | number | boolean }

export type CapnpFieldMember = {
  readonly kind: "field"
  readonly name: string
  readonly ordinal?: number
  readonly type: CapnpTypeDesc
  readonly default?: string | number | boolean
  readonly annotations: readonly CapnpAnnotation[]
  readonly description?: string
}

export type CapnpGroupMember = {
  readonly kind: "group"
  readonly name: string
  readonly ordinal?: number
  readonly members: readonly CapnpMember[]
  readonly annotations: readonly CapnpAnnotation[]
  readonly description?: string
}

export type CapnpUnionMember = {
  readonly kind: "union"
  /** `undefined` for an anonymous union block (`union { ... }` with no name
   * directly inside a struct — see module doc comment). */
  readonly name?: string
  readonly ordinal?: number
  readonly variants: readonly CapnpFieldMember[]
  readonly annotations: readonly CapnpAnnotation[]
  readonly description?: string
}

export type CapnpMember = CapnpFieldMember | CapnpGroupMember | CapnpUnionMember

export type CapnpStructDecl = {
  readonly kind: "struct"
  readonly name: string
  readonly members: readonly CapnpMember[]
  readonly nestedStructs: readonly CapnpStructDecl[]
  readonly nestedEnums: readonly CapnpEnumDecl[]
  readonly annotations: readonly CapnpAnnotation[]
  readonly description?: string
}

export type CapnpEnumeratorDecl = {
  readonly name: string
  readonly ordinal: number
  readonly annotations: readonly CapnpAnnotation[]
  readonly description?: string
}

export type CapnpEnumDecl = {
  readonly kind: "enum"
  readonly name: string
  readonly members: readonly CapnpEnumeratorDecl[]
  readonly annotations: readonly CapnpAnnotation[]
  readonly description?: string
}

export type CapnpSchemaFile = {
  readonly structs: readonly CapnpStructDecl[]
  readonly enums: readonly CapnpEnumDecl[]
}

// ============================================================================
// Parser
// ============================================================================

class ParseError extends Error {}

class Parser {
  private pos = 0
  private pendingDescription: string[] = []

  constructor(private readonly tokens: readonly Token[]) {}

  private skipComments(): void {
    while (this.pos < this.tokens.length && this.tokens[this.pos]!.type === "comment") {
      this.pendingDescription.push(this.tokens[this.pos]!.value)
      this.pos++
    }
  }

  private flushDescription(): string | undefined {
    this.skipComments()
    if (this.pendingDescription.length === 0) return undefined
    const text = this.pendingDescription.join(" ")
    this.pendingDescription = []
    return text
  }

  private current(): Token | undefined {
    this.skipComments()
    return this.tokens[this.pos]
  }

  private atEnd(): boolean {
    this.skipComments()
    return this.pos >= this.tokens.length
  }

  private peekId(value: string): boolean {
    const tok = this.current()
    return tok !== undefined && tok.type === "id" && tok.value === value
  }

  private peekPunct(value: string): boolean {
    const tok = this.current()
    return tok !== undefined && tok.type === "punct" && tok.value === value
  }

  private expect(type: TokenType, value?: string): Token {
    const tok = this.current()
    if (tok === undefined || tok.type !== type || (value !== undefined && tok.value !== value)) {
      throw new ParseError(
        `expected ${type}${value !== undefined ? ` "${value}"` : ""}, got ${tok === undefined ? "EOF" : `${tok.type} "${tok.value}"`} (line ${tok?.line ?? "?"})`,
      )
    }
    this.pos++
    return tok
  }

  private skipUntilSemicolon(): void {
    while (!this.atEnd() && !this.peekPunct(";")) this.pos++
    if (!this.atEnd()) this.pos++ // consume ';'
    this.pendingDescription = []
  }

  private skipParenGroup(): void {
    this.expect("punct", "(")
    let depth = 1
    while (depth > 0 && !this.atEnd()) {
      if (this.peekPunct("(")) depth++
      else if (this.peekPunct(")")) depth--
      this.pos++
    }
  }

  private skipBalancedBraceBlock(): void {
    // Skip tokens up to and including the matching '}' of the next '{' seen
    // (used for `interface { ... }` bodies, which this converter doesn't
    // model — see module doc comment).
    while (!this.atEnd() && !this.peekPunct("{")) this.pos++
    if (this.atEnd()) return
    this.pos++ // consume '{'
    let depth = 1
    while (depth > 0 && !this.atEnd()) {
      if (this.peekPunct("{")) depth++
      else if (this.peekPunct("}")) depth--
      this.pos++
    }
    this.pendingDescription = []
  }

  private parseAnnotations(): CapnpAnnotation[] {
    const annotations: CapnpAnnotation[] = []
    while (this.peekPunct("$")) {
      this.pos++
      let name = this.expect("id").value
      while (this.peekPunct(".")) {
        this.pos++
        name += `.${this.expect("id").value}`
      }
      let value: string | number | boolean | undefined
      if (this.peekPunct("(")) {
        this.pos++
        value = this.parseConstValue()
        this.expect("punct", ")")
      }
      annotations.push(value === undefined ? { name } : { name, value })
    }
    return annotations
  }

  private parseConstValue(): string | number | boolean {
    const tok = this.current()
    if (tok === undefined) throw new ParseError("expected a constant value, got EOF")
    if (tok.type === "num") {
      this.pos++
      return parseNumber(tok.value)
    }
    if (tok.type === "str") {
      this.pos++
      return tok.value
    }
    if (tok.type === "id") {
      this.pos++
      if (tok.value === "true") return true
      if (tok.value === "false") return false
      return tok.value // bare identifier — an enumerant name or similar
    }
    throw new ParseError(`unexpected token in constant value: ${tok.type} "${tok.value}" (line ${tok.line})`)
  }

  private parseType(): CapnpTypeDesc {
    let name = this.expect("id").value
    while (this.peekPunct(".")) {
      this.pos++
      name += `.${this.expect("id").value}`
    }
    let args: CapnpTypeDesc[] | undefined
    if (this.peekPunct("(")) {
      this.pos++
      args = [this.parseType()]
      while (this.peekPunct(",")) {
        this.pos++
        args.push(this.parseType())
      }
      this.expect("punct", ")")
    }
    return args === undefined ? { name } : { name, args }
  }

  private parseUnionVariants(): CapnpFieldMember[] {
    const variants: CapnpFieldMember[] = []
    while (!this.peekPunct("}")) {
      const description = this.flushDescription()
      const name = this.expect("id").value
      let ordinal: number | undefined
      if (this.peekPunct("@")) {
        this.pos++
        ordinal = parseNumber(this.expect("num").value)
      }
      this.expect("punct", ":")
      const type = this.parseType()
      let defaultValue: string | number | boolean | undefined
      if (this.peekPunct("=")) {
        this.pos++
        defaultValue = this.parseConstValue()
      }
      const annotations = this.parseAnnotations()
      this.expect("punct", ";")
      variants.push({
        kind: "field",
        name,
        ...(ordinal !== undefined ? { ordinal } : {}),
        type,
        ...(defaultValue !== undefined ? { default: defaultValue } : {}),
        annotations,
        ...(description !== undefined ? { description } : {}),
      })
    }
    return variants
  }

  private parseStructMember(): CapnpMember | { readonly kind: "nestedStruct"; readonly decl: CapnpStructDecl } | { readonly kind: "nestedEnum"; readonly decl: CapnpEnumDecl } | { readonly kind: "skip" } {
    const description = this.flushDescription()
    if (this.peekId("struct")) return { kind: "nestedStruct", decl: this.parseStructBody(description) }
    if (this.peekId("enum")) return { kind: "nestedEnum", decl: this.parseEnumBody(description) }
    if (this.peekId("const")) {
      this.skipUntilSemicolon()
      return { kind: "skip" }
    }
    if (this.peekId("union") && this.tokens[this.pos + 1]?.type === "punct" && this.tokens[this.pos + 1]?.value === "{") {
      // Anonymous union block, directly inside a struct/group — no name, no
      // ordinal, no trailing ';' (it's a brace block like a nested struct).
      this.pos++ // 'union'
      this.expect("punct", "{")
      const variants = this.parseUnionVariants()
      this.expect("punct", "}")
      return { kind: "union", variants, annotations: [], ...(description !== undefined ? { description } : {}) }
    }

    const name = this.expect("id").value
    let ordinal: number | undefined
    if (this.peekPunct("@")) {
      this.pos++
      ordinal = parseNumber(this.expect("num").value)
    }
    this.expect("punct", ":")

    if (this.peekId("union")) {
      this.pos++
      this.expect("punct", "{")
      const variants = this.parseUnionVariants()
      this.expect("punct", "}")
      return { kind: "union", name, ...(ordinal !== undefined ? { ordinal } : {}), variants, annotations: [], ...(description !== undefined ? { description } : {}) }
    }
    if (this.peekId("group")) {
      this.pos++
      this.expect("punct", "{")
      const members: CapnpMember[] = []
      const nestedStructs: CapnpStructDecl[] = []
      const nestedEnums: CapnpEnumDecl[] = []
      while (!this.peekPunct("}")) {
        const m = this.parseStructMember()
        if (m.kind === "nestedStruct") nestedStructs.push(m.decl)
        else if (m.kind === "nestedEnum") nestedEnums.push(m.decl)
        else if (m.kind !== "skip") members.push(m)
      }
      this.expect("punct", "}")
      return { kind: "group", name, ...(ordinal !== undefined ? { ordinal } : {}), members, annotations: [], ...(description !== undefined ? { description } : {}) }
    }

    const type = this.parseType()
    let defaultValue: string | number | boolean | undefined
    if (this.peekPunct("=")) {
      this.pos++
      defaultValue = this.parseConstValue()
    }
    const annotations = this.parseAnnotations()
    this.expect("punct", ";")
    return {
      kind: "field",
      name,
      ...(ordinal !== undefined ? { ordinal } : {}),
      type,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      annotations,
      ...(description !== undefined ? { description } : {}),
    }
  }

  parseStructBody(description?: string): CapnpStructDecl {
    this.expect("id", "struct")
    const name = this.expect("id").value
    if (this.peekPunct("(")) this.skipParenGroup() // generic params, e.g. `struct List(T)` — not modeled
    const preAnnotations = this.parseAnnotations()
    this.expect("punct", "{")
    const members: CapnpMember[] = []
    const nestedStructs: CapnpStructDecl[] = []
    const nestedEnums: CapnpEnumDecl[] = []
    while (!this.peekPunct("}")) {
      const m = this.parseStructMember()
      if (m.kind === "nestedStruct") nestedStructs.push(m.decl)
      else if (m.kind === "nestedEnum") nestedEnums.push(m.decl)
      else if (m.kind !== "skip") members.push(m)
    }
    this.expect("punct", "}")
    return {
      kind: "struct",
      name,
      members,
      nestedStructs,
      nestedEnums,
      annotations: preAnnotations,
      ...(description !== undefined ? { description } : {}),
    }
  }

  parseEnumBody(description?: string): CapnpEnumDecl {
    this.expect("id", "enum")
    const name = this.expect("id").value
    const preAnnotations = this.parseAnnotations()
    this.expect("punct", "{")
    const members: CapnpEnumeratorDecl[] = []
    let nextOrdinal = 0
    while (!this.peekPunct("}")) {
      const memberDescription = this.flushDescription()
      const mname = this.expect("id").value
      let ordinal = nextOrdinal
      if (this.peekPunct("@")) {
        this.pos++
        ordinal = parseNumber(this.expect("num").value)
      }
      const annotations = this.parseAnnotations()
      this.expect("punct", ";")
      members.push({ name: mname, ordinal, annotations, ...(memberDescription !== undefined ? { description: memberDescription } : {}) })
      nextOrdinal = ordinal + 1
    }
    this.expect("punct", "}")
    return { kind: "enum", name, members, annotations: preAnnotations, ...(description !== undefined ? { description } : {}) }
  }

  parseFile(): CapnpSchemaFile {
    const structs: CapnpStructDecl[] = []
    const enums: CapnpEnumDecl[] = []
    while (!this.atEnd()) {
      const description = this.flushDescription()
      if (this.peekPunct("@")) {
        // Top-level file ID: `@0xabc123...;`
        this.skipUntilSemicolon()
        continue
      }
      const tok = this.current()
      if (tok === undefined) break
      if (tok.type !== "id") {
        this.pos++
        continue
      }
      switch (tok.value) {
        case "using":
        case "annotation":
        case "const":
          this.skipUntilSemicolon()
          break
        case "struct":
          structs.push(this.parseStructBody(description))
          break
        case "enum":
          enums.push(this.parseEnumBody(description))
          break
        case "interface":
          this.skipBalancedBraceBlock()
          break
        default:
          this.pos++
      }
    }
    return { structs, enums }
  }
}

/** Parse `.capnp` schema text into its struct/enum declaration tree, without
 * converting to `TypeRef` — exported standalone for callers/tests that want
 * to inspect the parse result directly (mirrors `from-protobuf.ts`'s
 * `parseProtoText` being independently callable from `fromProtoText`). */
export function parseCapnpSchema(source: string): CapnpSchemaFile {
  return new Parser(tokenize(source)).parseFile()
}

// ============================================================================
// Registry — flatten nested struct/enum declarations (including ones
// declared inside `group` blocks) into dotted-path entries, mirroring
// from-protobuf.ts's registerMessages/registerEnums.
// ============================================================================

type RegistryEntry = { readonly kind: "struct"; readonly decl: CapnpStructDecl } | { readonly kind: "enum"; readonly decl: CapnpEnumDecl }

function registerFromMembers(members: readonly CapnpMember[], scope: string, registry: Map<string, RegistryEntry>): void {
  for (const m of members) {
    if (m.kind === "group") registerFromMembers(m.members, scope, registry)
  }
}

function registerDecls(structs: readonly CapnpStructDecl[], enums: readonly CapnpEnumDecl[], prefix: string, registry: Map<string, RegistryEntry>): void {
  for (const s of structs) {
    const qualified = prefix === "" ? s.name : `${prefix}.${s.name}`
    registry.set(qualified, { kind: "struct", decl: s })
    registerDecls(s.nestedStructs, s.nestedEnums, qualified, registry)
    registerFromMembers(s.members, qualified, registry)
  }
  for (const e of enums) {
    const qualified = prefix === "" ? e.name : `${prefix}.${e.name}`
    registry.set(qualified, { kind: "enum", decl: e })
  }
}

/** Resolve a type name (possibly dotted, e.g. `Outer.Inner`) against the flat
 * registry: exact match, then self/enclosing scope search outward (Cap'n
 * Proto's own nested-scoping rules — https://capnproto.org/language.html#nested-types),
 * then a last-resort suffix match. Falls back to the raw name unresolved
 * (a dangling `ref`) rather than throwing, matching from-protobuf.ts's
 * `resolveTypeName` convention. */
function resolveTypeName(name: string, registry: Map<string, RegistryEntry>, selfPath: string): string {
  if (registry.has(name)) return name

  const parts = selfPath === "" ? [] : selfPath.split(".")
  for (let i = parts.length; i >= 0; i--) {
    const candidate = [...parts.slice(0, i), name].join(".")
    if (registry.has(candidate)) return candidate
  }

  const suffix = `.${name}`
  for (const key of registry.keys()) {
    if (key === name || key.endsWith(suffix)) return key
  }

  return name
}

// ============================================================================
// Type conversion
// ============================================================================

// Built-in types: https://capnproto.org/language.html#built-in-types
const builtinHandlers: Record<string, () => TypeRef> = {
  Void: () => t(types.void),
  Bool: () => t(types.boolean),
  Int8: () => int8(),
  Int16: () => int16(),
  Int32: () => int32(),
  Int64: () => int64(),
  UInt8: () => uint8(),
  UInt16: () => uint16(),
  UInt32: () => uint32(),
  UInt64: () => uint64(),
  Float32: () => float32(),
  Float64: () => float64(),
  Text: () => t(types.string),
  Data: () => bytes(),
  // Opaque/reflective Cap'n Proto constructs with no structural TypeRef
  // equivalent — degrade to `unknown`, the reverse of capnp.ts's own
  // AnyPointer fallback for `unknown`/`instance`/`function`/etc.
  AnyPointer: () => t(types.unknown),
  AnyStruct: () => t(types.unknown),
  AnyList: () => t(types.unknown),
  Capability: () => t(types.unknown),
}

function withMeta(ref: TypeRef, extra: Record<string, unknown>): TypeRef {
  if (Object.keys(extra).length === 0) return ref
  return { shape: ref.shape, meta: { ...ref.meta, ...extra } }
}

function convertTypeDesc(desc: CapnpTypeDesc, registry: Map<string, RegistryEntry>, selfPath: string): TypeRef {
  if (desc.name === "List") {
    const elementDesc = desc.args?.[0]
    const element = elementDesc !== undefined ? convertTypeDesc(elementDesc, registry, selfPath) : t(types.unknown)
    return t(types.array(element))
  }
  const builtin = builtinHandlers[desc.name]
  if (builtin !== undefined) return builtin()

  const resolved = resolveTypeName(desc.name, registry, selfPath)
  return t(types.ref(resolved))
}

function memberMeta(m: { readonly ordinal?: number; readonly annotations: readonly CapnpAnnotation[]; readonly description?: string }): Record<string, unknown> {
  const meta: Record<string, unknown> = {}
  if (m.ordinal !== undefined) meta.ordinal = m.ordinal
  if (m.annotations.length > 0) meta.annotations = m.annotations
  if (m.description !== undefined) meta.description = m.description
  return meta
}

/** Convert a single field's declared type + default/annotations/ordinal into
 * a `TypeRef` — exported standalone so a lone field can be converted without
 * a whole struct/file around it (mirrors from-protobuf.ts's `fromProtoField`). */
export function fromCapnpField(field: CapnpFieldMember, registry: Map<string, RegistryEntry> = new Map(), selfPath = ""): TypeRef {
  const base = convertTypeDesc(field.type, registry, selfPath)
  const meta = memberMeta(field)
  if (field.default !== undefined) meta.default = field.default
  return withMeta(base, meta)
}

/** Convert a struct/group's member list into an `object`-field record —
 * shared by top-level struct conversion and nested `group` conversion, since
 * a group is structurally just an inline, unnamed struct
 * (https://capnproto.org/language.html#groups). */
function convertMembers(members: readonly CapnpMember[], registry: Map<string, RegistryEntry>, selfPath: string): Record<string, TypeRef> {
  const fields: Record<string, TypeRef> = {}
  let anonUnionCount = 0

  for (const m of members) {
    if (m.kind === "field") {
      fields[m.name] = fromCapnpField(m, registry, selfPath)
      continue
    }
    if (m.kind === "group") {
      fields[m.name] = withMeta(t(types.object(convertMembers(m.members, registry, selfPath))), memberMeta(m))
      continue
    }
    // m.kind === "union": a Cap'n Proto union always has exactly one active
    // variant (no "unset" state, unlike protobuf's oneof — see
    // from-protobuf.ts's messageToTypeRef oneof handling for the contrast),
    // so no `meta.optional` is added here.
    const variants = m.variants.map((v) => withMeta(fromCapnpField(v, registry, selfPath), { capnpFieldName: v.name }))
    const key = m.name ?? `__anonymousUnion${anonUnionCount++}`
    const meta = memberMeta(m)
    if (m.name === undefined) meta.anonymous = true
    fields[key] = withMeta(t(types.union(variants)), meta)
  }

  return fields
}

function structToTypeRef(decl: CapnpStructDecl, registry: Map<string, RegistryEntry>, selfPath: string): TypeRef {
  const meta: Record<string, unknown> = {}
  if (decl.description !== undefined) meta.description = decl.description
  if (decl.annotations.length > 0) meta.annotations = decl.annotations
  return t(types.object(convertMembers(decl.members, registry, selfPath)), meta)
}

function enumToTypeRef(decl: CapnpEnumDecl): TypeRef {
  // Cap'n Proto enumerants are assigned sequential ordinals by declaration
  // order by default (§ "Enums") but MAY be declared out of order — sort by
  // ordinal so `members`' array order matches wire order, and keep the exact
  // name -> ordinal mapping in meta for callers that need it precisely
  // (`types.enum`'s `members` is a bare name array with no numbering slot).
  const sorted = [...decl.members].sort((a, b) => a.ordinal - b.ordinal)
  const meta: Record<string, unknown> = { ordinals: Object.fromEntries(sorted.map((m) => [m.name, m.ordinal])) }
  if (decl.description !== undefined) meta.description = decl.description
  if (decl.annotations.length > 0) meta.annotations = decl.annotations
  return t(
    types.enum(sorted.map((m) => m.name)),
    meta,
  )
}

// ============================================================================
// File-level entry point
// ============================================================================

/**
 * Convert `.capnp` schema text into a flat map of struct/enum name ->
 * `TypeRef` — every struct/enum in the file, top-level and nested (keyed by
 * dotted path, e.g. `"Person"`, `"Person.Address"`), with struct/enum-typed
 * fields resolved to `{ kind: "ref", target }` pointing at another key in
 * the same map (see module doc comment for why this is a flat record rather
 * than a single-root `TypeRefDocument`).
 */
export function fromCapnp(schema: string): Record<string, TypeRef> {
  const file = parseCapnpSchema(schema)
  const registry = new Map<string, RegistryEntry>()
  registerDecls(file.structs, file.enums, "", registry)

  const result: Record<string, TypeRef> = {}
  for (const [name, entry] of registry) {
    result[name] = entry.kind === "struct" ? structToTypeRef(entry.decl, registry, name) : enumToTypeRef(entry.decl)
  }
  return result
}
