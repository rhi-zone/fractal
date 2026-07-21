// packages/graphql-api-projector/src/project.ts — @rhi-zone/fractal-graphql-api-projector
//
// GraphQL projection: walks a Node tree ONCE and produces the three root
// operation-type field lists (Query/Mutation/Subscription), a dispatch table
// (field name → handler + assembly facts), and the accumulated named-type
// registry `schema.ts` hands to type-ir's `toGraphQLTypes` for SDL emission.
// Mirrors mcp-api-projector's `project.ts` (single walk → descriptors +
// dispatch) and http-api-projector's tag-driven verb derivation
// (`tags.ts`/`route.ts`'s `naiveTransform`) — same conventions, GraphQL shape.
//
// ── Field shape (settled design) ────────────────────────────────────────────
// Query is NESTED: a branch node with any query-op descendants becomes a
// synthesized namespace object type (e.g. `type UsersQuery { list: ... }`),
// and the root `Query` type gets one field per top-level branch/leaf —
// graph-shaped, matching how GraphQL schemas are conventionally organized.
// Mutation and Subscription are FLAT: every leaf's full tree path is
// camelCase-joined into a single top-level field name (e.g. `usersCreate`),
// preserving §6.2.2 serial top-level mutation execution — GraphQL only
// guarantees serial execution for a SELECTION SET's direct fields, which
// nesting would defeat.
//
// ── Operation type (settled design) ─────────────────────────────────────────
// Derived per-leaf from the SAME `meta.tags` lattice every other projector
// reads (see api-tree/src/tags.ts's `resolveTags`) — no ancestor inheritance,
// matching every other projector in this codebase:
//   tags.streaming === true → Subscription
//   tags.readOnly === true  → Query
//   else                    → Mutation (conservative default)
// `meta.graphql.operation` overrides this inference outright.
//
// ── Fallback (wildcard capture) → named argument ────────────────────────────
// GraphQL has no path-segment construct — a field's only per-call inputs are
// its own arguments. So a `fallback` encountered while descending contributes
// an `ID!` argument (named `fallback.name`) directly on every leaf field
// beneath it, rather than on an intermediate namespace field the way HTTP
// turns it into a `{param}` path segment or MCP into a `{var}` URI template.
// This is a real consequence of GraphQL's shape (arguments, not paths), not
// an arbitrary choice — see docs/design/router-model.md for the general
// fallback semantics this projector is honoring. The captured value's type
// defaults to the GraphQL `ID` scalar (non-null) — the conventional type for
// an opaque path-like identifier — since the tree carries no static type for
// it; a `meta.graphql` override on the fallback subtree's root could refine
// this in a later phase.
//
// ── Store convention ─────────────────────────────────────────────────────────
// Dispatch reuses MCP's `argument` store name (see resolve.ts) — a GraphQL
// field's `args` object is structurally the same "flat named-value bag" a
// tool call's `arguments` is.

import { isLeaf } from "@rhi-zone/fractal-api-tree/node"
import { resolveTags } from "@rhi-zone/fractal-api-tree/tags"
import type { Tags } from "@rhi-zone/fractal-api-tree/tags"
import type { Handler, Meta, Node } from "@rhi-zone/fractal-api-tree/node"
import type { SourceMap } from "@rhi-zone/fractal-api-tree"
import type { TypeRef } from "@rhi-zone/fractal-type-ir"
import { toGraphQL } from "@rhi-zone/fractal-type-ir/graphql"

// ============================================================================
// meta.graphql — open bag, per-projection overrides
// ============================================================================

/**
 * `meta.graphql` open bag — per-projection overrides for GraphQL field
 * generation. Standard keys are typed; any other key passes through
 * untouched (open bag, not a fixed schema — matches `McpMeta`/HTTP's
 * directive bag conventions).
 */
export type GraphQLMeta = {
  /** Overrides tag-derived operation-type inference outright. */
  readonly operation?: "query" | "mutation" | "subscription"
  /** Full field-name override (prefix/camelCase-join ignored when set). */
  readonly name?: string
  /** This branch's contribution to the namespace path (Query only). */
  readonly namespace?: string
  /** Description text override — emitted as an SDL `"""..."""` block. */
  readonly description?: string
  /** Deprecation flag override — else derived from `meta.tags.deprecated`. */
  readonly deprecated?: boolean
  /** `@deprecated(reason: ...)` — only meaningful when `deprecated` resolves true. */
  readonly deprecatedReason?: string
  /**
   * Per-arg source overrides for this leaf's input assembly (see
   * `packages/api-tree/src/input.ts`) — mirrors `McpMeta.sourceMap`. Args not
   * listed here resolve directly from the GraphQL resolver's own `args` bag
   * (which already carries the flattened per-field argument names 1:1 with
   * the handler's input bag — see resolve.ts).
   */
  readonly sourceMap?: SourceMap
  readonly [key: string]: unknown
}

// Declaration merging: types this package's `meta.graphql` slot on the
// shared `Meta` open bag (see api-tree/src/node.ts) so consumers get a
// typed `meta.graphql` instead of an untyped index-signature fallback.
declare module "@rhi-zone/fractal-api-tree/node" {
  interface Meta {
    graphql?: GraphQLMeta
  }
}

/** Safely extract the open `meta.graphql` bag from a `Meta`. */
export function getGraphQLMeta(meta: Meta): GraphQLMeta {
  const g = meta.graphql
  if (typeof g !== "object" || g === null) return {}
  return g
}

// ============================================================================
// Derived-from-type facts — supplied by the caller (codegen), same convention
// as mcp-api-projector's `SchemaMap`/`ToToolsOptions.schemas`.
// ============================================================================

/** Per-field derived facts: real input/output TypeRefs + JSDoc description. */
export type FieldTypeInfo = {
  readonly input?: TypeRef
  readonly output?: TypeRef
  readonly description?: string
}

/**
 * Map of field lookup-key (see `fieldKey` below — the underscore-joined tree
 * path, matching mcp-api-projector's `toTools` name convention so ONE
 * extractor pass, e.g. `@rhi-zone/fractal-api-tree/tree`'s
 * `extractToolTypeRefs`, feeds both MCP and GraphQL) → derived TypeRefs.
 */
export type FieldTypeMap = Readonly<Record<string, FieldTypeInfo>>

/** Options for `projectGraphQL`. */
export type ProjectGraphQLOptions = {
  /** Underscore-joined tree-path → derived input/output TypeRefs (from codegen). */
  readonly types?: FieldTypeMap
  /**
   * Named type declarations (object/enum/union/…) referenced by any supplied
   * `FieldTypeInfo`'s input/output TypeRefs — e.g. a `ref`-kind field type
   * whose target name needs a corresponding `type`/`enum`/`union` SDL
   * declaration to be valid. Passed through into `ProjectGraphQLResult.types`
   * verbatim (merged with the synthesized Query-namespace types this walk
   * produces) — this projector doesn't itself resolve `ref` targets, since
   * doing so needs a caller-supplied registry it has no other way to obtain.
   */
  readonly namedTypes?: Readonly<Record<string, TypeRef>>
}

// ============================================================================
// Field descriptor + dispatch
// ============================================================================

/** One GraphQL field declaration line's worth of derived facts. */
export type GraphQLField = {
  readonly name: string
  /** Already-formatted arg list, e.g. `"(id: ID!, name: String)"`, or `""` when the field takes no args. */
  readonly argsSDL: string
  /** Already-formatted return type, e.g. `"User!"`, `"[Book!]!"`. */
  readonly typeSDL: string
  readonly description?: string
  readonly deprecated?: boolean
  readonly deprecatedReason?: string
}

/**
 * One resolved GraphQL argument — name + SDL type fragment. Exported so
 * client.ts (a second consumer of the same captured-fallback/declared-arg
 * derivation) can share this shape instead of redeclaring it.
 */
export type Arg = { readonly name: string; readonly typeSDL: string }

export type OperationType = "query" | "mutation" | "subscription"

/** A dispatch entry: the leaf's handler plus what `resolve.ts` needs to assemble its input. */
export type Dispatch = {
  readonly handler: Handler
  /** Every argument name this field declares (captured-fallback + type-derived) — the paramNames `assemble()` reads. */
  readonly inputNames: readonly string[]
  readonly sourceMap: SourceMap
  readonly operationType: OperationType
  /** The leaf's own `Meta` — carried through for consumers needing dispatch-time access without a second walk. */
  readonly meta: Meta
}

/** `projectGraphQL`'s full result. */
export type ProjectGraphQLResult = {
  /** Root `Query` type fields — top-level branches/leaves only; nested namespace fields live in `types`. */
  readonly queryFields: readonly GraphQLField[]
  readonly mutationFields: readonly GraphQLField[]
  readonly subscriptionFields: readonly GraphQLField[]
  /**
   * Dispatch entries, keyed differently per operation type (see `buildDispatch`'s
   * call sites in `projectGraphQL`):
   *   - Mutation/Subscription (flat): keyed by the exact top-level SDL field
   *     name — already globally unique, and exactly what graphql-js's own
   *     flat Mutation/Subscription resolver map is keyed by.
   *   - Query (nested): keyed by the underscore-joined tree-path (the SAME
   *     key `FieldTypeMap` uses) — a bare field name repeats across
   *     namespaces (`users.list` and `orders.list` both render a field named
   *     "list"), so only the qualified path is collision-free.
   */
  readonly handlers: ReadonlyMap<string, Dispatch>
  /** Synthesized namespace object types (Query nesting) + any named types a supplied TypeRef referenced — keyed by SDL type name, ready for `toGraphQLTypes`. */
  readonly types: Readonly<Record<string, TypeRef>>
}

// ============================================================================
// Naming helpers
// ============================================================================

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1)
}

/**
 * camelCase join — used for flat Mutation/Subscription field names. Exported
 * so client.ts derives the exact same flat field name this walk does (a
 * second independent computation of the SAME derivation, not a different
 * source of truth — same convention as mcp-api-projector's client/server
 * name-derivation pairing).
 */
export function camelJoin(prefix: string, seg: string): string {
  return prefix.length === 0 ? seg : `${prefix}${capitalize(seg)}`
}

/**
 * underscore join — the lookup key into `FieldTypeMap`, matching
 * mcp-api-projector's `toTools` name convention. Exported for the same
 * reason as `camelJoin` above.
 */
export function underscoreJoin(prefix: string, seg: string): string {
  return prefix.length === 0 ? seg : `${prefix}_${seg}`
}

/** PascalCase join of a namespace path, e.g. `["users","admin"]` → `"UsersAdmin"`. */
function pascalJoin(path: readonly string[]): string {
  return path.map(capitalize).join("")
}

// ============================================================================
// Args/return SDL derivation from a FieldTypeInfo
// ============================================================================

/**
 * Expand a leaf's declared input TypeRef into GraphQL arguments — one arg per
 * object field (an input type's top-level shape is always treated as the
 * flattened arg list, matching how MCP/HTTP/CLI all treat a leaf's input as a
 * flat named-param bag). A non-object (or absent) input contributes no
 * declared args — only captured-fallback args (if any) apply.
 */
export function argsFromInput(input: TypeRef | undefined): Arg[] {
  if (input === undefined) return []
  const shape = input.shape
  if (shape.kind !== "object") return []
  return Object.entries(shape.fields).map(([name, ref]) => ({ name, typeSDL: toGraphQL(ref) }))
}

/** SDL return type for a leaf — the derived output TypeRef, or an honest `JSON` (nullable — unknown, not asserted non-null) degrade when none was supplied. */
function returnSDL(output: TypeRef | undefined): string {
  return output === undefined ? "JSON" : toGraphQL(output)
}

function formatArgs(args: readonly Arg[]): string {
  if (args.length === 0) return ""
  return `(${args.map((a) => `${a.name}: ${a.typeSDL}`).join(", ")})`
}

// ============================================================================
// Operation-type derivation — tag inference + meta.graphql.operation override
// ============================================================================

/**
 * `meta.graphql.operation` always wins; else tag inference:
 *   streaming === true → subscription
 *   readOnly === true  → query
 *   else               → mutation (conservative default)
 *
 * Exported so client.ts derives the exact same operation type this walk
 * does — a second independent computation of the SAME derivation, not a
 * different source of truth (same reasoning as `camelJoin`/`underscoreJoin`
 * above).
 */
export function deriveOperationType(meta: Meta): OperationType {
  const gql = getGraphQLMeta(meta)
  if (gql.operation !== undefined) return gql.operation

  const resolved = resolveTags((meta.tags ?? {}) as Tags)
  if (resolved.streaming === true) return "subscription"
  if (resolved.readOnly === true) return "query"
  return "mutation"
}

// ============================================================================
// Field descriptor construction — shared by flat (Mutation/Subscription) and
// nested (Query namespace) leaf rendering.
// ============================================================================

function buildField(
  fieldName: string,
  child: Node,
  capturedArgs: readonly Arg[],
  typeInfo: FieldTypeInfo | undefined,
): GraphQLField {
  const gql = getGraphQLMeta(child.meta)

  const description =
    typeof gql.description === "string"
      ? gql.description
      : typeof child.meta.description === "string"
        ? child.meta.description
        : typeInfo?.description

  const resolvedTags = resolveTags((child.meta.tags ?? {}) as Tags)
  const deprecated = typeof gql.deprecated === "boolean" ? gql.deprecated : resolvedTags.deprecated === true

  const declaredArgs = argsFromInput(typeInfo?.input)
  // Captured (fallback) args come first — mirrors path-then-body/query
  // convention elsewhere (path params bind before the primary store). A
  // declared arg with a colliding name wins (it's the more specific,
  // authored fact); the captured one is dropped to avoid a duplicate SDL arg.
  const declaredNames = new Set(declaredArgs.map((a) => a.name))
  const args = [...capturedArgs.filter((a) => !declaredNames.has(a.name)), ...declaredArgs]

  return {
    name: fieldName,
    argsSDL: formatArgs(args),
    typeSDL: returnSDL(typeInfo?.output),
    ...(description !== undefined ? { description } : {}),
    ...(deprecated ? { deprecated: true } : {}),
    ...(deprecated && typeof gql.deprecatedReason === "string" ? { deprecatedReason: gql.deprecatedReason } : {}),
  }
}

function buildDispatch(
  child: Node,
  capturedArgs: readonly Arg[],
  typeInfo: FieldTypeInfo | undefined,
  operationType: OperationType,
): Dispatch {
  const gql = getGraphQLMeta(child.meta)
  const declaredArgs = argsFromInput(typeInfo?.input)
  const declaredNames = new Set(declaredArgs.map((a) => a.name))
  const inputNames = [
    ...capturedArgs.filter((a) => !declaredNames.has(a.name)).map((a) => a.name),
    ...declaredArgs.map((a) => a.name),
  ]
  return {
    handler: child.handler as Handler,
    inputNames,
    sourceMap: gql.sourceMap ?? {},
    operationType,
    meta: child.meta,
  }
}

// ============================================================================
// Query namespace tree — synthesized object types for nested branches
// ============================================================================

type QueryNamespace = {
  readonly fields: Map<string, GraphQLField>
  readonly children: Map<string, { readonly seg: string; readonly ns: QueryNamespace }>
}

function emptyNamespace(): QueryNamespace {
  return { fields: new Map(), children: new Map() }
}

/** Walk down (creating as needed) the namespace chain at `path`, from `root`. */
function namespaceAt(root: QueryNamespace, path: readonly string[]): QueryNamespace {
  let ns = root
  for (const seg of path) {
    let entry = ns.children.get(seg)
    if (entry === undefined) {
      entry = { seg, ns: emptyNamespace() }
      ns.children.set(seg, entry)
    }
    ns = entry.ns
  }
  return ns
}

/**
 * Render a `QueryNamespace` tree into synthesized object-type SDL fragments
 * (`types` output) plus the field list for `parent`'s own fields (a mix of
 * this namespace's own leaf fields and one field per child namespace,
 * pointing at the synthesized type). `path` is this namespace's own position
 * (used to name its children's synthesized types); `handlers`/`typesOut` are
 * populated as a side effect (namespace-field dispatch is wired in the caller
 * — see `projectGraphQL`, which threads the synthesized-namespace resolver
 * separately since a namespace field has no leaf `Node` of its own to key a
 * `Dispatch` off).
 */
function renderNamespace(
  ns: QueryNamespace,
  path: readonly string[],
  typesOut: Record<string, TypeRef>,
): GraphQLField[] {
  const ownFields = [...ns.fields.values()]

  const childFields = [...ns.children.entries()].map(([seg, { ns: childNs }]) => {
    const childPath = [...path, seg]
    const nested = renderNamespace(childNs, childPath, typesOut)
    const typeName = `${pascalJoin(childPath)}Query`
    typesOut[typeName] = objectTypeRefFromFields(nested)
    return { name: seg, argsSDL: "", typeSDL: `${typeName}!` } satisfies GraphQLField
  })

  return [...ownFields, ...childFields]
}

/**
 * Synthesize an `object`-kind TypeRef whose fields are pre-rendered SDL
 * strings — NOT real type-ir field TypeRefs (this projector already resolved
 * each field's args/return to SDL text via `toGraphQL`, so there's nothing
 * left for type-ir's own field-rendering to do). Encoded as `ref`-kind
 * TypeRefs targeting a per-field placeholder name that `schema.ts` expands
 * directly from the `GraphQLField` list instead of through type-ir's object
 * renderer — see `schema.ts`'s `renderNamespaceType`, which reads
 * `meta.fields` (the raw `GraphQLField[]`) rather than delegating to
 * `toGraphQLType`. This TypeRef exists only as the vehicle carrying that
 * array through `ProjectGraphQLResult.types`.
 */
function objectTypeRefFromFields(fields: readonly GraphQLField[]): TypeRef {
  return { shape: { kind: "object", fields: {} }, meta: { graphqlFields: fields } }
}

// ============================================================================
// Tree walk
// ============================================================================

type WalkLeaf = {
  readonly path: readonly string[]
  readonly key: string
  readonly node: Node
  readonly capturedArgs: readonly Arg[]
}

function walkLeaves(n: Node, path: readonly string[], capturedArgs: readonly Arg[], out: WalkLeaf[]): void {
  for (const [key, child] of Object.entries(n.children ?? {})) {
    if (isLeaf(child)) {
      out.push({ path, key, node: child, capturedArgs })
    } else {
      walkLeaves(child, [...path, key], capturedArgs, out)
    }
  }

  if (n.fallback !== undefined) {
    const captured = [...capturedArgs, { name: n.fallback.name, typeSDL: "ID!" }]
    walkLeaves(n.fallback.subtree, [...path, n.fallback.name], captured, out)
  }
}

/**
 * Walk a Node tree and produce the full GraphQL projection: root
 * Query/Mutation/Subscription field lists, the field-name → dispatch map, and
 * the synthesized-namespace + referenced named-type registry. Single walk —
 * see module doc for the field-shape/operation-type/fallback design this
 * implements.
 */
export function projectGraphQL(n: Node, opts: ProjectGraphQLOptions = {}): ProjectGraphQLResult {
  const typeMap = opts.types ?? {}
  const handlers = new Map<string, Dispatch>()
  const types: Record<string, TypeRef> = { ...opts.namedTypes }

  const leaves: WalkLeaf[] = []
  walkLeaves(n, [], [], leaves)

  const mutationFields: GraphQLField[] = []
  const subscriptionFields: GraphQLField[] = []
  const queryRoot = emptyNamespace()

  for (const leaf of leaves) {
    const operationType = deriveOperationType(leaf.node.meta)
    const gql = getGraphQLMeta(leaf.node.meta)
    const lookupKey = [...leaf.path, leaf.key].reduce(underscoreJoin, "")
    const typeInfo = typeMap[lookupKey]

    if (operationType === "query") {
      // Namespace path: meta.graphql.namespace overrides a branch segment
      // the same way meta.mcp.segment/meta.http override theirs — but that
      // override lives on the BRANCH node, which this leaf-centric walk
      // doesn't visit directly, so only the plain tree-key path is used here
      // (branch-level `meta.graphql.namespace` is a later-phase refinement).
      const ns = namespaceAt(queryRoot, leaf.path)
      const fieldName = typeof gql.name === "string" ? gql.name : leaf.key
      const field = buildField(fieldName, leaf.node, leaf.capturedArgs, typeInfo)
      ns.fields.set(fieldName, field)
      // Dispatch key: the QUALIFIED tree-path key (same convention as
      // `FieldTypeMap`'s lookup key), NOT the bare `fieldName` — a nested
      // Query field name is only unique WITHIN its own synthesized namespace
      // type (e.g. `users.list` and `orders.list` both render a field named
      // "list", in different namespace types); a flat `fieldName` key would
      // silently collide. A later schema-wiring phase that builds the
      // per-namespace-type resolver maps graphql-js needs must reconstruct
      // this same key from tree position (path + leaf key), not read it off
      // the rendered field name.
      handlers.set(lookupKey, buildDispatch(leaf.node, leaf.capturedArgs, typeInfo, operationType))
      continue
    }

    const flatName =
      typeof gql.name === "string" ? gql.name : [...leaf.path, leaf.key].reduce(camelJoin, "")
    const field = buildField(flatName, leaf.node, leaf.capturedArgs, typeInfo)
    handlers.set(flatName, buildDispatch(leaf.node, leaf.capturedArgs, typeInfo, operationType))
    if (operationType === "mutation") mutationFields.push(field)
    else subscriptionFields.push(field)
  }

  const queryFields = renderNamespace(queryRoot, [], types)

  return { queryFields, mutationFields, subscriptionFields, handlers, types }
}
