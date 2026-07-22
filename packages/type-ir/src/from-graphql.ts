import {
  Kind,
  parse,
  type ArgumentNode,
  type DefinitionNode,
  type DirectiveNode,
  type DocumentNode,
  type EnumTypeDefinitionNode,
  type FieldDefinitionNode,
  type InputObjectTypeDefinitionNode,
  type InputValueDefinitionNode,
  type InterfaceTypeDefinitionNode,
  type ListTypeNode,
  type NamedTypeNode,
  type ObjectTypeDefinitionNode,
  type ScalarTypeDefinitionNode,
  type TypeNode,
  type UnionTypeDefinitionNode,
  type ValueNode,
} from "graphql"
import { t, types, withMeta, type TypeRef } from "./index.ts"
import { date, datetime } from "./kinds/common.ts"

// Reverse of graphql.ts: GraphQL SDL -> TypeRef. Uses graphql-js's own parser
// (already a workspace dependency of the sibling graphql-api-projector
// package — see packages/graphql-api-projector/package.json) rather than a
// hand-rolled SDL parser, since the grammar's full corpus (block strings,
// directives, default values, description placement) is exactly what
// graphql-js already gets right.
//
// Returned as a flat `Record<string, TypeRef>` keyed by declared type name —
// the exact shape `toGraphQLTypes` (graphql.ts) consumes going the other way,
// so `toGraphQLTypes(fromGraphql(sdl))` round-trips modulo the same lossy
// degrades graphql.ts's own doc comments call out (tuples, maps, GraphQL
// `interface`'s implements-relationships, per-enum-value metadata — the IR's
// `enum` kind is just `members: string[]`).

// § "Type System — Nullability": GraphQL types are nullable by default: a
// bare `NamedType`/`ListType` reference is nullable, and `NonNullType` (`!`)
// is what suppresses that. This is the exact inverse of `isNullable` in
// graphql.ts (which reads `meta.optional`/`meta.nullable` to decide whether
// to print `!`) — so a bare reference here becomes `meta.nullable: true`,
// and a `!`-suffixed reference carries no nullable meta at all.

// Built-in leaf scalars (§ "Scalars") plus the `DateTime`/`Date` de-facto
// ecosystem convention graphql.ts's own leaf handlers already commit to for
// the forward direction (see its `datetime`/`date` handler comments) — kept
// symmetric here so `DateTime`/`Date` round-trip instead of degrading to an
// opaque custom scalar.
const builtinScalars: Record<string, () => TypeRef> = {
  String: () => t(types.string),
  // No non-lossy field-position fallback for a bare `Int`/`Float` — type-ir's
  // plain `integer`/`number` are the closest analogue (not the fixed-width
  // `int32`/`float64` kinds, which are a stronger claim SDL alone doesn't
  // make).
  Int: () => t(types.integer),
  Float: () => t(types.number),
  Boolean: () => t(types.boolean),
  // ID has no type-ir kind of its own (§ "Scalars" — ID is serialized as a
  // string). `format: "id"` mirrors `fromString`'s (from-json-schema.ts)
  // "unrecognized format -> string with format meta" convention rather than
  // inventing a new kind for a single GraphQL-specific idiom.
  ID: () => t(types.string, { format: "id" }),
  DateTime: () => datetime(),
  Date: () => date(),
}

function nameOf(def: DefinitionNode): string | undefined {
  return "name" in def && def.name !== undefined ? def.name.value : undefined
}

function description(node: { description?: { value: string } | undefined }): Record<string, unknown> {
  return node.description !== undefined ? { description: node.description.value } : {}
}

// § "Value Literals" — enough of GraphQL's literal grammar to read directive
// arguments and field/argument default values back into plain JS values.
// Variables have no meaning outside an executable document (only relevant to
// operations, not SDL type definitions), so they degrade to `undefined`
// rather than throwing.
function valueToJs(node: ValueNode): unknown {
  switch (node.kind) {
    case Kind.INT:
      return Number.parseInt(node.value, 10)
    case Kind.FLOAT:
      return Number.parseFloat(node.value)
    case Kind.STRING:
      return node.value
    case Kind.BOOLEAN:
      return node.value
    case Kind.NULL:
      return null
    case Kind.ENUM:
      return node.value
    case Kind.LIST:
      return node.values.map(valueToJs)
    case Kind.OBJECT:
      return Object.fromEntries(node.fields.map((f) => [f.name.value, valueToJs(f.value)]))
    case Kind.VARIABLE:
      return undefined
    default:
      return undefined
  }
}

function argsToJs(args: readonly ArgumentNode[]): Record<string, unknown> {
  return Object.fromEntries(args.map((a) => [a.name.value, valueToJs(a.value)]))
}

// § "Deprecation" mirrors graphql.ts's `deprecatedDirective` (which reads
// `meta.deprecated`/`meta.deprecatedReason`); any other directive is kept
// verbatim in `meta.directives` (open-metadata-bag convention — a projector
// with its own directive vocabulary can read it back, even though no
// built-in projector currently does).
function directivesToMeta(directives: readonly DirectiveNode[] | undefined): Record<string, unknown> {
  if (directives === undefined || directives.length === 0) return {}
  const meta: Record<string, unknown> = {}
  const rest: { name: string; args: Record<string, unknown> }[] = []
  for (const directive of directives) {
    const name = directive.name.value
    const args = argsToJs(directive.arguments ?? [])
    if (name === "deprecated") {
      meta.deprecated = true
      if (typeof args.reason === "string") meta.deprecatedReason = args.reason
      continue
    }
    rest.push({ name, args })
  }
  if (rest.length > 0) meta.directives = rest
  return meta
}

// First pass: every declared type-system name, so field/argument types can
// tell "reference to a type declared in this document" (-> `ref`) apart from
// "unrecognized custom scalar, presumably declared elsewhere" (-> opaque
// scalar placeholder).
function collectDeclaredNames(doc: DocumentNode): Set<string> {
  const names = new Set<string>()
  for (const def of doc.definitions) {
    const name = nameOf(def)
    if (name !== undefined) names.add(name)
  }
  return names
}

function convertNamedType(name: string, declared: Set<string>): TypeRef {
  const builtin = builtinScalars[name]
  if (builtin !== undefined) return builtin()
  if (declared.has(name)) return t(types.ref(name))
  // A scalar referenced but not declared anywhere in this document (e.g.
  // `Upload`, or any custom scalar defined in a schema this SDL fragment was
  // split off from) — no structural shape to recover, same honest-degrade
  // convention `unknown`-mapped kinds use in graphql.ts's forward direction.
  return t(types.unknown, { graphqlScalar: name })
}

function convertTypeBase(node: NamedTypeNode | ListTypeNode, declared: Set<string>): TypeRef {
  if (node.kind === Kind.LIST_TYPE) return t(types.array(convertType(node.type, declared)))
  return convertNamedType(node.name.value, declared)
}

function convertType(node: TypeNode, declared: Set<string>): TypeRef {
  if (node.kind === Kind.NON_NULL_TYPE) return convertTypeBase(node.type, declared)
  return withMeta(convertTypeBase(node, declared), { nullable: true })
}

function convertArgument(arg: InputValueDefinitionNode, declared: Set<string>): { name: string; type: TypeRef } {
  let type = convertType(arg.type, declared)
  const extra: Record<string, unknown> = { ...description(arg), ...directivesToMeta(arg.directives) }
  if (arg.defaultValue !== undefined) extra.default = valueToJs(arg.defaultValue)
  if (Object.keys(extra).length > 0) type = withMeta(type, extra)
  return { name: arg.name.value, type }
}

// An object/interface field with arguments is a resolver, not plain data —
// same distinction graphql.ts's `renderFieldLines` makes the other way
// (`isA(fieldRef.shape.kind, "method")` decides whether to render an
// argument list). A field with no arguments stays a plain typed field.
function convertField(field: FieldDefinitionNode, declared: Set<string>): TypeRef {
  const meta = { ...description(field), ...directivesToMeta(field.directives) }
  if (field.arguments !== undefined && field.arguments.length > 0) {
    const params = field.arguments.map((a) => convertArgument(a, declared))
    const returnType = convertType(field.type, declared)
    return withMeta(t(types.method(params, returnType)), meta)
  }
  const fieldType = convertType(field.type, declared)
  return Object.keys(meta).length > 0 ? withMeta(fieldType, meta) : fieldType
}

function convertInputField(field: InputValueDefinitionNode, declared: Set<string>): TypeRef {
  const meta: Record<string, unknown> = { ...description(field), ...directivesToMeta(field.directives) }
  if (field.defaultValue !== undefined) meta.default = valueToJs(field.defaultValue)
  const fieldType = convertType(field.type, declared)
  return Object.keys(meta).length > 0 ? withMeta(fieldType, meta) : fieldType
}

function convertObjectLike(
  def: ObjectTypeDefinitionNode | InputObjectTypeDefinitionNode | InterfaceTypeDefinitionNode,
  declared: Set<string>,
  graphqlKind: "type" | "input" | "interface",
): TypeRef {
  const fields: Record<string, TypeRef> = {}
  const nodeFields = def.fields ?? []
  for (const field of nodeFields) {
    fields[field.name.value] =
      graphqlKind === "input"
        ? convertInputField(field as InputValueDefinitionNode, declared)
        : convertField(field as FieldDefinitionNode, declared)
  }
  const meta: Record<string, unknown> = {
    ...description(def),
    ...directivesToMeta(def.directives),
    graphqlKind,
    typeName: def.name.value,
  }
  if ("interfaces" in def && def.interfaces !== undefined && def.interfaces.length > 0) {
    meta.implements = def.interfaces.map((i) => i.name.value)
  }
  return t(types.object(fields), meta)
}

function convertEnum(def: EnumTypeDefinitionNode): TypeRef {
  const members = def.values?.map((v) => v.name.value) ?? []
  return t(types.enum(members), {
    ...description(def),
    ...directivesToMeta(def.directives),
  })
}

function convertUnion(def: UnionTypeDefinitionNode, declared: Set<string>): TypeRef {
  const variants = (def.types ?? []).map((nt) => convertNamedType(nt.name.value, declared))
  return t(types.union(variants), {
    ...description(def),
    ...directivesToMeta(def.directives),
    unionName: def.name.value,
  })
}

function convertScalar(def: ScalarTypeDefinitionNode): TypeRef {
  const name = def.name.value
  const builtin = builtinScalars[name]
  const base = builtin !== undefined ? builtin() : t(types.unknown, { graphqlScalar: name })
  const meta = { ...description(def), ...directivesToMeta(def.directives) }
  return Object.keys(meta).length > 0 ? withMeta(base, meta) : base
}

/**
 * Parse GraphQL SDL type-system definitions into a `Record<string, TypeRef>`
 * keyed by declared name — the reverse of `toGraphQLTypes` (graphql.ts).
 * Non-type-system definitions (operations, fragments) and schema/directive
 * definitions are ignored; this ingester only reads type shapes.
 */
export function fromGraphql(sdl: string): Record<string, TypeRef> {
  const doc = parse(sdl)
  const declared = collectDeclaredNames(doc)
  const result: Record<string, TypeRef> = {}

  for (const def of doc.definitions) {
    switch (def.kind) {
      case Kind.OBJECT_TYPE_DEFINITION:
        result[def.name.value] = convertObjectLike(def, declared, "type")
        break
      case Kind.INPUT_OBJECT_TYPE_DEFINITION:
        result[def.name.value] = convertObjectLike(def, declared, "input")
        break
      case Kind.INTERFACE_TYPE_DEFINITION:
        result[def.name.value] = convertObjectLike(def, declared, "interface")
        break
      case Kind.ENUM_TYPE_DEFINITION:
        result[def.name.value] = convertEnum(def)
        break
      case Kind.UNION_TYPE_DEFINITION:
        result[def.name.value] = convertUnion(def, declared)
        break
      case Kind.SCALAR_TYPE_DEFINITION:
        result[def.name.value] = convertScalar(def)
        break
      default:
        // Schema definitions, directive definitions, extensions, and
        // executable (operation/fragment) definitions carry no standalone
        // type shape of their own — skipped.
        break
    }
  }

  return result
}
