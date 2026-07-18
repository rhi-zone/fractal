import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target)
}

// GraphQL SDL spec: https://spec.graphql.org/October2021/
//
// This is a type-level projector only: it emits SDL type definitions (scalar
// mappings, object/enum/union/interface declarations) — not a full API
// projector with resolvers, root Query/Mutation wiring, or the
// query-vs-mutation/subscription safety axis (see
// docs/archive/fc-op-kinds/projection-graphql.md for that, a different,
// operation-level concern).

type Converter = (shape: TypeShape, meta: Readonly<Record<string, unknown>>) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

function isNullable(meta: Readonly<Record<string, unknown>>): boolean {
  return meta.optional === true || meta.nullable === true
}

// Best-effort conversion for a TypeRef used in *field/argument type position*
// (§ "Type References"). Named-declaration kinds (object/enum/union/
// intersection/interface) need a name to be referenced inline — that comes
// from `meta.typeName`/`meta.enumName`/`meta.unionName` (same open-metadata-
// bag convention protobuf.ts uses `messageName`/`enumName` for); absent a
// name, they degrade to `JSON` rather than being inlined anonymously, since
// GraphQL types are always nominal (§ "Type System").
const handlers: Record<string, Converter> = {
  boolean: leaf("Boolean"),
  number: leaf("Float"),
  integer: leaf("Int"),
  string: leaf("String"),
  // GraphQL has no `null`/`void` type of its own — nullability is a property
  // of *other* types (§ "Type System — Nullability"), never a standalone
  // type. There is no non-lossy field-position fallback; `JSON` (a
  // conventional custom scalar, not part of the spec) is the least-wrong
  // degrade for a direct reference. Prefer omitting the field entirely
  // wherever the caller has that option — the object/interface field
  // emission below (`renderFieldLines`) does this automatically.
  null: leaf("JSON"),
  void: leaf("JSON"),
  // No structural equivalent — GraphQL's `Any`-like escape hatch.
  unknown: leaf("JSON"),
  never: leaf("JSON"),
  literal: (shape) => {
    const s = shape as TypeShape & { kind: "literal" }
    // GraphQL has no literal/const types (§ "Type System") — widen to the
    // nearest scalar.
    if (s.value === null) return "JSON"
    if (typeof s.value === "string") return "String"
    if (typeof s.value === "boolean") return "Boolean"
    return Number.isInteger(s.value) ? "Int" : "Float"
  },
  enum: (shape, meta) => {
    const s = shape as TypeShape & { kind: "enum" }
    return typeof meta.enumName === "string" ? meta.enumName : `Enum${s.members.length}`
  },
  ref: (shape) => (shape as TypeShape & { kind: "ref" }).target,
  // A class instance carries only nominal identity (className/source), never
  // fields (see type-ir's TypeKinds.instance doc comment) — GraphQL has no
  // opaque-reference construct, so this references the class name directly,
  // same convention as typescript.ts/jsdoc.ts (the caller is responsible for
  // ensuring a matching type/scalar named `className` is declared elsewhere).
  instance: (shape) => (shape as TypeShape & { kind: "instance" }).className,
  object: (_shape, meta) => (typeof meta.typeName === "string" ? meta.typeName : "JSON"),
  array: (shape) => {
    const s = shape as TypeShape & { kind: "array" }
    // The element's own nullability (its `!`) is produced by the recursive
    // `toGraphQL` call — this only wraps the list brackets themselves; the
    // list's own nullability (outer `!`) is applied by the caller (`toGraphQL`).
    return `[${toGraphQL(s.element)}]`
  },
  // GraphQL has no tuple construct (§ "Type System") — degrades to a list of
  // JSON, same honest-degrade convention protobuf.ts/capnp.ts use for
  // unrepresentable shapes.
  tuple: leaf("[JSON]"),
  // GraphQL has no map/dictionary construct.
  map: leaf("JSON"),
  // GraphQL unions are always named (§ "Unions") — an inline reference needs
  // `meta.unionName` (this projector's naming convention, parallel to
  // `enumName`/`typeName` above); without one there's no name to reference,
  // so this degrades to JSON. The real "are all variants Object types"
  // validation only matters for the *declaration* itself — see
  // `renderUnionType` below.
  union: (_shape, meta) => (typeof meta.unionName === "string" ? meta.unionName : "JSON"),
  intersection: (_shape, meta) => (typeof meta.typeName === "string" ? meta.typeName : "JSON"),
  // GraphQL has no bare function-type construct outside a field's own
  // argument list (§ "Fields") — degrades to JSON, same as `instance`'s
  // sibling degrades. The real encoding of a callable is `method`'s field
  // position in `renderFieldLines`/`renderMethodField` below, which reads
  // params/returnType directly rather than going through this converter.
  function: leaf("JSON"),
  // `method` has no explicit entry — falls back to `function` (JSON) via
  // `registerParent("method", "function")` when it appears as an ordinary
  // *field's type* being converted generically. Its real treatment (an
  // argument list on the field itself) only applies when the enclosing
  // object/interface walks its fields directly — see `renderFieldLines`.
  // A service surface embedded as a field's type has no GraphQL field
  // construct of its own (an `interface` TypeRef is meant to become a
  // top-level `type` declaration via `toGraphQLType`, not be nested inline).
  interface: leaf("JSON"),
}

/**
 * Inline type reference for a TypeRef — the SDL fragment usable in field,
 * argument, or list-element position (e.g. `String`, `[Int!]!`, `MyType`).
 * Nullability (§ "Type System — Nullability") is inverted from most
 * languages: GraphQL types are nullable by default, and `meta.optional`/
 * `meta.nullable` (this codebase's conventions for "may be absent") suppress
 * the `!` that otherwise marks a type as non-null.
 */
export function toGraphQL(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, handlers)
  const base = converter === undefined ? "JSON" : converter(ref.shape, ref.meta)
  return isNullable(ref.meta) ? base : `${base}!`
}

// GraphQL description strings (§ "Descriptions"): a `"""..."""` block
// immediately preceding the thing it documents. Rendered single-line for a
// single-line description, matching this codebase's other single-line doc
// conventions (typescript.ts's single-line TSDoc, protobuf.ts's `//` line).
function description(meta: Readonly<Record<string, unknown>>, indent: string): string {
  return typeof meta.description === "string" ? `${indent}"""${meta.description}"""\n` : ""
}

// GraphQL's `@deprecated` directive (§ "Deprecation") is valid on object/
// input field definitions and enum values, with an optional `reason`
// argument (default `"No longer supported"` per spec if omitted — we only
// emit an explicit reason when `meta.deprecatedReason` is given, same open-
// metadata-bag convention as `meta.deprecated` itself).
function deprecatedDirective(meta: Readonly<Record<string, unknown>>): string {
  if (meta.deprecated !== true) return ""
  const reason = typeof meta.deprecatedReason === "string" ? meta.deprecatedReason : undefined
  return reason === undefined ? " @deprecated" : ` @deprecated(reason: ${JSON.stringify(reason)})`
}

function renderMethodField(name: string, ref: TypeRef, indent: string): string {
  const m = ref.shape as TypeShape & {
    kind: "method" | "function"
    params: readonly { name: string; type: TypeRef }[]
    returnType: TypeRef
  }
  const args = m.params.map((p) => `${p.name}: ${toGraphQL(p.type)}`).join(", ")
  const argsPart = args.length > 0 ? `(${args})` : ""
  return `${description(ref.meta, indent)}${indent}${name}${argsPart}: ${toGraphQL(m.returnType)}${deprecatedDirective(ref.meta)}`
}

// Renders the body lines (one per field) shared by `object` and
// `intersection` (post field-merge) declarations. GraphQL has no field
// construct for a `null`/`void`-typed value (§ "Type System" — every field
// must resolve to a real output type), so such fields are omitted entirely
// rather than emitting a lossy placeholder — the one case in this projector
// where "skip" (per the projection's type-kind mapping) means "drop", not
// "degrade to JSON".
function renderFieldLines(fields: Readonly<Record<string, TypeRef>>): string[] {
  const indent = "  "
  const lines: string[] = []
  for (const [fieldName, fieldRef] of Object.entries(fields)) {
    if (fieldRef.shape.kind === "null" || fieldRef.shape.kind === "void") continue
    if (isA(fieldRef.shape.kind, "method")) {
      lines.push(renderMethodField(fieldName, fieldRef, indent))
      continue
    }
    lines.push(
      `${description(fieldRef.meta, indent)}${indent}${fieldName}: ${toGraphQL(fieldRef)}${deprecatedDirective(fieldRef.meta)}`,
    )
  }
  return lines
}

function renderObjectType(name: string, ref: TypeRef): string {
  const s = ref.shape as TypeShape & { kind: "object" }
  const lines = renderFieldLines(s.fields)
  return `${description(ref.meta, "")}type ${name} {\n${lines.join("\n")}\n}`
}

function renderEnumType(name: string, ref: TypeRef): string {
  const s = ref.shape as TypeShape & { kind: "enum" }
  const lines = s.members.map((member) => `  ${member}`)
  return `${description(ref.meta, "")}enum ${name} {\n${lines.join("\n")}\n}`
}

// GraphQL unions (§ "Unions") may only contain Object types, and every member
// must itself be independently nameable — a `ref` variant contributes its
// target name; an inline `object` variant contributes `meta.typeName`.
// When any variant can't be named this way, the union degrades honestly to a
// `scalar` declaration (backed by JSON) rather than guessing a name or
// silently dropping a variant.
function variantName(variant: TypeRef): string | undefined {
  if (variant.shape.kind === "ref") return (variant.shape as TypeShape & { kind: "ref" }).target
  if (isA(variant.shape.kind, "object")) {
    return typeof variant.meta.typeName === "string" ? variant.meta.typeName : undefined
  }
  return undefined
}

function renderUnionType(name: string, ref: TypeRef): string {
  const s = ref.shape as TypeShape & { kind: "union" }
  const names = s.variants.map(variantName)
  const allNamed = names.every((n): n is string => n !== undefined)
  if (!allNamed) {
    return `${description(ref.meta, "")}scalar ${name}`
  }
  return `${description(ref.meta, "")}union ${name} = ${names.join(" | ")}`
}

function objectFieldsOf(ref: TypeRef): Readonly<Record<string, TypeRef>> {
  return isA(ref.shape.kind, "object") ? (ref.shape as TypeShape & { kind: "object" }).fields : {}
}

// GraphQL has no mixin/intersection construct (§ "Type System") — this
// merges each member's fields into a single flattened `type`, the same
// "collapse to one shape" degrade every structural target (TypeScript's `&`
// aside) needs for intersections that don't correspond to a native construct.
// Members that aren't structurally `object`-shaped (e.g. a bare `ref`)
// contribute no fields, since their shape isn't available to merge.
function renderIntersectionType(name: string, ref: TypeRef): string {
  const s = ref.shape as TypeShape & { kind: "intersection" }
  const merged: Record<string, TypeRef> = {}
  for (const member of s.members) Object.assign(merged, objectFieldsOf(member))
  const lines = renderFieldLines(merged)
  return `${description(ref.meta, "")}type ${name} {\n${lines.join("\n")}\n}`
}

// An `interface` TypeRef (a service/contract's method surface — see
// type-ir's TypeKinds.interface doc comment) has no resolver machinery here
// (this is a type-level projector, not an API projector); it's rendered as
// an ordinary `type` whose fields are the methods, each with its own
// argument list, matching this projector's type-kind mapping (interface ->
// "type TypeName { method1(args): ReturnType ... }" rather than GraphQL's
// own `interface` keyword, which implies implementing types this IR has no
// way to enumerate).
function renderInterfaceAsType(name: string, ref: TypeRef): string {
  const s = ref.shape as TypeShape & { kind: "interface" }
  const indent = "  "
  const lines = Object.entries(s.methods).map(([methodName, methodRef]) =>
    renderMethodField(methodName, methodRef, indent),
  )
  return `${description(ref.meta, "")}type ${name} {\n${lines.join("\n")}\n}`
}

/**
 * Named SDL type declaration for a TypeRef (e.g. `type User { ... }`,
 * `enum Color { ... }`). Scalar/leaf kinds have no named-declaration
 * construct of their own in GraphQL (every named type is Object/Interface/
 * Union/Enum/Scalar/Input, per § "Type System") — declaring one anyway (the
 * caller asked for a *name*, e.g. a schema registry entry) degrades to a
 * custom `scalar` declaration, an honest placeholder rather than a fabricated
 * shape.
 */
export function toGraphQLType(name: string, ref: TypeRef): string {
  const kind = ref.shape.kind
  if (kind === "enum") return renderEnumType(name, ref)
  if (isA(kind, "object")) return renderObjectType(name, ref)
  if (kind === "union") return renderUnionType(name, ref)
  if (kind === "intersection") return renderIntersectionType(name, ref)
  if (kind === "interface") return renderInterfaceAsType(name, ref)
  return `${description(ref.meta, "")}scalar ${name}`
}

export function toGraphQLTypes(registry: Record<string, TypeRef>): string {
  return Object.entries(registry)
    .map(([name, ref]) => toGraphQLType(name, ref))
    .join("\n\n")
}
