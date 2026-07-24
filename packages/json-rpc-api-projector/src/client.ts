// packages/json-rpc-api-projector/src/client.ts — @rhi-zone/fractal-json-rpc-api-projector
//
// Runtime JSON-RPC client — the same recursive-proxy pattern as
// http-api-projector's `createClient`/mcp-api-projector's `createMcpClient`
// (see either module's doc for the full rationale): a nested plain object
// mirroring the Node tree's shape, built directly from the raw tree so the
// client's method-name derivation can never drift from what `projectMethods`
// (project.ts) — and, transitively, `server.ts`'s dispatch table — actually
// exposes.
//
// Two layers:
//   - `createJsonRpcClient(tree, call)` — the core: takes a transport-
//     agnostic `JsonRpcCall` (`(method, params) => Promise<result>`) and
//     builds the proxy over it. Works with any transport (HTTP, WebSocket,
//     in-process) that can implement that one function.
//   - `createJsonRpcHttpClient(tree, url, opts)` — convenience: builds a
//     `JsonRpcCall` that POSTs a JSON-RPC 2.0 Request object to `url` (see
//     `createJsonRpcHttpCall`) and passes it to `createJsonRpcClient`.
//
// Proxy shape (mirrors the HTTP/MCP clients' own tree-mirroring shape):
//   - a branch child  -> a nested client object, keyed by its own tree key
//     (never by a `meta.jsonrpc.segment` override — that only affects the
//     derived method name, never the navigation key, same convention MCP's
//     client uses)
//   - a `fallback`    -> a function `(value: string) => sub-client`, keyed
//     by `fallback.name`, capturing the slug value into an accumulated
//     params bag every leaf under the subtree automatically merges into its
//     own call — e.g. `client.books.bookId("b-1").get()` calls method
//     `"books.bookId.get"` with `params: { bookId: "b-1" }`, no need to
//     repeat the id at the call site.
//   - a leaf          -> an async callable `(input?) => Promise<result>`,
//     dispatching `call(name, { ...capturedSlugs, ...input })`.
//
// Method-name derivation mirrors `projectMethods` (project.ts) exactly: DOT-
// joined tree position, `meta.jsonrpc.name`/`meta.jsonrpc.segment` overrides
// read the same way.
//
// See:
//   packages/json-rpc-api-projector/src/project.ts   — projectMethods (name derivation, source of truth)
//   packages/json-rpc-api-projector/src/server.ts    — createJsonRpcHttpHandler (the dispatch this HTTP call mirrors)
//   packages/mcp-api-projector/src/client.ts         — sibling runtime client (structural mirror)

import { isLeaf } from "@rhi-zone/fractal-api-tree/node"
import type { Node } from "@rhi-zone/fractal-api-tree/node"
import { getJsonRpcMeta } from "./project.ts"
import type { JsonRpcErrorObject, JsonRpcId, JsonRpcResponse } from "./wire.ts"

// ============================================================================
// Public API types
// ============================================================================

/** Transport-agnostic call signature the proxy dispatches through — one JSON-RPC method call, params always by-name (see type-ir's json-rpc.ts module doc's "Params" section). Throws (or rejects) on a JSON-RPC error response; resolves to the successful `result`. */
export type JsonRpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyJsonRpcClient = Record<string, any>

/** Thrown when a call comes back as a JSON-RPC error Response. */
export class JsonRpcClientError extends Error {
  constructor(
    message: string,
    readonly error: JsonRpcErrorObject,
  ) {
    super(message)
    this.name = "JsonRpcClientError"
  }
}

// ============================================================================
// Internal: proxy construction
// ============================================================================

function makeCaller(
  call: JsonRpcCall,
  name: string,
  slugValues: Readonly<Record<string, string>>,
): (input?: Record<string, unknown>) => Promise<unknown> {
  return (input = {}) => call(name, { ...slugValues, ...input })
}

function buildClient(
  node: Node,
  prefix: string,
  call: JsonRpcCall,
  slugValues: Readonly<Record<string, string>>,
): AnyJsonRpcClient {
  const client: AnyJsonRpcClient = {}

  for (const [key, child] of Object.entries(node.children ?? {})) {
    if (isLeaf(child)) {
      const jr = getJsonRpcMeta(child.meta)
      const name = typeof jr.name === "string" ? jr.name : prefix.length > 0 ? `${prefix}.${key}` : key
      client[key] = makeCaller(call, name, slugValues)
    } else {
      const childJr = getJsonRpcMeta(child.meta)
      const rawSeg = typeof childJr.segment === "string" ? childJr.segment : key
      const seg = prefix.length > 0 ? `${prefix}.${rawSeg}` : rawSeg
      client[key] = buildClient(child, seg, call, slugValues)
    }
  }

  if (node.fallback !== undefined) {
    const fallbackName = node.fallback.name
    const seg = prefix.length > 0 ? `${prefix}.${fallbackName}` : fallbackName
    const subtree = node.fallback.subtree
    client[fallbackName] = (value: string) => buildClient(subtree, seg, call, { ...slugValues, [fallbackName]: value })
  }

  return client
}

/**
 * Build a JSON-RPC client proxy over `tree`, dispatching every leaf call
 * through the supplied transport-agnostic `call`. See module doc for the
 * proxy shape and name derivation.
 */
export function createJsonRpcClient(tree: Node, call: JsonRpcCall): AnyJsonRpcClient {
  return buildClient(tree, "", call, {})
}

// ============================================================================
// HTTP transport
// ============================================================================

/** A `fetch`-compatible request function — deliberately narrower than `typeof fetch` (which, under Bun's lib types, also requires a `preconnect` static property) so a plain arrow function stands in without a structural mismatch. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type JsonRpcHttpClientOptions = {
  /** Fetch implementation to use (defaults to the global `fetch`) — mainly for tests. */
  readonly fetch?: FetchLike
  /** Extra headers merged into every request (`Content-Type: application/json` is always set and cannot be overridden this way). */
  readonly headers?: Record<string, string>
  /** Request id generator, called once per call. Defaults to an incrementing counter (starting at 1), which is sufficient correlation for a single client instance issuing sequential or concurrent calls against one connection. */
  readonly id?: () => JsonRpcId
}

/**
 * Build a `JsonRpcCall` that POSTs a JSON-RPC 2.0 Request object to `url`
 * (matching `createJsonRpcHttpHandler`'s server.ts, which reads every call
 * from the POST body rather than the URL — one endpoint, every method).
 * A JSON-RPC error Response throws `JsonRpcClientError`; a success Response
 * resolves to its `result`.
 */
export function createJsonRpcHttpCall(url: string, opts: JsonRpcHttpClientOptions = {}): JsonRpcCall {
  const doFetch = opts.fetch ?? fetch
  let counter = 0
  const nextId = opts.id ?? (() => ++counter)

  return async (method, params) => {
    const id = nextId()
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...opts.headers },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
    })
    const body = (await res.json()) as JsonRpcResponse
    if ("error" in body) throw new JsonRpcClientError(body.error.message, body.error)
    return body.result
  }
}

/**
 * Convenience: `createJsonRpcClient(tree, createJsonRpcHttpCall(url, opts))`
 * — the common case of a client dispatching over HTTP POST against a single
 * `createJsonRpcHttpHandler` endpoint.
 */
export function createJsonRpcHttpClient(tree: Node, url: string, opts: JsonRpcHttpClientOptions = {}): AnyJsonRpcClient {
  return createJsonRpcClient(tree, createJsonRpcHttpCall(url, opts))
}
