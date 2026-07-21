// packages/graphql-api-projector/src/resolve.ts — @rhi-zone/fractal-graphql-api-projector
//
// Per-field dispatch: turns one project.ts `Dispatch` entry into a graphql-js
// resolver (query/mutation fields) or a `{ subscribe, resolve }` field config
// (subscription fields). Mirrors http-api-projector's `runRoute` and
// mcp-api-projector's inline `CallToolRequestSchema` handler: decode args →
// assemble the handler's input bag via the shared `assemble()` pipeline
// (@rhi-zone/fractal-api-tree/input.ts) → call the handler → Result-unwrap →
// return the value, or throw a `GraphQLError` on an `err` Result.
//
// Store convention: reuses MCP's `argument` store name (see project.ts's
// module doc) — a GraphQL resolver's own `args` parameter is already the
// flat named-value bag `assemble()` expects, so the "argument" store is
// simply `args` itself, no request-shape adaptation needed.

import { GraphQLError } from "graphql"
import { assemble, composeErrorEncoders, isResultShape, isStreamChunk, isStreamProgress } from "@rhi-zone/fractal-api-tree"
import type { ErrorEncoder, SourceMap, Stores } from "@rhi-zone/fractal-api-tree"
import type { Dispatch } from "./project.ts"

// Augment the shared StoreRegistry with the "argument" store name — see
// mcp-api-projector/src/server.ts and http-api-projector/src/decode.ts for
// the matching per-projector augmentations. `caller` itself is declared once
// in api-tree's input.ts (shared across every projector).
declare module "@rhi-zone/fractal-api-tree" {
  interface StoreRegistry {
    argument: true
  }
}

// ============================================================================
// Structured error types — composable error-to-transport mapping (mirrors
// HTTP's HttpErrorEncoder/httpErrors and MCP's McpErrorEncoder/mcpErrors)
// ============================================================================

/** An error encoder's GraphQL-specific target shape — message + optional `extensions` (the spec's error-metadata bag, conventionally carrying `extensions.code`). */
export type GraphQLErrorResponse = {
  readonly message: string
  readonly extensions?: Record<string, unknown>
}

/** `ErrorEncoder<E, GraphQLErrorResponse>` — maps a handler's error value to a GraphQL error message + extensions. */
export type GraphQLErrorEncoder<E = unknown> = ErrorEncoder<E, GraphQLErrorResponse>

/**
 * Pre-built `GraphQLErrorEncoder`: maps error `kind` values to
 * `extensions.code` strings (the GraphQL convention — see
 * https://www.apollographql.com/docs/apollo-server/data/errors — for a
 * machine-readable error discriminator), e.g.
 * `graphqlErrors({ notFound: "NOT_FOUND", conflict: "CONFLICT" })`. The
 * message defaults to the error value's own `message` field when present
 * (matching how most `Result.err(E)` shapes in this codebase carry one — see
 * api-tree's `Result`/tag-set conventions), else its `JSON.stringify`.
 */
export function graphqlErrors<E = unknown>(mapping: Record<string, string>): GraphQLErrorEncoder<E> {
  const encoders = Object.entries(mapping).map(
    ([kind, code]): ErrorEncoder<unknown, GraphQLErrorResponse> =>
      (error) => {
        if (typeof error !== "object" || error === null || !("kind" in error)) return undefined
        if ((error as { kind: unknown }).kind !== kind) return undefined
        const rawMessage = (error as { message?: unknown }).message
        const message = typeof rawMessage === "string" ? rawMessage : JSON.stringify(error)
        return { message, extensions: { code } }
      },
  )
  return composeErrorEncoders(...encoders) as GraphQLErrorEncoder<E>
}

function toGraphQLError(response: GraphQLErrorResponse): GraphQLError {
  return new GraphQLError(response.message, {
    extensions: response.extensions,
  })
}

// ============================================================================
// Streaming detection (shared with query/mutation's own async-iterable check
// for symmetry — see resolve.ts's module doc)
// ============================================================================

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  )
}

// ============================================================================
// Input assembly — shared by both resolver shapes
// ============================================================================

/**
 * Assemble a field's handler input bag from its resolver `args` object via
 * the shared `assemble()` pipeline. `args` already IS the "argument" store's
 * raw values (see module doc) — `paramNames` is `entry.inputNames`, computed
 * once by `projectGraphQL` (captured-fallback names + declared-arg names, in
 * that order — see project.ts's `buildDispatch`).
 */
function assembleGraphQLInput(
  entry: Dispatch,
  args: Record<string, unknown>,
): { readonly input: Record<string, unknown>; readonly stores: Stores } {
  const stores = { argument: args, caller: {} } as Stores
  const input = assemble(stores, entry.inputNames, entry.sourceMap, "argument")
  return { input, stores }
}

/** Options for `createResolver`. */
export type ResolverOptions = {
  /** Maps a handler's `Result.err(E)` error value to a `GraphQLErrorResponse`. `undefined` (including when omitted) falls back to a generic `GraphQLError` wrapping the raw error value. */
  readonly errorEncoder?: GraphQLErrorEncoder
}

/** A plain graphql-js field resolver: `(parent, args, context, info) => result`. */
export type FieldResolver = (parent: unknown, args: Record<string, unknown>, context: unknown, info: unknown) => Promise<unknown>

/** A graphql-js subscription field config: `subscribe` yields root values, `resolve` maps each to the field's own return shape. */
export type SubscriptionFieldConfig = {
  readonly subscribe: (parent: unknown, args: Record<string, unknown>, context: unknown, info: unknown) => Promise<AsyncIterable<unknown>>
  readonly resolve: (payload: unknown) => unknown
}

/**
 * Run one field's assembled input through its handler, Result-unwrapping the
 * outcome. Shared by the query/mutation resolver and each value the
 * subscription's `subscribe` async-generator drains from the handler's own
 * `AsyncIterable` (a streaming handler's individual yields are NOT
 * Result-wrapped in this codebase's convention — only the handler's own
 * direct return value is — so this only applies to the non-streaming call
 * shape).
 */
async function runHandler(entry: Dispatch, input: Record<string, unknown>, errorEncoder: GraphQLErrorEncoder | undefined): Promise<unknown> {
  let result: unknown = await entry.handler(input)

  if (isResultShape(result)) {
    if (result.kind === "err") {
      const encoded = errorEncoder?.(result.error)
      throw encoded !== undefined ? toGraphQLError(encoded) : new GraphQLError(JSON.stringify(result.error))
    }
    result = result.value
  }

  return result
}

/**
 * Build a plain query/mutation resolver for one `Dispatch` entry: assemble
 * input from `args`, call the handler, Result-unwrap, return the value or
 * throw a `GraphQLError`. A thrown error from the handler itself propagates
 * as-is — graphql-js already turns any thrown value into a well-formed
 * GraphQL error at the execution layer, matching how a handler-thrown error
 * is the "unexpected failure" channel (vs. an `err(...)` Result, the
 * intentional one — see HTTP's `runRoute`/MCP's `createMcpServer` for the
 * same distinction on their own transports).
 */
function createFieldResolver(entry: Dispatch, options: ResolverOptions): FieldResolver {
  return async (_parent, args) => {
    const { input } = assembleGraphQLInput(entry, args)
    return runHandler(entry, input, options.errorEncoder)
  }
}

/**
 * Drain a subscription handler's own `AsyncIterable` return value into the
 * `AsyncGenerator` graphql-js's `subscribe` needs: `StreamChunk` yields and
 * untagged yields both pass their (unwrapped) value through; `StreamProgress`
 * yields are swallowed (subscriptions have no separate progress channel the
 * way MCP's `notifications/progress` or HTTP SSE's `event: progress` do —
 * see `@rhi-zone/fractal-api-tree`'s `StreamEffect`); the generator's own
 * return value (its completion payload) is yielded last, matching HTTP's
 * `streamAsSse`/MCP's `collectStreamedToolContent` treatment of a `done`
 * value as one more emission, not a silently discarded one.
 */
async function* drainSubscription(iterable: AsyncIterable<unknown>): AsyncGenerator<unknown> {
  const iterator = iterable[Symbol.asyncIterator]()
  for (;;) {
    const step = await iterator.next()
    if (step.done) {
      if (step.value !== undefined) yield step.value
      return
    }
    const value: unknown = step.value
    if (isStreamProgress(value)) continue
    if (isStreamChunk(value)) yield value.data
    else yield value
  }
}

/**
 * Build a `{ subscribe, resolve }` field config for a subscription
 * `Dispatch` entry. `subscribe` calls the handler (expected to return an
 * `AsyncIterable`, per `tags.streaming === true`'s contract — see
 * project.ts's module doc) and drains it via `drainSubscription`; `resolve`
 * is the identity function, since each drained value already IS the field's
 * final resolved value (no further Result-unwrapping per-event — see
 * `drainSubscription`'s doc).
 */
function createSubscriptionResolver(entry: Dispatch, _options: ResolverOptions): SubscriptionFieldConfig {
  return {
    subscribe: async (_parent, args) => {
      const { input } = assembleGraphQLInput(entry, args)
      const result: unknown = await entry.handler(input)
      if (!isAsyncIterable(result)) {
        throw new GraphQLError(
          `Subscription handler did not return an AsyncIterable (tags.streaming implies one) — got ${typeof result}`,
        )
      }
      return drainSubscription(result)
    },
    resolve: (payload) => payload,
  }
}

/**
 * Build the graphql-js-compatible resolver for one `Dispatch` entry —
 * `createFieldResolver`'s plain function for query/mutation fields, or
 * `createSubscriptionResolver`'s `{ subscribe, resolve }` config for
 * subscription fields (graphql-js's own field-config shape distinction —
 * see https://graphql.org/graphql-js/subscriptions/).
 */
export function createResolver(
  entry: Dispatch,
  options: ResolverOptions = {},
): FieldResolver | SubscriptionFieldConfig {
  return entry.operationType === "subscription"
    ? createSubscriptionResolver(entry, options)
    : createFieldResolver(entry, options)
}
