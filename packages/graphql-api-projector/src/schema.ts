// packages/graphql-api-projector/src/schema.ts — @rhi-zone/fractal-graphql-api-projector
//
// SDL assembly: takes project.ts's `ProjectGraphQLResult` and renders the
// full GraphQL SDL document — root `Query`/`Mutation`/`Subscription` type
// declarations plus every named type in `types` (synthesized Query-namespace
// object types AND any caller-supplied named type declarations, see
// `ProjectGraphQLOptions.namedTypes`).
//
// Field-level SDL text (arg lists, return types) is ALREADY resolved by
// project.ts via type-ir's `toGraphQL` — this module only concatenates
// pre-built `GraphQLField` descriptors into `type X { ... }` bodies. The one
// piece of real type-ir delegation left is `toGraphQLType` for ordinary named
// declarations (`namedTypes` entries) — this module is upstream-thin by
// design (see CLAUDE.md: the type-ir SDL layer is upstream, not duplicated).

import { toGraphQLType } from "@rhi-zone/fractal-type-ir/graphql"
import type { TypeRef } from "@rhi-zone/fractal-type-ir"
import type { Node } from "@rhi-zone/fractal-api-tree/node"
import { projectGraphQL } from "./project.ts"
import type { GraphQLField, ProjectGraphQLOptions, ProjectGraphQLResult } from "./project.ts"

/**
 * Render one field's SDL declaration line — shared by root-type and
 * synthesized-namespace-type rendering (both consume a flat `GraphQLField[]`
 * body). Matches type-ir/graphql.ts's own field-line conventions
 * (`"""description"""` block, ` @deprecated` directive) so a hand-inspected
 * schema reads consistently whether a field came from this projector or an
 * ordinary `toGraphQLType` declaration.
 */
function renderFieldLine(field: GraphQLField, indent: string): string {
  const desc = field.description !== undefined ? `${indent}"""${field.description}"""\n` : ""
  const deprecated = field.deprecated
    ? field.deprecatedReason !== undefined
      ? ` @deprecated(reason: ${JSON.stringify(field.deprecatedReason)})`
      : " @deprecated"
    : ""
  return `${desc}${indent}${field.name}${field.argsSDL}: ${field.typeSDL}${deprecated}`
}

/**
 * Render a synthesized Query-namespace object type from its raw
 * `GraphQLField[]` (carried via `TypeRef.meta.graphqlFields` — see
 * project.ts's `objectTypeRefFromFields`) — bypasses `toGraphQLType`'s
 * generic object renderer since these fields are already fully resolved SDL
 * text, not `TypeRef`s type-ir's own renderer could walk.
 */
function renderNamespaceType(name: string, fields: readonly GraphQLField[]): string {
  const lines = fields.map((f) => renderFieldLine(f, "  "))
  return `type ${name} {\n${lines.join("\n")}\n}`
}

/** True when `ref` is one of project.ts's synthesized namespace-type carriers. */
function isNamespaceTypeCarrier(ref: TypeRef): ref is TypeRef & { meta: { graphqlFields: readonly GraphQLField[] } } {
  return Array.isArray(ref.meta.graphqlFields)
}

/** Render one entry of `ProjectGraphQLResult.types` — a synthesized namespace type or an ordinary named type-ir declaration. */
function renderTypeEntry(name: string, ref: TypeRef): string {
  return isNamespaceTypeCarrier(ref) ? renderNamespaceType(name, ref.meta.graphqlFields) : toGraphQLType(name, ref)
}

/**
 * Render a root operation type (`Query`/`Mutation`/`Subscription`). GraphQL
 * requires the `Query` type to declare at least one field — an empty tree
 * (no query-tagged leaves) still needs a syntactically valid placeholder, so
 * `emptyPlaceholder` is emitted in that case. `Mutation`/`Subscription` are
 * OPTIONAL root types — an empty `fields` array means "omit the type/root
 * operation entirely," signaled by returning `undefined`.
 */
function renderRootType(
  typeName: "Query" | "Mutation" | "Subscription",
  fields: readonly GraphQLField[],
  emptyPlaceholder: boolean,
): string | undefined {
  if (fields.length === 0 && !emptyPlaceholder) return undefined
  const lines =
    fields.length === 0
      ? [`  """No ${typeName.toLowerCase()} fields are declared on this tree yet."""\n  _empty: Boolean`]
      : fields.map((f) => renderFieldLine(f, "  "))
  return `type ${typeName} {\n${lines.join("\n")}\n}`
}

/** True when any named-type entry (or its transitive references, best-effort) needs the `JSON` custom scalar declared. */
function usesJsonScalar(fragments: readonly string[]): boolean {
  return fragments.some((f) => /\bJSON\b/.test(f))
}

/**
 * Assemble the full SDL document from `projectGraphQL`'s output: the `schema
 * { query: ... }` root operation wiring, root type declarations, every named
 * type in `types`, and (when referenced) the conventional `scalar JSON`
 * escape-hatch declaration type-ir's `toGraphQL`/`toGraphQLType` degrade to
 * for unrepresentable shapes (see type-ir/src/graphql.ts's module doc).
 */
export function toSchema(projection: ProjectGraphQLResult): string {
  const queryType = renderRootType("Query", projection.queryFields, true)!
  const mutationType = renderRootType("Mutation", projection.mutationFields, false)
  const subscriptionType = renderRootType("Subscription", projection.subscriptionFields, false)

  const namedTypeFragments = Object.entries(projection.types).map(([name, ref]) => renderTypeEntry(name, ref))

  const rootTypeFragments = [queryType, mutationType, subscriptionType].filter(
    (f): f is string => f !== undefined,
  )

  const schemaDefLines = [
    "  query: Query",
    ...(mutationType !== undefined ? ["  mutation: Mutation"] : []),
    ...(subscriptionType !== undefined ? ["  subscription: Subscription"] : []),
  ]
  const schemaDef = `schema {\n${schemaDefLines.join("\n")}\n}`

  const allFragments = [...rootTypeFragments, ...namedTypeFragments]
  const scalarFragment = usesJsonScalar(allFragments) ? ["scalar JSON"] : []

  return [schemaDef, ...scalarFragment, ...rootTypeFragments, ...namedTypeFragments].join("\n\n")
}

/** Convenience: `projectGraphQL` then `toSchema` in one call. */
export function toSDL(n: Node, opts: ProjectGraphQLOptions = {}): string {
  return toSchema(projectGraphQL(n, opts))
}
