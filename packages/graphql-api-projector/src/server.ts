// packages/graphql-api-projector/src/server.ts — @rhi-zone/fractal-graphql-api-projector
//
// Protocol-agnostic core: `createGraphQLServer(tree, opts)` wires a Node tree
// into a fully executable graphql-js `GraphQLSchema` — the GraphQL analog of
// `createFetch` (http-api-projector's preset.ts, minus transport) and
// `createMcpServer` (mcp-api-projector's server.ts). Transport binding
// (HTTP POST /graphql, a future graphql-ws WebSocket transport, …) lives in
// presets.ts, same split as those two sibling packages.
//
// Pipeline: validators → projectGraphQL (project.ts) → toSchema (schema.ts,
// SDL text) → graphql-js `buildSchema` (executable GraphQLSchema, no
// resolvers attached yet) → resolver wiring (this file).
//
// ── Resolver wiring ─────────────────────────────────────────────────────────
// `buildSchema` produces a schema whose types/fields carry no `.resolve` —
// graphql-js mutates the plain `GraphQLObjectType`/`GraphQLField` objects it
// builds, and setting a field's `.resolve` after the fact (a well-established
// schema-first technique — the same move `graphql-tools`' `addResolversToSchema`
// makes) is how this module attaches dispatch:
//
//   - Mutation/Subscription (flat): `Dispatch` is keyed by the exact
//     top-level SDL field name (see project.ts's `ProjectGraphQLResult.handlers`
//     doc) — a direct `schema.getMutationType()!.getFields()[key]` lookup.
//   - Query (nested): `Dispatch` is keyed by the underscore-joined TREE PATH,
//     not the rendered field name (same doc) — this module reconstructs the
//     namespace path (literal tree-key segments; branch-level
//     `meta.graphql.namespace` overrides aren't visited by project.ts's
//     leaf-centric walk, so they don't apply here either — see project.ts)
//     and the leaf's own field name (`meta.graphql.name` override, else the
//     path's last segment) from the dispatch key + the leaf's own carried
//     `meta`, then walks down through the synthesized namespace
//     `GraphQLObjectType`s (named `${PascalJoin(path)}Query`, matching
//     project.ts's `renderNamespace`) to the target field. Every ancestor
//     namespace-POINTER field (e.g. `Query.users` pointing at `UsersQuery`)
//     gets a trivial passthrough resolver (`() => ({})`) — needed because the
//     synthesized namespace return type is non-null, and graphql-js's default
//     field resolver (`parentValue[fieldName]`) would otherwise read
//     `undefined` off whatever placeholder value an ancestor field returned,
//     producing a "Cannot return null for non-nullable field" execution
//     error. Each LEAF field's own resolver never reads its `parent`
//     argument (see resolve.ts's `createFieldResolver`), so the passthrough's
//     actual return value is immaterial — it only needs to be non-null.
//
// A dispatch entry with no matching schema field (shouldn't happen — the SDL
// and the dispatch map are two views of the same `projectGraphQL` walk, see
// project.ts) is silently skipped rather than thrown, matching this
// codebase's general stance that a projector degrades gracefully rather than
// crashing server construction over an internal-consistency edge case.
//
// ── Middleware / ALS / detection / errorEncoder ─────────────────────────────
// Threaded straight through to `resolve.ts`'s `createResolver` (`middleware`,
// `detection`, `errorEncoder` — see `ResolverOptions`) EXCEPT `als`, which
// wraps `dispatch.handler` itself before it reaches `createResolver` — ALS
// wrapping needs no `stores` (unlike middleware), so it's simpler to apply as
// a plain `Handler => Handler` transform here, mirroring MCP's
// `withAls`/`toBase` split (mcp-api-projector/src/server.ts). ALS is the
// INNERMOST wrapper — closer to the handler than `middleware` — same
// convention as every other projector (see
// docs/design/middleware-and-caller-context.md).

import {
  buildSchema,
  execute,
  GraphQLError,
  GraphQLObjectType,
  parse,
  subscribe,
  validate,
} from "graphql"
import type { DocumentNode, ExecutionResult, GraphQLFieldResolver, GraphQLSchema } from "graphql"
import type { Handler, Meta, Node } from "@rhi-zone/fractal-api-tree/node"
import { wrapValidators } from "@rhi-zone/fractal-api-tree/build"
import type { GeneratedEntry } from "@rhi-zone/fractal-api-tree/build"
import type { AlsConfig } from "@rhi-zone/fractal-api-tree/context"
import type { DetectionOptions } from "@rhi-zone/fractal-api-tree"
import { getGraphQLMeta, projectGraphQL } from "./project.ts"
import type { Dispatch, FieldTypeMap, OperationType } from "./project.ts"
import { toSchema } from "./schema.ts"
import { createResolver } from "./resolve.ts"
import type { GraphQLErrorEncoder, GraphQLHandlerMiddleware, ResolverOptions, SubscriptionFieldConfig } from "./resolve.ts"
import type { TypeRef } from "@rhi-zone/fractal-type-ir"

// ============================================================================
// Naming helpers — mirror project.ts's own (unexported) pascalJoin/capitalize,
// needed here to reconstruct a synthesized namespace type's SDL name from its
// tree-path segments (see module doc's "Query (nested)" case).
// ============================================================================

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1)
}

function pascalJoin(path: readonly string[]): string {
  return path.map(capitalize).join("")
}

// ============================================================================
// ALS dispatch context
// ============================================================================

/** Dispatch context `CreateGraphQLServerOptions.als`'s `init` receives. */
export type GraphQLAlsContext = {
  readonly meta: Meta
  /** The field's rendered SDL name (query fields: just the leaf's own field name, not the qualified namespace path). */
  readonly fieldName: string
  readonly operationType: OperationType
}

export type CreateGraphQLServerOptions<T = unknown> = {
  /** Underscore-joined tree-path → derived input/output TypeRefs (from codegen). Forwarded to `projectGraphQL`. */
  readonly types?: FieldTypeMap
  /** Named type declarations referenced by any supplied `FieldTypeInfo`. Forwarded to `projectGraphQL`. */
  readonly namedTypes?: Readonly<Record<string, TypeRef>>
  /**
   * Generated validators (from `buildValidatorModuleSource` /
   * `compileValidatorModule`, keyed by `"/"`-joined route path — see
   * `wrapValidators` in `@rhi-zone/fractal-api-tree/build`). When provided,
   * `tree` is wrapped via `wrapValidators` BEFORE `projectGraphQL` runs — the
   * same mechanism `createFetch`'s and `createMcpServer`'s own `validators`
   * option use, so one generated module wires validation into HTTP, MCP, and
   * GraphQL alike. Leaves with no matching entry keep their original handler
   * untouched.
   */
  readonly validators?: Readonly<Record<string, GeneratedEntry>>
  /**
   * Around-hooks wrapping each field's handler call — `F => F` where
   * `F = (input, stores) => result` (see
   * docs/design/middleware-and-caller-context.md). Composes like an onion:
   * the first entry is the OUTERMOST wrapper, matching HTTP's/MCP's own
   * middleware conventions. Threaded straight through to every resolver via
   * `resolve.ts`'s `ResolverOptions.middleware`.
   */
  readonly middleware?: readonly GraphQLHandlerMiddleware[]
  /**
   * Wrap each field's handler call so it runs inside its own
   * `AsyncLocalStorage` context. `init` computes the per-invocation context
   * value from GraphQL-specific dispatch context (`GraphQLAlsContext`).
   * Mirrors HTTP's `PresetOptions.als` and MCP's `CreateMcpServerOptions.als`.
   * ALS is the INNERMOST wrapper — see module doc. Absent by default (no ALS
   * wrapping).
   */
  readonly als?: AlsConfig<GraphQLAlsContext, T>
  /**
   * Opt-in configuration for each field resolver's structural sniffing of a
   * handler's return value — `result` gates `Result`-shape unwrapping for
   * query/mutation fields (subscription fields always expect an
   * `AsyncIterable`, structurally, regardless of this option — see
   * resolve.ts's `ResolverOptions.detection`). Defaults to `true`. Mirrors
   * HTTP's `PresetOptions.detection` and MCP's `CreateMcpServerOptions.detection`.
   */
  readonly detection?: DetectionOptions
  /**
   * Maps a handler's `Result.err(E)` error value to a `GraphQLErrorResponse`
   * (message + optional `extensions`) — see resolve.ts's
   * `GraphQLErrorEncoder`/`graphqlErrors`. Returning `undefined` (including
   * when `errorEncoder` itself is omitted) falls back to a generic
   * `GraphQLError` wrapping the raw error value.
   */
  readonly errorEncoder?: GraphQLErrorEncoder
}

/** `createGraphQLServer`'s return value. */
export type GraphQLServer = {
  /** The fully executable graphql-js schema — resolvers already wired (see module doc). */
  readonly schema: GraphQLSchema
  /** The rendered SDL text `schema` was built from (`buildSchema`) — for introspection/debugging/serving `GET /graphql` schema requests. */
  readonly sdl: string
  /**
   * Placeholder root value for callers who want to drive `schema` through
   * their own `graphql-js` `execute`/`subscribe` call directly. Always `{}` —
   * every wired field's resolution comes from the `.resolve`/`.subscribe`
   * this module attached directly onto `schema`'s field configs (see module
   * doc), not from `rootValue` property lookup, so there is nothing
   * meaningful to put here; it exists for API parity with `execute`'s own
   * `rootValue` parameter.
   */
  readonly rootValue: Record<string, unknown>
  /** Parse + validate + execute one GraphQL query/mutation document against `schema`. */
  execute(
    query: string,
    variableValues?: Record<string, unknown>,
    contextValue?: unknown,
    operationName?: string,
  ): Promise<ExecutionResult>
  /**
   * Parse + validate + `graphql-js` `subscribe` one GraphQL subscription
   * document against `schema` — returns an `AsyncIterable<ExecutionResult>`
   * on success, or a plain `ExecutionResult` carrying `errors` when parsing/
   * validation/setup fails before a subscription stream could start (the
   * same contract `graphql-js`'s own `subscribe` has). A caller wiring a
   * transport (e.g. a future graphql-ws preset) drains the iterable itself.
   */
  subscribe(
    query: string,
    variableValues?: Record<string, unknown>,
    contextValue?: unknown,
    operationName?: string,
  ): Promise<AsyncIterable<ExecutionResult> | ExecutionResult>
}

/** Parse + validate one query document against `schema`; either its `DocumentNode`, or the `errors` an `ExecutionResult` should carry instead of ever reaching `execute`/`subscribe`. */
function parseAndValidate(
  schema: GraphQLSchema,
  query: string,
): { readonly document: DocumentNode } | { readonly errors: readonly GraphQLError[] } {
  let document: DocumentNode
  try {
    document = parse(query)
  } catch (error) {
    return { errors: [error instanceof GraphQLError ? error : new GraphQLError(String(error))] }
  }
  const validationErrors = validate(schema, document)
  if (validationErrors.length > 0) return { errors: validationErrors }
  return { document }
}

/**
 * Build a fully executable GraphQL server from a Node tree: projects `tree`
 * (`projectGraphQL`), renders SDL (`toSchema`), builds the executable schema
 * (`buildSchema`), and wires every dispatch entry's resolver directly onto
 * the schema's field configs (see module doc).
 *
 * ```ts
 * const server = createGraphQLServer(tree, { errorEncoder: graphqlErrors({ notFound: "NOT_FOUND" }) })
 * const result = await server.execute("{ users { list { id } } }")
 * ```
 *
 * Transport-agnostic by design — see presets.ts for HTTP.
 */
export function createGraphQLServer<T = unknown>(
  tree: Node,
  opts: CreateGraphQLServerOptions<T> = {},
): GraphQLServer {
  // Wire generated validators onto the tree BEFORE any projection walk — see
  // CreateGraphQLServerOptions.validators.
  const workingTree = opts.validators !== undefined ? wrapValidators(tree, opts.validators) : tree

  const projection = projectGraphQL(workingTree, {
    ...(opts.types !== undefined ? { types: opts.types } : {}),
    ...(opts.namedTypes !== undefined ? { namedTypes: opts.namedTypes } : {}),
  })

  const sdl = toSchema(projection)
  const schema = buildSchema(sdl)

  const resolverOptions: ResolverOptions = {
    ...(opts.errorEncoder !== undefined ? { errorEncoder: opts.errorEncoder } : {}),
    ...(opts.middleware !== undefined ? { middleware: opts.middleware } : {}),
    ...(opts.detection !== undefined ? { detection: opts.detection } : {}),
  }

  // ALS wrapping (see CreateGraphQLServerOptions.als) — innermost, closer to
  // the handler than `opts.middleware` (which resolve.ts's createResolver
  // applies). Absent opts.als degrades to identity — zero overhead.
  const withAls = (handler: Handler, context: GraphQLAlsContext): Handler =>
    opts.als === undefined ? handler : (input: unknown) => opts.als!.storage.run(opts.als!.init(context), () => handler(input))

  const wrapDispatch = (dispatch: Dispatch, fieldName: string): Dispatch => {
    if (opts.als === undefined) return dispatch
    const context: GraphQLAlsContext = { meta: dispatch.meta, fieldName, operationType: dispatch.operationType }
    return { ...dispatch, handler: withAls(dispatch.handler, context) }
  }

  const queryType = schema.getQueryType()
  const mutationType = schema.getMutationType()
  const subscriptionType = schema.getSubscriptionType()

  /** Resolve the synthesized namespace `GraphQLObjectType` at `path` — the root `Query` type itself for `path: []`. */
  const typeForNamespacePath = (path: readonly string[]): GraphQLObjectType | undefined => {
    if (path.length === 0) return queryType ?? undefined
    const candidate = schema.getType(`${pascalJoin(path)}Query`)
    return candidate instanceof GraphQLObjectType ? candidate : undefined
  }

  const passthroughResolver: GraphQLFieldResolver<unknown, unknown> = () => ({})

  for (const [key, dispatch] of projection.handlers) {
    if (dispatch.operationType === "mutation") {
      const field = mutationType?.getFields()[key]
      if (field === undefined) continue
      field.resolve = createResolver(wrapDispatch(dispatch, key), resolverOptions) as GraphQLFieldResolver<unknown, unknown>
      continue
    }

    if (dispatch.operationType === "subscription") {
      const field = subscriptionType?.getFields()[key]
      if (field === undefined) continue
      const config = createResolver(wrapDispatch(dispatch, key), resolverOptions) as SubscriptionFieldConfig
      field.subscribe = config.subscribe as GraphQLFieldResolver<unknown, unknown>
      field.resolve = config.resolve as GraphQLFieldResolver<unknown, unknown>
      continue
    }

    // Query (nested) — reconstruct namespace path + field name from the
    // dispatch key + this leaf's own meta (see module doc's "Query (nested)" case).
    const segments = key.split("_")
    const gql = getGraphQLMeta(dispatch.meta)
    const fieldName = typeof gql.name === "string" ? gql.name : segments[segments.length - 1]!
    const namespacePath = segments.slice(0, -1)

    for (let i = 0; i < namespacePath.length; i++) {
      const parentType = typeForNamespacePath(namespacePath.slice(0, i))
      const pointerField = parentType?.getFields()[namespacePath[i]!]
      if (pointerField !== undefined && pointerField.resolve === undefined) {
        pointerField.resolve = passthroughResolver
      }
    }

    const leafType = typeForNamespacePath(namespacePath)
    const field = leafType?.getFields()[fieldName]
    if (field === undefined) continue
    field.resolve = createResolver(wrapDispatch(dispatch, fieldName), resolverOptions) as GraphQLFieldResolver<unknown, unknown>
  }

  return {
    schema,
    sdl,
    rootValue: {},
    execute: async (query, variableValues, contextValue, operationName) => {
      const parsed = parseAndValidate(schema, query)
      if ("errors" in parsed) return { errors: parsed.errors }
      return execute({ schema, document: parsed.document, rootValue: {}, contextValue, variableValues, operationName })
    },
    subscribe: async (query, variableValues, contextValue, operationName) => {
      const parsed = parseAndValidate(schema, query)
      if ("errors" in parsed) return { errors: parsed.errors }
      return subscribe({ schema, document: parsed.document, rootValue: {}, contextValue, variableValues, operationName })
    },
  }
}
