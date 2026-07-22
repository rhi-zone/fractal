import { resolve, type TypeRef, type TypeShape } from "./index.ts"

// packages/type-ir/src/go.ts — @rhi-zone/fractal-type-ir/go
//
// TypeRef -> idiomatic Go type declarations (structs with `json` tags, slices,
// maps, string-backed const enums, pointer-for-optional fields, and a
// marker-interface encoding of sum types). Unlike toTypeScript (a single
// expression per TypeRef), Go has no anonymous-struct-with-a-name construct
// worth using here — every object/enum/union/tuple/interface kind is hoisted
// to its own top-level named declaration, the same problem protobuf.ts's
// `nestedMessages` and capnp.ts's `nestedStructs` solve for their formats,
// just flattened to package level (Go has no C-style nested-type-declaration
// idiom) rather than kept lexically nested.

type Converter = () => string

const leaf =
  (type: string): Converter =>
  () =>
    type

function quote(value: string): string {
  return JSON.stringify(value)
}

// Every leaf/primitive kind this projector knows how to render directly —
// dispatched via `resolve` so extension kinds (kinds/wire-numerics.ts,
// kinds/semantic-strings.ts, kinds/temporal.ts, kinds/bytes.ts, …) that
// registerParent() onto one of these fall back correctly without this file
// knowing their names, same pattern typescript.ts/protobuf.ts/capnp.ts use.
const primitiveHandlers: Record<string, Converter> = {
  boolean: leaf("bool"),
  number: leaf("float64"),
  integer: leaf("int"),
  int8: leaf("int8"),
  int16: leaf("int16"),
  int32: leaf("int32"),
  int64: leaf("int64"),
  uint8: leaf("uint8"),
  uint16: leaf("uint16"),
  uint32: leaf("uint32"),
  uint64: leaf("uint64"),
  float32: leaf("float32"),
  float64: leaf("float64"),
  string: leaf("string"),
  uuid: leaf("string"),
  uri: leaf("string"),
  email: leaf("string"),
  // encoding/json (https://pkg.go.dev/encoding/json) unmarshals RFC 3339
  // timestamps into time.Time natively — both datetime and date (type-ir's
  // `Date` domain type, see kinds/date-time.ts) map here, same as protobuf.ts
  // collapses both onto google.protobuf.Timestamp. The caller assembling the
  // emitted source is responsible for `import "time"`, same convention
  // `instance`/`page` use elsewhere in this file for their own imports.
  datetime: leaf("time.Time"),
  date: leaf("time.Time"),
  time: leaf("string"),
  duration: leaf("string"),
  bytes: leaf("[]byte"),
  // interface{} is Go's only universal value holder pre-generics; `null`
  // specifically (not `unknown`) still degrades here since Go has no literal
  // null type distinct from "absence of a concrete type".
  null: leaf("interface{}"),
  // struct{} is Go's idiomatic zero-width type (e.g. `chan struct{}`,
  // `map[string]struct{}`) — the closest analogue to a type with no
  // meaningful payload, used for both `void` and the uninhabited `never`.
  void: leaf("struct{}"),
  never: leaf("struct{}"),
  unknown: leaf("interface{}"),
}

// Kinds whose Go rendering is already a nil-able reference type (slice, map,
// interface, func value) — encoding/json's `omitempty` already omits a nil
// value of these, so wrapping them in a pointer on top would be redundant,
// non-idiomatic Go. Value-kind fields (struct, string-backed enum, tuple
// struct, primitives) have no such nil zero value, so `*T` is the only way to
// distinguish "absent" from "present, zero value" for those.
const referenceKinds = new Set([
  "array",
  "stream",
  "page",
  "map",
  "union",
  "unknown",
  "null",
  "function",
  "method",
  "interface",
])

const hoistingKinds = new Set(["object", "enum", "union", "interface", "tuple"])

interface Ctx {
  decls: string[]
}

/** Sanitize an arbitrary field/type/enum-member name into an exported Go
 * identifier: split on non-alphanumeric runs, capitalize each part, and
 * prefix a leading digit (Go identifiers can't start with one). */
function ident(raw: string): string {
  const parts = raw.split(/[^A-Za-z0-9]+/).filter((p) => p.length > 0)
  const joined = parts.map((p) => p[0]!.toUpperCase() + p.slice(1)).join("")
  if (joined.length === 0) return "Field"
  return /^[0-9]/.test(joined) ? `_${joined}` : joined
}

function uniqueLabel(base: string, used: Set<string>): string {
  let label = ident(base)
  let i = 2
  while (used.has(label)) {
    label = `${ident(base)}${i}`
    i++
  }
  used.add(label)
  return label
}

// Go doc-comment convention (https://go.dev/doc/comment): a comment
// immediately preceding a declaration IS its doc comment, and godoc/golint
// expect the first line to begin with the declared identifier's name.
// Deprecation notices follow the standard "Deprecated: ..." paragraph
// convention (https://go.dev/wiki/Deprecated), set off from the description
// by a blank comment line when both are present.
function docComment(name: string, meta: Readonly<Record<string, unknown>>): string {
  const description = typeof meta.description === "string" ? meta.description : undefined
  const deprecatedMessage = typeof meta.deprecated === "string" ? meta.deprecated : undefined
  const isDeprecated = meta.deprecated === true || deprecatedMessage !== undefined
  const lines: string[] = []
  if (description !== undefined) lines.push(`// ${name} ${description}`)
  if (isDeprecated) {
    if (lines.length > 0) lines.push("//")
    lines.push(`// Deprecated: ${deprecatedMessage ?? `${name} is deprecated.`}`)
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`
}

function fieldLine(name: string, jsonName: string, goFieldType: string, optional: boolean): string {
  const jsonTag = optional ? `${jsonName},omitempty` : jsonName
  return `\t${ident(name)} ${goFieldType} \`json:${quote(jsonTag)}\``
}

function objectDecl(ref: TypeRef, hint: string, ctx: Ctx): string {
  const shape = ref.shape as TypeShape & { kind: "object" }
  const name = ident(hint)
  const fields = Object.entries(shape.fields).map(([fieldName, fieldRef]) => {
    const optional = fieldRef.meta.optional === true || fieldRef.meta.nullable === true
    const baseType = goType(fieldRef, `${name}${ident(fieldName)}`, ctx)
    const goFieldType = optional && !referenceKinds.has(fieldRef.shape.kind) ? `*${baseType}` : baseType
    return fieldLine(fieldName, fieldName, goFieldType, optional)
  })
  ctx.decls.push(`${docComment(name, ref.meta)}type ${name} struct {\n${fields.join("\n")}\n}`)
  return name
}

function tupleDecl(ref: TypeRef, hint: string, ctx: Ctx): string {
  const shape = ref.shape as TypeShape & { kind: "tuple" }
  const name = ident(hint)
  const fields = shape.elements.map((element, i) => {
    const fieldType = goType(element, `${name}F${i}`, ctx)
    return fieldLine(`F${i}`, String(i), fieldType, false)
  })
  ctx.decls.push(`${docComment(name, ref.meta)}type ${name} struct {\n${fields.join("\n")}\n}`)
  return name
}

// String-backed const block (rather than an iota int) — enum members here
// are semantic strings that must round-trip through JSON exactly, so the
// value itself (not an arbitrary ordinal) is what encoding/json needs to see.
function enumDecl(ref: TypeRef, hint: string, ctx: Ctx): string {
  const shape = ref.shape as TypeShape & { kind: "enum" }
  const name = ident(hint)
  const used = new Set<string>()
  const constLines = shape.members.map((member) => {
    const memberName = uniqueLabel(`${name}${ident(member)}`, used)
    return `\t${memberName} ${name} = ${quote(member)}`
  })
  ctx.decls.push(`${docComment(name, ref.meta)}type ${name} string`)
  ctx.decls.push(`const (\n${constLines.join("\n")}\n)`)
  return name
}

// Go has no tagged-union/sum-type construct: the idiomatic encoding is a
// marker interface with an unexported method every variant implements (the
// same pattern go/ast, encoding/json's json.RawMessage-based discriminated
// unions, etc. use). A variant that already hoists its own named type
// (object/enum/union/interface/tuple) gets the marker method attached
// directly; a variant that renders as a bare type expression (string, []T,
// map[K]V, …) is wrapped in a locally-defined named type first, since Go
// cannot attach a method to an unnamed/builtin type expression directly.
function unionDecl(ref: TypeRef, hint: string, ctx: Ctx): string {
  const shape = ref.shape as TypeShape & { kind: "union" }
  const name = ident(hint)
  const markerMethod = `is${name}`
  ctx.decls.push(`${docComment(name, ref.meta)}type ${name} interface {\n\t${markerMethod}()\n}`)

  const used = new Set<string>()
  for (const variant of shape.variants) {
    const label = uniqueLabel(variant.shape.kind, used)
    const variantHint = `${name}${label}`
    const rendered = goType(variant, variantHint, ctx)
    if (hoistingKinds.has(variant.shape.kind)) {
      // `rendered` is already the freshly-declared named type from goType above.
      ctx.decls.push(`func (${rendered}) ${markerMethod}() {}`)
    } else {
      const wrapperName = ident(variantHint)
      ctx.decls.push(`type ${wrapperName} ${rendered}`)
      ctx.decls.push(`func (${wrapperName}) ${markerMethod}() {}`)
    }
  }

  return name
}

// A `interface` TypeRef (service method surface — see index.ts's
// TypeKinds.interface doc comment) maps onto Go's own native `interface`
// construct directly — unlike `union` above, no marker-method trick is
// needed here since this already IS Go's real interface type.
function interfaceDecl(ref: TypeRef, hint: string, ctx: Ctx): string {
  const shape = ref.shape as TypeShape & { kind: "interface" }
  const name = ident(hint)
  const methods = Object.entries(shape.methods).map(([methodName, methodRef]) => {
    const m = methodRef.shape as TypeShape & {
      kind: "method" | "function"
      params: readonly { name: string; type: TypeRef }[]
      returnType: TypeRef
    }
    const paramTypes = m.params.map((p, i) =>
      goType(p.type, `${name}${ident(methodName)}Param${i}`, ctx),
    )
    const isVoid = m.returnType.shape.kind === "void"
    const returnType = isVoid ? "" : ` ${goType(m.returnType, `${name}${ident(methodName)}Result`, ctx)}`
    return `\t${ident(methodName)}(${paramTypes.join(", ")})${returnType}`
  })
  ctx.decls.push(`${docComment(name, ref.meta)}type ${name} interface {\n${methods.join("\n")}\n}`)
  return name
}

function goType(ref: TypeRef, hint: string, ctx: Ctx): string {
  const shape = ref.shape
  switch (shape.kind) {
    case "instance":
      // A class instance carries only nominal identity (className/source),
      // never structure (see TypeKinds.instance's doc comment in index.ts) —
      // rendered as a bare reference to that name, same as typescript.ts's
      // `instance` handler; the caller assembling this source is responsible
      // for the type actually existing/being imported.
      return (shape as TypeShape & { kind: "instance" }).className
    case "ref":
      return ident((shape as TypeShape & { kind: "ref" }).target)
    case "literal": {
      const s = shape as TypeShape & { kind: "literal" }
      if (s.value === null) return "interface{}"
      if (typeof s.value === "string") return "string"
      if (typeof s.value === "boolean") return "bool"
      return Number.isInteger(s.value) ? "int" : "float64"
    }
    case "array": {
      const s = shape as TypeShape & { kind: "array" }
      return `[]${goType(s.element, hint, ctx)}`
    }
    // No native Go streaming value type — degrades to a slice of the element
    // type, the same honest-degrade convention protobuf.ts/capnp.ts use for
    // `stream` in field position.
    case "stream": {
      const s = shape as TypeShape & { kind: "stream" }
      return `[]${goType(s.element, hint, ctx)}`
    }
    // No native Go pagination construct — degrades to a slice of the page's
    // element type, same convention as `stream` above.
    case "page": {
      const s = shape as TypeShape & { kind: "page" }
      return `[]${goType(s.element, hint, ctx)}`
    }
    case "map": {
      const s = shape as TypeShape & { kind: "map" }
      return `map[${goType(s.key, `${hint}Key`, ctx)}]${goType(s.value, `${hint}Value`, ctx)}`
    }
    case "tuple":
      return tupleDecl(ref, hint, ctx)
    case "object":
      return objectDecl(ref, hint, ctx)
    case "enum":
      return enumDecl(ref, hint, ctx)
    case "union":
      return unionDecl(ref, hint, ctx)
    case "interface":
      return interfaceDecl(ref, hint, ctx)
    case "function":
    case "method": {
      const s = shape as TypeShape & {
        kind: "function" | "method"
        params: readonly { name: string; type: TypeRef }[]
        returnType: TypeRef
      }
      // Go func *types* carry no `this`/receiver slot (a bound method's
      // receiver is part of its declaration, not its type) — thisType, if
      // present, has no representation here and is dropped.
      const paramTypes = s.params.map((p, i) => goType(p.type, `${hint}Param${i}`, ctx))
      const returnType = goType(s.returnType, `${hint}Result`, ctx)
      return `func(${paramTypes.join(", ")}) ${returnType}`
    }
    default: {
      const converter = resolve(shape.kind, primitiveHandlers)
      return converter === undefined ? "interface{}" : converter()
    }
  }
}

/**
 * Lower a TypeRef to idiomatic Go source: one or more top-level declarations
 * (structs, string-backed enums, marker-interface unions, …), separated by
 * blank lines, in the order they were first referenced. `name` seeds the
 * root declaration's identifier (defaults to "Root"); if the root itself
 * isn't a kind that hoists its own named declaration (e.g. a bare primitive,
 * slice, or map), an explicit `type Name = <expr>` alias is appended so
 * `name` still resolves to something declared, mirroring toTypeDeclaration's
 * job in typescript.ts.
 */
export function toGo(ref: TypeRef, name = "Root"): string {
  const ctx: Ctx = { decls: [] }
  const rootName = ident(name)
  const topType = goType(ref, name, ctx)
  if (topType !== rootName) {
    ctx.decls.push(`type ${rootName} = ${topType}`)
  }
  return ctx.decls.join("\n\n")
}
