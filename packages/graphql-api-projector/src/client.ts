// packages/graphql-api-projector/src/client.ts — @rhi-zone/fractal-graphql-api-projector
//
// Runtime GraphQL client — the same recursive-proxy pattern as
// http-api-projector's/mcp-api-projector's own `createClient`/`createMcpClient`
// (see those modules' docs for the full rationale), but constructing GraphQL
// query/mutation documents instead of HTTP requests or MCP protocol calls.
// Built directly on the raw `Node` tree (not the projected `ProjectGraphQLResult`),
// because field-name/operation-type/arg derivation is exactly project.ts's own
// walk — reusing that logic (`deriveOperationType`, `camelJoin`,
// `underscoreJoin`, `argsFromInput`, all exported from project.ts for this
// reason) rather than re-deriving it is what keeps the client's constructed
// documents from drifting out of sync with what `createGraphQLServer`
// (server.ts) actually wires resolvers for.
//
// ── Transport abstraction ────────────────────────────────────────────────
// `GraphQLTransport = (query, variables?) => Promise<{data?, errors?}>` — the
// client never assumes HTTP; a caller wires it to `fetch` against a
// `createHttpGraphQLServer` endpoint, directly to `server.execute` for an
// in-process round-trip (no network, mirrors http-api-projector's
// `createFetch` injection for `ClientOptions.fetch`), or to anything else
// speaking the same `{data, errors}` contract.
//
// ── Proxy shape (mirrors the tree, same as MCP/HTTP clients) ────────────────
//   - a branch child → a nested client object, keyed by its own tree key
//   - a `fallback`    → a function `(value: string) => sub-client` keyed by
//                        `fallback.name`, capturing the slug value into the
//                        accumulated variable-value map for everything under
//                        the subtree (mirrors MCP client's `slugValues`)
//   - a leaf          → an async callable `(input?) => Promise<unknown>`
//
// ── Document construction (per leaf, computed once at proxy-build time) ─────
// A leaf's query/mutation/subscription document has no runtime-dependent
// STRUCTURE (only argument VALUES vary per call — see project.ts's own
// design: a fallback contributes a statically-named `ID!` argument, not a
// path segment with a runtime-dependent shape), so each leaf's document
// string, argument list, and root-value unwrap path are all precomputed once
// when the proxy is built — mirroring HTTP client's per-route precomputed
// verb+path and MCP client's per-tool precomputed name.
//
// Two things vary by operation type, matching project.ts's own field-shape
// design (see that module's doc):
//   - Mutation/Subscription (FLAT): the leaf's field is a single top-level
//     field named by `camelJoin`-ing the full tree path; the document has no
//     nesting beyond that one field.
//   - Query (NESTED): the leaf's field lives inside a chain of namespace
//     object fields, one per ancestor tree-path segment (INCLUDING any
//     fallback-name segment — see project.ts's fallback module doc: a
//     fallback under a query leaf becomes both an outer namespace segment
//     AND an `ID!` arg on the leaf field itself, a deliberate consequence of
//     GraphQL having no path-segment construct, not something this client
//     should second-guess).
//
// ── Selection set ────────────────────────────────────────────────────────
// Derived from the leaf's declared output `TypeRef` (`opts.types[key].output`,
// the same per-field derived-facts map `projectGraphQL`/`createGraphQLServer`
// accept): scalar/enum fields are requested bare; object-shaped fields (or a
// `ref` resolvable via `opts.namedTypes`) recurse into their own scalar
// fields; anything unresolvable (an unregistered `ref`, a union/intersection/
// interface, or recursion past a depth/cycle guard) degrades to `__typename`
// — the one field guaranteed valid on any GraphQL composite type, keeping the
// document syntactically valid without guessing at an unknown shape. No
// output TypeRef at all means the field is scalar-shaped or unknown; either
// way no subselection is emitted.
//
// See:
//   packages/graphql-api-projector/src/project.ts   — projectGraphQL (field-name/operation-type/arg source of truth)
//   packages/graphql-api-projector/src/server.ts    — createGraphQLServer (the dispatch this client mirrors)
//   packages/mcp-api-projector/src/client.ts        — sibling runtime client (structural mirror)
//   packages/http-api-projector/src/client.ts       — sibling runtime client (structural mirror)

import { isLeaf } from "@rhi-zone/fractal-api-tree/node"
import type { Node } from "@rhi-zone/fractal-api-tree/node"
import type { TypeRef, TypeShape } from "@rhi-zone/fractal-type-ir"
import {
  argsFromInput,
  camelJoin,
  deriveOperationType,
  getGraphQLMeta,
  underscoreJoin,
} from "./project.ts"
import type { Arg, FieldTypeMap, OperationType } from "./project.ts"

// ============================================================================
// Public API types
// ============================================================================

/** One GraphQL error entry, as `errors[]` conventionally carries it. */
export type GraphQLClientErrorEntry = {
  readonly message: string
  readonly extensions?: unknown
}

/** The shape a transport's response must carry — the standard GraphQL execution-result contract. */
export type GraphQLTransportResult = {
  readonly data?: unknown
  readonly errors?: readonly GraphQLClientErrorEntry[]
}

/**
 * Sends one query/mutation/subscription document + variables to a GraphQL
 * endpoint and returns its result. Abstracted so the client can be backed by
 * `fetch` against `createHttpGraphQLServer`, a direct in-process
 * `server.execute` call, or any other transport speaking the same contract.
 */
export type GraphQLTransport = (
  query: string,
  variables?: Record<string, unknown>,
) => Promise<GraphQLTransportResult>

export type GraphQLClientOptions = {
  /** Underscore-joined tree-path → derived input/output TypeRefs — the same `FieldTypeMap` `projectGraphQL`/`createGraphQLServer` accept. Drives argument types and the return-type selection set. */
  readonly types?: FieldTypeMap
  /** Named type declarations a `ref`-kind output TypeRef may target — needed to expand a `ref` field into a real selection set instead of degrading to `__typename`. */
  readonly namedTypes?: Readonly<Record<string, TypeRef>>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyGraphQLClient = Record<string, any>

/** Thrown when the transport's result carries a non-empty `errors` array. */
export class GraphQLClientError extends Error {
  constructor(readonly errors: readonly GraphQLClientErrorEntry[]) {
    super(errors[0]?.message ?? "GraphQL request failed")
    this.name = "GraphQLClientError"
  }
}

// ============================================================================
// Internal: selection-set derivation from a return TypeRef
// ============================================================================

/** Max recursion depth into nested composite fields — a safety net against self-referential object shapes with no `ref` indirection to key a visited-set off. */
const MAX_SELECTION_DEPTH = 6

function isCompositeKind(kind: string): boolean {
  return kind === "object" || kind === "ref" || kind === "union" || kind === "intersection" || kind === "interface"
}

/** Unwrap `array` shapes to their element type — array-ness doesn't affect selection-set shape, only the field/arg SDL text (handled by `toGraphQL`, not this module). */
function elementType(ref: TypeRef): TypeRef {
  return ref.shape.kind === "array" ? elementType((ref.shape as TypeShape & { kind: "array" }).element) : ref
}

/**
 * Build one field's subselection (` { ... }`) from its TypeRef, recursing
 * into composite-kind fields. `visited` guards against a `ref` cycle (e.g. a
 * self-referential `User.friends: [User]`); `depth` guards against a deeply
 * (or infinitely) nested anonymous object shape with no `ref` to key a
 * visited-set off. Either guard tripping — or an unregistered `ref` — degrades
 * to `__typename`, the one field valid on any composite type.
 */
function buildSelectionSet(
  ref: TypeRef,
  namedTypes: Readonly<Record<string, TypeRef>>,
  depth: number,
  visited: ReadonlySet<string>,
): string {
  const target = elementType(ref)
  const shape = target.shape

  if (shape.kind === "ref") {
    const refTarget = (shape as TypeShape & { kind: "ref" }).target
    const named = namedTypes[refTarget]
    if (named === undefined || visited.has(refTarget) || depth >= MAX_SELECTION_DEPTH) {
      return " { __typename }"
    }
    return buildSelectionSet(named, namedTypes, depth + 1, new Set([...visited, refTarget]))
  }

  if (shape.kind !== "object") {
    // union/intersection/interface: no field-set to walk without a real
    // schema registry resolving variants — degrade honestly.
    return " { __typename }"
  }

  const fields = Object.entries((shape as TypeShape & { kind: "object" }).fields)
  if (fields.length === 0) return " { __typename }"

  const lines = fields
    .filter(([, fieldRef]) => fieldRef.shape.kind !== "null" && fieldRef.shape.kind !== "void")
    .map(([name, fieldRef]) => {
      const fieldElem = elementType(fieldRef)
      if (!isCompositeKind(fieldElem.shape.kind)) return name
      if (depth + 1 >= MAX_SELECTION_DEPTH) return `${name} { __typename }`
      return `${name}${buildSelectionSet(fieldRef, namedTypes, depth + 1, visited)}`
    })

  return ` { ${lines.join(" ")} }`
}

/** Top-level selection-set entry point: `""` for a scalar/unknown output (no subselection needed/possible), else `buildSelectionSet`'s result. */
function selectionSetFor(output: TypeRef | undefined, namedTypes: Readonly<Record<string, TypeRef>>): string {
  if (output === undefined) return ""
  const elem = elementType(output)
  if (!isCompositeKind(elem.shape.kind)) return ""
  return buildSelectionSet(output, namedTypes, 0, new Set())
}

// ============================================================================
// Internal: document assembly
// ============================================================================

/** Nest `inner` (the leaf field's own call + selection) inside one object-field wrapper per `path` segment — Query's namespace nesting; unused (empty `path`) for the flat Mutation/Subscription shape. */
function nestBody(path: readonly string[], inner: string, indent: string): string {
  if (path.length === 0) return `${indent}${inner}`
  const [seg, ...rest] = path
  const childIndent = `${indent}  `
  return `${indent}${seg} {\n${nestBody(rest, inner, childIndent)}\n${indent}}`
}

function buildDocument(
  operationType: OperationType,
  path: readonly string[],
  fieldName: string,
  args: readonly Arg[],
  selection: string,
): string {
  const varDecls = args.map((a) => `$${a.name}: ${a.typeSDL}`).join(", ")
  const fieldArgs = args.map((a) => `${a.name}: $${a.name}`).join(", ")
  const opSig = varDecls.length > 0 ? `(${varDecls})` : ""
  const fieldCall = `${fieldName}${fieldArgs.length > 0 ? `(${fieldArgs})` : ""}${selection}`

  const body = operationType === "query" ? nestBody(path, fieldCall, "  ") : `  ${fieldCall}`

  return `${operationType} FractalClientOp${opSig} {\n${body}\n}`
}

/** Read the leaf field's own value back out of a transport's `data`, following `path` (Query only — Mutation/Subscription are flat). */
function unwrapData(
  data: unknown,
  path: readonly string[],
  fieldName: string,
  operationType: OperationType,
): unknown {
  if (data === null || data === undefined) return undefined
  let cur: unknown = data
  if (operationType === "query") {
    for (const seg of path) {
      if (cur === null || typeof cur !== "object") return undefined
      cur = (cur as Record<string, unknown>)[seg]
    }
  }
  if (cur === null || typeof cur !== "object") return undefined
  return (cur as Record<string, unknown>)[fieldName]
}

// ============================================================================
// Internal: leaf caller
// ============================================================================

function makeFieldCaller(
  document: string,
  args: readonly Arg[],
  path: readonly string[],
  fieldName: string,
  operationType: OperationType,
  slugValues: Readonly<Record<string, string>>,
  transport: GraphQLTransport,
): (input?: unknown) => Promise<unknown> {
  return async (input?: unknown): Promise<unknown> => {
    // Fallback-captured slug values seed the variable bag; caller-supplied
    // input fields win on name collision — same convention as MCP client's
    // makeToolCaller merge (no server-side slug binding to lean on here
    // either: a GraphQL field's args ARE its whole input, no path to bind
    // against).
    const merged: Record<string, unknown> = { ...slugValues, ...((input ?? {}) as Record<string, unknown>) }
    const variables: Record<string, unknown> = {}
    for (const arg of args) variables[arg.name] = merged[arg.name]

    const result = await transport(document, variables)
    if (result.errors !== undefined && result.errors.length > 0) {
      throw new GraphQLClientError(result.errors)
    }
    return unwrapData(result.data, path, fieldName, operationType)
  }
}

// ============================================================================
// Internal: recursive sub-client builder over the raw Node tree
// ============================================================================

type ResolvedOptions = {
  readonly types: FieldTypeMap
  readonly namedTypes: Readonly<Record<string, TypeRef>>
}

function buildLeaf(
  child: Node,
  path: readonly string[],
  key: string,
  capturedArgs: readonly Arg[],
  slugValues: Readonly<Record<string, string>>,
  transport: GraphQLTransport,
  opts: ResolvedOptions,
): (input?: unknown) => Promise<unknown> {
  const operationType = deriveOperationType(child.meta)
  const gql = getGraphQLMeta(child.meta)
  const lookupKey = [...path, key].reduce(underscoreJoin, "")
  const typeInfo = opts.types[lookupKey]

  const declaredArgs = argsFromInput(typeInfo?.input)
  const declaredNames = new Set(declaredArgs.map((a) => a.name))
  // Same merge order/precedence as project.ts's buildField/buildDispatch:
  // captured (fallback) args first, a declared arg with a colliding name wins.
  const args = [...capturedArgs.filter((a) => !declaredNames.has(a.name)), ...declaredArgs]

  const fieldName =
    typeof gql.name === "string" ? gql.name : operationType === "query" ? key : [...path, key].reduce(camelJoin, "")
  // Query nests through the full ancestor path (including fallback-name
  // segments — see module doc); Mutation/Subscription are flat top-level
  // fields, so no nesting path applies.
  const fieldPath = operationType === "query" ? path : []

  const selection = selectionSetFor(typeInfo?.output, opts.namedTypes)
  const document = buildDocument(operationType, fieldPath, fieldName, args, selection)

  return makeFieldCaller(document, args, fieldPath, fieldName, operationType, slugValues, transport)
}

function buildClientNode(
  node: Node,
  path: readonly string[],
  capturedArgs: readonly Arg[],
  slugValues: Readonly<Record<string, string>>,
  transport: GraphQLTransport,
  opts: ResolvedOptions,
): AnyGraphQLClient {
  const out: AnyGraphQLClient = {}

  for (const [key, child] of Object.entries(node.children ?? {})) {
    out[key] = isLeaf(child)
      ? buildLeaf(child, path, key, capturedArgs, slugValues, transport, opts)
      : buildClientNode(child, [...path, key], capturedArgs, slugValues, transport, opts)
  }

  if (node.fallback !== undefined) {
    const { name, subtree } = node.fallback
    out[name] = (value: string): AnyGraphQLClient =>
      buildClientNode(
        subtree,
        [...path, name],
        [...capturedArgs, { name, typeSDL: "ID!" }],
        { ...slugValues, [name]: value },
        transport,
        opts,
      )
  }

  return out
}

// ============================================================================
// createGraphQLClient — public API
// ============================================================================

/**
 * Build a runtime GraphQL client from a `Node` tree and a `GraphQLTransport`.
 * The returned object mirrors the tree structure exactly (same shape as
 * `createClient`/`createMcpClient`):
 *
 *   - a branch child → a nested client object (keyed by its own tree key)
 *   - a `fallback`    → a function `(value: string) => sub-client` keyed by
 *                        `fallback.name`
 *   - a leaf          → an async callable `(input?) => Promise<unknown>`,
 *                        dispatching a precomputed query/mutation/subscription
 *                        document through `transport`
 *
 * Field-name/operation-type/argument derivation reuses the exact same logic
 * `projectGraphQL` (project.ts) uses to build the server side — a second,
 * independent computation of the SAME derivation, not a different source of
 * truth — so a client built from the same tree a `createGraphQLServer` was
 * built from always addresses the right field.
 *
 * `opts.types`/`opts.namedTypes` should be the same `FieldTypeMap`/named-type
 * registry passed to `createGraphQLServer` — they drive argument GraphQL
 * types and the return-type selection set; omitting them still produces a
 * working client (args/selections just degrade to empty/`__typename`).
 *
 * @param tree - The root node to project (same tree passed to `createGraphQLServer`).
 * @param transport - Sends a document + variables to a GraphQL endpoint, returning `{data?, errors?}`.
 * @param opts - Optional: `types`, `namedTypes` (see above).
 */
export function createGraphQLClient(
  tree: Node,
  transport: GraphQLTransport,
  opts: GraphQLClientOptions = {},
): AnyGraphQLClient {
  const resolved: ResolvedOptions = { types: opts.types ?? {}, namedTypes: opts.namedTypes ?? {} }
  return buildClientNode(tree, [], [], {}, transport, resolved)
}
