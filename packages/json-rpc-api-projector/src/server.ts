// packages/json-rpc-api-projector/src/server.ts — @rhi-zone/fractal-json-rpc-api-projector
//
// Two OOTB transport adapters over the same dispatch core, both built from
// `projectMethods` (project.ts): `createJsonRpcHttpHandler` (HTTP POST,
// `(req: Request) => Promise<Response>`, matching http-api-projector's
// `createFetch`/mcp-api-projector's transport-per-call shape) and
// `createJsonRpcWebSocketHandlers` (a minimal duck-typed `{ message }`
// handler any WebSocket server — Bun.serve, `ws`, Deno — can be adapted to).
//
// Both transports share `dispatchRequest`/`dispatchBody` — the actual
// method-lookup + input-assembly + handler-call + result/error shaping —
// so the two adapters differ only in how a raw byte payload becomes a
// parsed body and how a Response/Notification gets sent back, never in
// dispatch semantics.
//
// Batch requests (§6): `dispatchBody` accepts either a single Request
// object or an array of them — an empty array is itself an Invalid Request
// (§6: "If the batch rpc call itself fails to be recognized ... the Server
// MUST return a single Response object"); a non-empty array dispatches each
// element independently (concurrently, via `Promise.all` — one element's
// failure or slow handler doesn't block the others) and collects the
// non-Notification results. If EVERY element was a
// Notification, the resulting response array is empty; per §6 ("If there are no Response
// objects ... the Server MUST NOT return an empty Array") this returns
// `undefined`, and each transport's own adapter maps that to "no body sent"
// (HTTP: 204 No Content; WebSocket: nothing sent).
//
// Streaming (settled design decision — see project.ts's `JsonRpcMethod
// .streaming` doc): a handler returning an `AsyncIterable` is drained
// differently per transport, since only one of them has a push channel to
// deliver elements as they arrive:
//   - WebSocket: each yielded value becomes a `JsonRpcNotification`
//     (`{ method, params: { type: "chunk" | "progress", subscription: id,
//     ... } }` — `subscription` correlates the notification back to the
//     original call's `id`, the same `subscription`-keyed convention
//     several production JSON-RPC pub/sub extensions use, e.g.
//     `eth_subscribe`'s `eth_subscription` notifications). Once the
//     iterable completes, the ORIGINAL request's `id` still gets a normal
//     Response carrying the generator's return value (or `null`) as
//     `result` — symmetric with a non-streaming call, so a client that
//     only awaits the call's own promise still resolves normally once the
//     stream ends, regardless of whether it also listens for the
//     intermediate notifications.
//   - HTTP POST: no push channel exists mid-request, so the whole iterable
//     is drained to completion and its collected chunk values become the
//     single Response's `result` array (progress yields are dropped — they
//     have no synchronous consumer over a request/response transport).
//     This is a lossy but honest degrade, the same "materialize what a
//     transport can't natively express" convention type-ir's projectors use
//     throughout (e.g. protobuf.ts's stream -> repeated fallback).
//
// Error mapping: framework-level failures (malformed JSON, malformed
// Request shape, unknown method) use the JSON-RPC 2.0 standard codes
// (-32700..-32600, re-exported from wire.ts). A handler's own `Result.err`
// value is transport-agnostic (see @rhi-zone/fractal-api-tree's `Result`) —
// `JsonRpcErrorEncoder` (below) maps it to a `{code, message, data?}`
// envelope; app-specific codes are conventionally drawn from the
// -32000..-32099 server-error range (§5.1) so they never collide with a
// future spec-reserved code. `jsonRpcErrors` builds one from a
// `{ errKind: code }` mapping, mirroring MCP's `mcpErrors`/HTTP's
// `httpErrors`. Returning `undefined` (including when `errorEncoder` itself
// is omitted) falls back to `JSON_RPC_INVALID_PARAMS` with the raw error
// value as `data`.
//
// See:
//   packages/json-rpc-api-projector/src/project.ts   — projectMethods (descriptors + dispatch table)
//   packages/json-rpc-api-projector/src/wire.ts       — JSON-RPC 2.0 message types + standard codes
//   packages/mcp-api-projector/src/server.ts          — sibling preset (structural mirror: detection, errorEncoder)

import { assemble, composeErrorEncoders, isResultShape, isStreamChunk, isStreamProgress, matchKind } from "@rhi-zone/fractal-api-tree"
import type { DetectionOptions, ErrorEncoder, Stores } from "@rhi-zone/fractal-api-tree"
import type { Node } from "@rhi-zone/fractal-api-tree/node"
import { projectMethods } from "./project.ts"
import type { Dispatch, ProjectMethodsOptions, SchemaMap } from "./project.ts"
import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  isJsonRpcRequestShape,
  jsonRpcErrorResponse,
  jsonRpcSuccessResponse,
} from "./wire.ts"
import type { JsonRpcId, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./wire.ts"

export type {
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
} from "./wire.ts"
export {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  JSON_RPC_SERVER_ERROR_MAX,
  JSON_RPC_SERVER_ERROR_MIN,
  isJsonRpcError,
} from "./wire.ts"

// Augment the shared StoreRegistry with this projector's one store — see
// http-api-projector/src/decode.ts and mcp-api-projector/src/server.ts for
// the matching augmentations and this file's doc comment on why `caller` is
// NOT re-declared here (already shared, from api-tree's input.ts).
declare module "@rhi-zone/fractal-api-tree" {
  interface StoreRegistry {
    params: true
  }
}

// ============================================================================
// Error encoding
// ============================================================================

/** An error encoder's JSON-RPC-specific target shape — a full error object (code/message/data). */
export type JsonRpcErrorEncoder<E = unknown> = ErrorEncoder<E, { readonly code: number; readonly message: string; readonly data?: unknown }>

/**
 * Pre-built `JsonRpcErrorEncoder`: maps error `kind` values to JSON-RPC
 * error codes, e.g. `jsonRpcErrors({ notFound: -32001 })` (see module doc's
 * "Error mapping" section for the recommended -32000..-32099 range). The
 * error `message` defaults to the error value's own `message` field when
 * present (a string), else its `JSON.stringify`; the FULL error value is
 * always carried as `data`, so no information is lost even when `message`
 * degrades to the JSON dump. Internally a `composeErrorEncoders` over one
 * `matchKind` per mapping entry — first match wins (object key order).
 */
export function jsonRpcErrors<E = unknown>(mapping: Record<string, number>): JsonRpcErrorEncoder<E> {
  const encoders = Object.entries(mapping).map(([kind, code]) => matchKind<number>(kind, code))
  const composed = composeErrorEncoders(...encoders)
  return (error) => {
    const code = composed(error)
    if (code === undefined) return undefined
    const messageField = (error as { message?: unknown } | null)?.message
    const message = typeof messageField === "string" ? messageField : JSON.stringify(error)
    return { code, message, data: error }
  }
}

// ============================================================================
// Streaming helpers
// ============================================================================

/** True when `v` is an async iterable — mirrors MCP's `isAsyncIterable` (mcp-api-projector/src/server.ts). */
function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  )
}

/**
 * WebSocket-transport streaming: drain `iterable`, sending one
 * `JsonRpcNotification` per yielded `StreamChunk`/untagged value (and one
 * per `StreamProgress`, both keyed by `subscription: id`) via `send`.
 * Returns the generator's own return value (or `null`) — see module doc's
 * "Streaming" section for why that becomes the ORIGINAL call's `result`.
 */
async function streamViaNotifications(
  iterable: AsyncIterable<unknown>,
  method: string,
  id: JsonRpcId,
  send: (n: JsonRpcNotification) => void | Promise<void>,
): Promise<unknown> {
  const iterator = iterable[Symbol.asyncIterator]()
  for (;;) {
    const step = await iterator.next()
    if (step.done) return step.value ?? null
    const value: unknown = step.value
    if (isStreamProgress(value)) {
      await send({
        jsonrpc: "2.0",
        method,
        params: {
          type: "progress",
          subscription: id,
          progress: value.progress,
          total: value.total ?? 1,
          ...(value.message !== undefined ? { message: value.message } : {}),
        },
      })
    } else if (isStreamChunk(value)) {
      await send({ jsonrpc: "2.0", method, params: { type: "chunk", subscription: id, value: value.data } })
    } else {
      await send({ jsonrpc: "2.0", method, params: { type: "chunk", subscription: id, value } })
    }
  }
}

/**
 * HTTP-transport streaming degrade: drain `iterable` to completion,
 * collecting `StreamChunk`/untagged yields into an array (progress yields
 * are dropped — see module doc's "Streaming" section). The generator's own
 * return value, when present, is appended last.
 */
async function drainToArray(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  const iterator = iterable[Symbol.asyncIterator]()
  for (;;) {
    const step = await iterator.next()
    if (step.done) {
      if (step.value !== undefined) out.push(step.value)
      break
    }
    const value: unknown = step.value
    if (isStreamProgress(value)) continue
    out.push(isStreamChunk(value) ? value.data : value)
  }
  return out
}

// ============================================================================
// Dispatch core — shared by both transports
// ============================================================================

/** Options shared by both transport adapters (`createJsonRpcHttpHandler`/`createJsonRpcWebSocketHandlers`). */
export type CreateJsonRpcServerOptions = {
  /** Method-name -> derived params/result schema + description (from codegen). Forwarded to `projectMethods`. */
  readonly schemas?: SchemaMap
  /** Opt-in return-value detection, mirroring HTTP/MCP/CLI's own `detection` option — `result` gates `Result`-shape unwrapping, `streaming` gates `AsyncIterable` draining. Both default `true`. */
  readonly detection?: DetectionOptions
  /** Maps a handler's `Result.err(E)` value to a JSON-RPC error object — see `JsonRpcErrorEncoder`/`jsonRpcErrors`. `undefined` (including when omitted) falls back to `JSON_RPC_INVALID_PARAMS` carrying the raw error as `data`. */
  readonly errorEncoder?: JsonRpcErrorEncoder
}

type RunOptions = {
  readonly detectResult: boolean
  readonly detectStreaming: boolean
  readonly errorEncoder: JsonRpcErrorEncoder | undefined
  /** Present only for the WebSocket transport — enables the notification-streaming path (see `streamViaNotifications`) instead of HTTP's drain-to-array degrade. */
  readonly sendNotification: ((n: JsonRpcNotification) => void | Promise<void>) | undefined
}

/**
 * Dispatch ONE JSON-RPC Request/Notification object: look up its method,
 * assemble the handler's input from the single `"params"` store (via the
 * shared `assemble` pipeline — see api-tree's input.ts), call it, and shape
 * the result. Returns `undefined` for a Notification (§4.1: never gets a
 * response) or when every framework-level check already ruled out sending
 * one; the caller (`dispatchBody`) is responsible for turning `undefined`
 * into "send nothing."
 */
async function dispatchRequest(
  handlers: ReadonlyMap<string, Dispatch>,
  raw: unknown,
  opts: RunOptions,
): Promise<JsonRpcResponse | undefined> {
  if (!isJsonRpcRequestShape(raw)) {
    const id =
      typeof raw === "object" && raw !== null && "id" in raw && !Array.isArray(raw)
        ? ((raw as { id?: JsonRpcId }).id ?? null)
        : null
    return jsonRpcErrorResponse(id, JSON_RPC_INVALID_REQUEST, "Invalid Request")
  }

  const req = raw as JsonRpcRequest
  const isNotification = !("id" in req) || req.id === undefined
  const id: JsonRpcId = req.id ?? null

  const dispatch = handlers.get(req.method)
  if (dispatch === undefined) {
    return isNotification ? undefined : jsonRpcErrorResponse(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${req.method}`)
  }

  // By-name params only (see type-ir's json-rpc.ts module doc's "Params"
  // section for why) — a positional (array) `params` degrades to an empty
  // object rather than attempting positional-to-name mapping, which would
  // need the method's own params schema threaded through here just to
  // recover argument order.
  const paramsObj: Record<string, unknown> =
    typeof req.params === "object" && req.params !== null && !Array.isArray(req.params)
      ? (req.params as Record<string, unknown>)
      : {}

  try {
    const stores = { params: paramsObj, caller: {} } as Stores
    const paramNames = [...new Set([...Object.keys(paramsObj), ...Object.keys(dispatch.sourceMap)])]
    const input = assemble(stores, paramNames, dispatch.sourceMap, "params")

    let result: unknown = await dispatch.handler(input)

    if (opts.detectStreaming && isAsyncIterable(result)) {
      result =
        opts.sendNotification !== undefined
          ? await streamViaNotifications(result, req.method, id, opts.sendNotification)
          : await drainToArray(result)
    }

    if (opts.detectResult && isResultShape(result)) {
      if (result.kind === "err") {
        if (isNotification) return undefined
        const encoded = opts.errorEncoder?.(result.error)
        return encoded !== undefined
          ? jsonRpcErrorResponse(id, encoded.code, encoded.message, encoded.data)
          : jsonRpcErrorResponse(id, JSON_RPC_INVALID_PARAMS, "Invalid params", result.error)
      }
      result = result.value
    }

    return isNotification ? undefined : jsonRpcSuccessResponse(id, result)
  } catch {
    // A thrown error is never surfaced verbatim — matching HTTP/MCP/CLI's
    // own default (collapse to a generic message); a handler that wants a
    // client-facing failure should return `err(...)` instead (surfaced via
    // `errorEncoder` above), which IS conveyed verbatim.
    return isNotification ? undefined : jsonRpcErrorResponse(id, JSON_RPC_INTERNAL_ERROR, "Internal error")
  }
}

/**
 * Dispatch a parsed JSON body — either a single Request object or a batch
 * array (§6, see module doc's "Batch requests" section). Returns `undefined`
 * when nothing should be sent back (a lone Notification, or a batch made
 * entirely of Notifications).
 */
async function dispatchBody(
  handlers: ReadonlyMap<string, Dispatch>,
  body: unknown,
  opts: RunOptions,
): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
  if (Array.isArray(body)) {
    if (body.length === 0) return jsonRpcErrorResponse(null, JSON_RPC_INVALID_REQUEST, "Invalid Request")
    const results = await Promise.all(body.map((item) => dispatchRequest(handlers, item, opts)))
    const responses = results.filter((r): r is JsonRpcResponse => r !== undefined)
    return responses.length > 0 ? responses : undefined
  }
  return dispatchRequest(handlers, body, opts)
}

function resolveRunOptions(
  opts: CreateJsonRpcServerOptions,
  sendNotification: RunOptions["sendNotification"],
): RunOptions {
  return {
    detectResult: opts.detection?.result ?? true,
    detectStreaming: opts.detection?.streaming ?? true,
    errorEncoder: opts.errorEncoder,
    sendNotification,
  }
}

// ============================================================================
// HTTP POST transport
// ============================================================================

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
}

/**
 * Build an HTTP POST transport for `tree`: a plain
 * `(req: Request) => Promise<Response>` handler, the same shape
 * `createFetch` (http-api-projector)/`Bun.serve`/`Deno.serve`/a Cloudflare
 * Worker all accept directly. Every request is POSTed a JSON-RPC Request
 * object or batch array (§6) as its body; the method itself is NOT read
 * from the URL — JSON-RPC's addressing is entirely inside the payload, so
 * every call goes to the same endpoint URL.
 *
 * A malformed JSON body is a Parse error (§4.2, code -32700). A body that's
 * neither a Request-shaped object nor a batch array is an Invalid Request
 * (§4.2, code -32600). See module doc for batch/streaming/error-mapping
 * behavior.
 */
export function createJsonRpcHttpHandler(tree: Node, opts: CreateJsonRpcServerOptions = {}): (req: Request) => Promise<Response> {
  const { handlers } = projectMethods(tree, toProjectOptions(opts))
  const runOpts = resolveRunOptions(opts, undefined)

  return async (req) => {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return jsonResponse(jsonRpcErrorResponse(null, JSON_RPC_PARSE_ERROR, "Parse error"))
    }

    const result = await dispatchBody(handlers, body, runOpts)
    // §6: a batch consisting entirely of Notifications (or a lone
    // Notification) sends NO response at all — 204 No Content is the
    // conventional HTTP rendering of "nothing to say back."
    if (result === undefined) return new Response(null, { status: 204 })
    return jsonResponse(result)
  }
}

// ============================================================================
// WebSocket transport
// ============================================================================

/** The minimal socket shape this transport needs — deliberately duck-typed (not `import type { ServerWebSocket } from "bun"`) so this package has no hard dependency on any one runtime's WebSocket API; Bun's `ServerWebSocket`, `ws`'s `WebSocket`, and the standard `WebSocket` all satisfy it. */
export type JsonRpcSocket = { send(data: string): void }

/** The handler shape `createJsonRpcWebSocketHandlers` returns — matches (a subset of) Bun's `WebSocketHandler<T>` and is trivially adaptable to `ws`'s `on("message", ...)` event shape. */
export type JsonRpcWebSocketHandlers = {
  readonly message: (ws: JsonRpcSocket, raw: string | ArrayBufferLike | Uint8Array) => Promise<void>
}

function decodeMessage(raw: string | ArrayBufferLike | Uint8Array): string {
  if (typeof raw === "string") return raw
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
  return new TextDecoder().decode(bytes)
}

/**
 * Build a WebSocket transport for `tree`: a `{ message }` handler any
 * WebSocket server can drive per-connection. Unlike the HTTP transport,
 * this one has a genuine push channel — a streaming handler's elements are
 * delivered as JSON-RPC Notifications over the SAME connection the request
 * arrived on, interleaved with any other in-flight calls (see module doc's
 * "Streaming" section).
 *
 * One connection dispatches every message it receives against the SAME
 * `tree`; there is no per-connection state beyond what `tree`'s own
 * handlers close over — a consumer that needs per-connection identity
 * (auth, session) should bake it into the `tree`'s handlers via whatever
 * mechanism it already uses for caller context (see
 * docs/design/middleware-and-caller-context.md), not this transport, which
 * stays a thin message pump.
 */
export function createJsonRpcWebSocketHandlers(tree: Node, opts: CreateJsonRpcServerOptions = {}): JsonRpcWebSocketHandlers {
  const { handlers } = projectMethods(tree, toProjectOptions(opts))

  return {
    async message(ws, raw) {
      let body: unknown
      try {
        body = JSON.parse(decodeMessage(raw))
      } catch {
        ws.send(JSON.stringify(jsonRpcErrorResponse(null, JSON_RPC_PARSE_ERROR, "Parse error")))
        return
      }

      const runOpts = resolveRunOptions(opts, (n) => ws.send(JSON.stringify(n)))
      const result = await dispatchBody(handlers, body, runOpts)
      if (result !== undefined) ws.send(JSON.stringify(result))
    },
  }
}

function toProjectOptions(opts: CreateJsonRpcServerOptions): ProjectMethodsOptions {
  return opts.schemas !== undefined ? { schemas: opts.schemas } : {}
}
