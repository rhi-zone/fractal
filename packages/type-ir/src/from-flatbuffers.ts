// packages/type-ir/src/from-flatbuffers.ts — @rhi-zone/fractal-type-ir/from-flatbuffers
//
// FlatBuffers schema (.fbs) text -> TypeRef, the reverse direction of
// flatbuffers.ts's TypeRef -> .fbs projector (toFlatBuffers/toFlatBuffersTable/
// toFlatBuffersDeclarations). Read flatbuffers.ts first — its `handlers` table
// and doc comments document the FlatBuffers schema grammar
// (https://flatbuffers.dev/schema/) and give the exact strings this parser
// must read back.
//
// Unlike from-protobuf.ts, there is exactly ONE entry point here
// (`fromFlatbuffers`) rather than a descriptor-JSON + text-parser pair:
// FlatBuffers has no self-describing JSON descriptor format the way protobuf's
// own descriptor.proto is a protobuf message — `.fbs` text is the only input
// shape worth supporting. There's also no widely-used JS/TS `.fbs` grammar
// library (unlike protobufjs for `.proto`), so this is a hand-rolled
// tokenizer + recursive-descent parser.
//
// `fromFlatbuffers` returns a flat `Record<string, TypeRef>` (not a
// `TypeRefDocument`) — every top-level table/struct/enum/union declaration,
// keyed by its namespace-qualified dotted name (`namespace a.b; table Foo` ->
// key `"a.b.Foo"`). Field/union-member type references that name another
// declared type become `{ kind: "ref", target: <qualified name> }`, resolved
// against this same flat map — mirroring from-protobuf.ts's
// `resolveTypeName` fallback chain (see `resolveIdent` below). `interface`/
// `rpc_service` are out of scope (see the `rpc_service` case in the top-level
// loop) — this ingester's domain is schema/data types, matching how
// `from-protobuf.ts` explicitly skips `service`/`rpc` blocks too.

import { t, types, type TypeRef } from "./index.ts"
import { float32, float64 } from "./kinds/float-widths.ts"
import { int16, int32, int64, int8, uint16, uint32, uint64, uint8 } from "./kinds/int-widths.ts"

// ============================================================================
// Tokenizer
// ============================================================================

type Token =
  | { readonly kind: "ident"; readonly value: string }
  | { readonly kind: "number"; readonly value: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "punct"; readonly value: string }

const PUNCT_CHARS = "{}()[]:;,=.-"

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c)
}
function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c)
}
function isDigit(c: string): boolean {
  return /[0-9]/.test(c)
}

/**
 * Tokenize `.fbs` source. `//` and `///` line comments (flatbuffers.dev has no
 * block-comment form worth supporting — see this file's header) are stripped
 * here rather than left for the parser to skip.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  const n = source.length
  let i = 0
  while (i < n) {
    const c = source[i]!
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++
      continue
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++
      continue
    }
    if (c === '"') {
      let j = i + 1
      let value = ""
      while (j < n && source[j] !== '"') {
        if (source[j] === "\\" && j + 1 < n) {
          value += source[j + 1]
          j += 2
        } else {
          value += source[j]
          j++
        }
      }
      tokens.push({ kind: "string", value })
      i = j + 1
      continue
    }
    if (isIdentStart(c)) {
      let j = i + 1
      while (j < n && isIdentPart(source[j]!)) j++
      tokens.push({ kind: "ident", value: source.slice(i, j) })
      i = j
      continue
    }
    if (isDigit(c)) {
      let j = i + 1
      while (j < n && isDigit(source[j]!)) j++
      if (source[j] === "." && isDigit(source[j + 1] ?? "")) {
        j++
        while (j < n && isDigit(source[j]!)) j++
      }
      if (source[j] === "e" || source[j] === "E") {
        let k = j + 1
        if (source[k] === "+" || source[k] === "-") k++
        if (isDigit(source[k] ?? "")) {
          j = k
          while (j < n && isDigit(source[j]!)) j++
        }
      }
      tokens.push({ kind: "number", value: source.slice(i, j) })
      i = j
      continue
    }
    if (PUNCT_CHARS.includes(c)) {
      tokens.push({ kind: "punct", value: c })
      i++
      continue
    }
    // Unrecognized character — skip defensively rather than throw (honest
    // best-effort parsing, matching this package's other ingesters).
    i++
  }
  return tokens
}

// ============================================================================
// Raw (pre-resolution) declaration shapes gathered by the parser
// ============================================================================

type TypeExpr = { readonly vector: boolean; readonly ident: string }

type AttrEntry = { readonly name: string; readonly value: string | number | boolean }

type RawField = {
  readonly name: string
  readonly typeExpr: TypeExpr
  readonly defaultValue?: string | number | boolean
  readonly attrs: readonly AttrEntry[]
}

type RawTable = {
  readonly name: string
  readonly namespace: string
  readonly isStruct: boolean
  readonly fields: readonly RawField[]
}

type RawEnumMember = { readonly name: string; readonly value?: number }

type RawEnum = {
  readonly name: string
  readonly namespace: string
  readonly base: string
  readonly members: readonly RawEnumMember[]
}

type RawUnionMember = { readonly alias?: string; readonly type: string }

type RawUnion = {
  readonly name: string
  readonly namespace: string
  readonly members: readonly RawUnionMember[]
}

function qualify(namespace: string, name: string): string {
  return namespace === "" ? name : `${namespace}.${name}`
}

/**
 * Resolve a bare (or already-dotted) field/union-member type identifier
 * against the flat set of every declared top-level name, namespace-aware.
 * Mirrors from-protobuf.ts's `resolveTypeName` fallback chain: (1) qualified
 * with the CURRENT namespace, (2) the bare identifier as a top-level (no-
 * namespace) name — which also covers the case where `ident` is already a
 * fully-qualified dotted name matching a registered key exactly, (3) any
 * registered key whose last dotted segment matches (last resort). Falls back
 * to the raw identifier unresolved — a dangling ref — rather than throwing,
 * per this package's honest-degrade convention for unrecognized input.
 */
function resolveIdent(ident: string, namespace: string, known: ReadonlySet<string>): string {
  if (namespace !== "") {
    const qualified = `${namespace}.${ident}`
    if (known.has(qualified)) return qualified
  }
  if (known.has(ident)) return ident
  const lastSegment = ident.split(".").at(-1) ?? ident
  for (const key of known) {
    if (key.split(".").at(-1) === lastSegment) return key
  }
  return ident
}

// ============================================================================
// Parser
// ============================================================================

class ParseCursor {
  private pos = 0
  constructor(private readonly tokens: readonly Token[]) {}

  peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset]
  }

  next(): Token | undefined {
    const tok = this.tokens[this.pos]
    if (tok !== undefined) this.pos++
    return tok
  }

  atEnd(): boolean {
    return this.pos >= this.tokens.length
  }

  isPunct(value: string, offset = 0): boolean {
    const tok = this.peek(offset)
    return tok !== undefined && tok.kind === "punct" && tok.value === value
  }

  expectPunct(value: string): void {
    const tok = this.next()
    if (tok === undefined || tok.kind !== "punct" || tok.value !== value) {
      throw new Error(`fromFlatbuffers: expected "${value}", got ${tok === undefined ? "end of input" : JSON.stringify(tok)}`)
    }
  }

  expectIdentValue(): string {
    const tok = this.next()
    if (tok === undefined || tok.kind !== "ident") {
      throw new Error(`fromFlatbuffers: expected identifier, got ${tok === undefined ? "end of input" : JSON.stringify(tok)}`)
    }
    return tok.value
  }

  /** A dotted identifier path (`a.b.Foo`), used for namespace paths and
   * type/union-member references — both allow a leading-dot-qualified form. */
  parseDottedIdent(): string {
    let name = this.expectIdentValue()
    while (this.isPunct(".")) {
      this.next()
      name += `.${this.expectIdentValue()}`
    }
    return name
  }

  parseType(): TypeExpr {
    if (this.isPunct("[")) {
      this.next()
      const ident = this.parseDottedIdent()
      this.expectPunct("]")
      return { vector: true, ident }
    }
    return { vector: false, ident: this.parseDottedIdent() }
  }

  /** A scalar/identifier/string/bool literal used as a default value or an
   * attribute's `: value`. Handles an optional leading `-` for numeric
   * literals (the tokenizer never emits negative numbers as a single token). */
  parseLiteral(): string | number | boolean {
    let negate = false
    if (this.isPunct("-")) {
      this.next()
      negate = true
    }
    const tok = this.next()
    if (tok === undefined) throw new Error("fromFlatbuffers: expected a value, got end of input")
    if (tok.kind === "number") {
      const n = Number(tok.value)
      return negate ? -n : n
    }
    if (tok.kind === "string") return tok.value
    if (tok.kind === "ident") {
      if (tok.value === "true") return true
      if (tok.value === "false") return false
      return tok.value
    }
    throw new Error(`fromFlatbuffers: unexpected token as value: ${JSON.stringify(tok)}`)
  }

  parseAttributeList(): AttrEntry[] {
    this.expectPunct("(")
    const entries: AttrEntry[] = []
    while (!this.isPunct(")")) {
      const name = this.expectIdentValue()
      let value: string | number | boolean = true
      if (this.isPunct(":")) {
        this.next()
        value = this.parseLiteral()
      }
      entries.push({ name, value })
      if (this.isPunct(",")) this.next()
    }
    this.expectPunct(")")
    return entries
  }

  parseField(): RawField {
    const name = this.expectIdentValue()
    this.expectPunct(":")
    const typeExpr = this.parseType()
    let defaultValue: string | number | boolean | undefined
    if (this.isPunct("=")) {
      this.next()
      defaultValue = this.parseLiteral()
    }
    const attrs = this.isPunct("(") ? this.parseAttributeList() : []
    this.expectPunct(";")
    return defaultValue === undefined ? { name, typeExpr, attrs } : { name, typeExpr, defaultValue, attrs }
  }

  parseFieldBody(): RawField[] {
    this.expectPunct("{")
    const fields: RawField[] = []
    while (!this.isPunct("}")) fields.push(this.parseField())
    this.expectPunct("}")
    return fields
  }

  parseEnumBody(): RawEnumMember[] {
    this.expectPunct("{")
    const members: RawEnumMember[] = []
    while (!this.isPunct("}")) {
      const name = this.expectIdentValue()
      let value: number | undefined
      if (this.isPunct("=")) {
        this.next()
        const literal = this.parseLiteral()
        value = typeof literal === "number" ? literal : Number(literal)
      }
      members.push(value === undefined ? { name } : { name, value })
      if (this.isPunct(",")) this.next()
    }
    this.expectPunct("}")
    return members
  }

  parseUnionBody(): RawUnionMember[] {
    this.expectPunct("{")
    const members: RawUnionMember[] = []
    while (!this.isPunct("}")) {
      const first = this.parseDottedIdent()
      if (this.isPunct(":")) {
        this.next()
        const type = this.parseDottedIdent()
        members.push({ alias: first, type })
      } else {
        members.push({ type: first })
      }
      if (this.isPunct(",")) this.next()
    }
    this.expectPunct("}")
    return members
  }

  /** Skip a brace-delimited block whose contents this parser doesn't model
   * (currently only `rpc_service` bodies — see the top-level loop). Tracks
   * brace depth only; the method-signature syntax inside (`Name(Req):Resp;`)
   * is never otherwise valid at this nesting so no false-positive braces can
   * appear within it. */
  skipBalancedBraces(): void {
    this.expectPunct("{")
    let depth = 1
    while (depth > 0) {
      const tok = this.next()
      if (tok === undefined) break
      if (tok.kind === "punct" && tok.value === "{") depth++
      else if (tok.kind === "punct" && tok.value === "}") depth--
    }
  }
}

// ============================================================================
// Scalar keyword table — § "Scalars": https://flatbuffers.dev/schema/#scalars
// Both the short alias and the width-suffixed spelling map to the same
// TypeRef builder (`byte`/`int8` both -> int8(), etc.), per the brief's exact
// reverse mapping.
// ============================================================================

const scalarBuilders: Record<string, () => TypeRef> = {
  bool: () => t(types.boolean),
  byte: () => int8(),
  int8: () => int8(),
  ubyte: () => uint8(),
  uint8: () => uint8(),
  short: () => int16(),
  int16: () => int16(),
  ushort: () => uint16(),
  uint16: () => uint16(),
  int: () => int32(),
  int32: () => int32(),
  uint: () => uint32(),
  uint32: () => uint32(),
  long: () => int64(),
  int64: () => int64(),
  ulong: () => uint64(),
  uint64: () => uint64(),
  float: () => float32(),
  float32: () => float32(),
  double: () => float64(),
  float64: () => float64(),
  string: () => t(types.string),
}

function buildBaseTypeRef(ident: string, namespace: string, known: ReadonlySet<string>): TypeRef {
  const scalar = scalarBuilders[ident]
  if (scalar !== undefined) return scalar()
  return t(types.ref(resolveIdent(ident, namespace, known)))
}

function buildTypeRef(expr: TypeExpr, namespace: string, known: ReadonlySet<string>): TypeRef {
  const base = buildBaseTypeRef(expr.ident, namespace, known)
  return expr.vector ? t(types.array(base)) : base
}

// ============================================================================
// Field / table / struct / enum / union conversion
// ============================================================================

function buildFieldTypeRef(field: RawField, namespace: string, known: ReadonlySet<string>, isStruct: boolean): TypeRef {
  const base = buildTypeRef(field.typeExpr, namespace, known)
  const meta: Record<string, unknown> = { ...base.meta }
  const attributes: Record<string, string | number | boolean> = {}
  let required = false

  for (const attr of field.attrs) {
    if (attr.name === "deprecated") meta.deprecated = true
    else if (attr.name === "required") required = true
    else if (attr.name === "id") meta.id = typeof attr.value === "number" ? attr.value : Number(attr.value)
    else attributes[attr.name] = attr.value
  }

  if (Object.keys(attributes).length > 0) meta.attributes = attributes
  if (field.defaultValue !== undefined) meta.default = field.defaultValue
  // Table fields are optional-by-default (§ "Tables vs. Structs":
  // https://flatbuffers.dev/schema/#tables) unless `(required)` was given;
  // struct fields are always implicitly required regardless of attributes.
  if (!isStruct && !required) meta.optional = true

  return { shape: base.shape, meta }
}

function buildTableTypeRef(decl: RawTable, known: ReadonlySet<string>): TypeRef {
  const fields: Record<string, TypeRef> = {}
  for (const field of decl.fields) fields[field.name] = buildFieldTypeRef(field, decl.namespace, known, decl.isStruct)
  return t(types.object(fields), decl.isStruct ? { struct: true } : {})
}

function buildEnumTypeRef(decl: RawEnum): TypeRef {
  const values: Record<string, number> = {}
  const members: string[] = []
  // FlatBuffers-style value computation (§ "Enums":
  // https://flatbuffers.dev/schema/#enums): an unspecified member is the
  // previous value + 1 (0 for the first member with no explicit value); an
  // explicit `= N` member resets the running counter from N.
  let running = -1
  for (const member of decl.members) {
    const value = member.value ?? running + 1
    values[member.name] = value
    running = value
    members.push(member.name)
  }
  return t(types.enum(members), { values, fbsBase: decl.base })
}

function buildUnionTypeRef(decl: RawUnion, known: ReadonlySet<string>): TypeRef {
  const variants: TypeRef[] = []
  const aliases: Record<string, string> = {}
  for (const member of decl.members) {
    const resolved = resolveIdent(member.type, decl.namespace, known)
    variants.push(t(types.ref(resolved)))
    if (member.alias !== undefined) aliases[member.alias] = resolved
  }
  return t(types.union(variants), Object.keys(aliases).length > 0 ? { aliases } : {})
}

// ============================================================================
// Top-level entry point
// ============================================================================

/**
 * Convert `.fbs` schema text into a flat `Record<string, TypeRef>`: every
 * top-level `table`/`struct`/`enum`/`union` declaration, keyed by its
 * namespace-qualified dotted name (see this file's header). `include`,
 * `attribute`, `file_identifier`, `file_extension` statements are recognized
 * and skipped (§ "Schemas": https://flatbuffers.dev/schema/); `root_type`
 * resolves its target (namespace-aware, same as a field reference) and sets
 * `meta.isRootType = true` on that entry; `rpc_service` blocks are recognized
 * well enough not to trip up the parser but are not converted or included in
 * the result (this ingester's scope is schema/data types — see this file's
 * header for the `from-protobuf.ts` precedent).
 */
export function fromFlatbuffers(schema: string): Record<string, TypeRef> {
  const cursor = new ParseCursor(tokenize(schema))

  let currentNamespace = ""
  const rawTables: RawTable[] = []
  const rawEnums: RawEnum[] = []
  const rawUnions: RawUnion[] = []
  let rootType: { readonly name: string; readonly namespace: string } | undefined

  while (!cursor.atEnd()) {
    const tok = cursor.next()
    if (tok === undefined) break
    if (tok.kind !== "ident") continue // stray punctuation between statements — skip defensively

    switch (tok.value) {
      case "namespace": {
        currentNamespace = cursor.isPunct(";") ? "" : cursor.parseDottedIdent()
        cursor.expectPunct(";")
        break
      }
      case "include":
      case "attribute":
      case "file_identifier":
      case "file_extension": {
        cursor.next() // the string literal argument
        cursor.expectPunct(";")
        break
      }
      case "root_type": {
        const name = cursor.parseDottedIdent()
        cursor.expectPunct(";")
        rootType = { name, namespace: currentNamespace }
        break
      }
      case "table":
      case "struct": {
        const isStruct = tok.value === "struct"
        const name = cursor.expectIdentValue()
        const fields = cursor.parseFieldBody()
        rawTables.push({ name, namespace: currentNamespace, isStruct, fields })
        break
      }
      case "enum": {
        const name = cursor.expectIdentValue()
        let base = "int"
        if (cursor.isPunct(":")) {
          cursor.next()
          base = cursor.expectIdentValue()
        }
        const members = cursor.parseEnumBody()
        rawEnums.push({ name, namespace: currentNamespace, base, members })
        break
      }
      case "union": {
        const name = cursor.expectIdentValue()
        const members = cursor.parseUnionBody()
        rawUnions.push({ name, namespace: currentNamespace, members })
        break
      }
      case "rpc_service": {
        cursor.expectIdentValue() // service name — discarded, out of scope (see doc comment)
        cursor.skipBalancedBraces()
        break
      }
      default:
        // Unrecognized top-level keyword — ignore rather than throw, matching
        // this package's honest-degrade convention for unmodeled input.
        break
    }
  }

  const known = new Set<string>()
  for (const decl of rawTables) known.add(qualify(decl.namespace, decl.name))
  for (const decl of rawEnums) known.add(qualify(decl.namespace, decl.name))
  for (const decl of rawUnions) known.add(qualify(decl.namespace, decl.name))

  const result: Record<string, TypeRef> = {}
  for (const decl of rawTables) result[qualify(decl.namespace, decl.name)] = buildTableTypeRef(decl, known)
  for (const decl of rawEnums) result[qualify(decl.namespace, decl.name)] = buildEnumTypeRef(decl)
  for (const decl of rawUnions) result[qualify(decl.namespace, decl.name)] = buildUnionTypeRef(decl, known)

  if (rootType !== undefined) {
    const resolved = resolveIdent(rootType.name, rootType.namespace, known)
    const existing = result[resolved]
    if (existing !== undefined) result[resolved] = { shape: existing.shape, meta: { ...existing.meta, isRootType: true } }
  }

  return result
}
