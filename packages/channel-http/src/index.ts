// @rhi-zone/fractal-channel-http
// HTTP adapter over the unified transport kernel (fractal-transport).
//
// HTTP concepts (URL segments, status codes, response framing) live ONLY here;
// the tree walk, capability granting, and leaf/seq semantics live in
// fractal-transport + core. This file decodes a request into a `DispatchRequest`,
// calls a `Dispatcher`, and frames the `DispatchOutcome`:
//
//   unary  → a JSON Response with a status mapped from the (error) value
//   stream → a chunked HTTP body of NDJSON-framed Results (see web.ts)
//
// Wire contract (unary, UNCHANGED from the prior interpreter):
//   URL path  → segments (one per branch key) → branch dispatch
//   JSON body → leaf input
//   Result<O> → 200 + JSON
//   Result<E> → errorStatus(E) + JSON

import {
  dispatcher,
  type CapGrant,
  type DispatchRequest,
  type DispatchOutcome,
  type Meta,
} from '@rhi-zone/fractal-transport'
import type { AnyNode, Result } from '@rhi-zone/fractal-core'

// NOTE (axis purity): this file owns ONLY HTTP-medium concerns — URL→segments,
// status mapping, request/response shapes. The codec (JSON, or any other) is
// applied by the kernel's `serveExchange` inside the wire-facing `toWebHandler`
// (web.ts); the unary `serve` handler below returns the DECODED Result payload
// as its `{ status, body }` body, so it needs no codec at all.

/**
 * A capability grant for the HTTP channel: the kernel's `CapGrant` with its
 * transport-native `Raw` slot bound to {@link HttpRequestLike}, so grant
 * implementations read headers/method/segments via `req.raw`. A thin alias over
 * the one `CapGrant` type — kept for discoverability at HTTP call sites.
 */
export type HttpCapGrant = CapGrant<HttpRequestLike>

/** Minimal request shape the adapter reads — framework-agnostic. */
export interface HttpRequestLike {
  readonly method: string
  /** Path already split into non-empty segments, e.g. ['users', '42']. */
  readonly segments: readonly string[]
  /** Parsed request body (JSON) used as the leaf input. */
  readonly body: unknown
  readonly signal?: AbortSignal
  /**
   * Raw request headers, available to `HttpCapGrant` implementations (e.g. for
   * reading an Authorization token) and used to thread per-call `meta`.
   */
  readonly headers?: Headers
}

/** What the unary adapter returns; a framework adapter writes this to the wire. */
export interface HttpResponseLike {
  readonly status: number
  readonly body: unknown
}

/** Options: a registry mapping capability `kind` → handle grantor. */
export interface ServeOptions {
  /** Grants keyed by capability kind. Only the matched capability's handle is injected. */
  readonly grants?: Readonly<Record<string, HttpCapGrant>>
  /** Map a domain error to an HTTP status. Defaults to 400; auth → 401, rate → 429. */
  readonly errorStatus?: (error: unknown) => number
}

const defaultErrorStatus = (error: unknown): number => {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'unauthorized') return 401
  if (code === 'rate_limited') return 429
  if (code === 'invalid') return 422
  if (code === 'not_callable') return 404
  return 400
}

/**
 * Build the shared `Dispatcher` for a tree + grants. HTTP grants are the one
 * `CapGrant` type with its `Raw` slot bound to {@link HttpRequestLike}, so they
 * flow straight through to a `dispatcher<HttpRequestLike>` — no adaptation, no
 * cast. The native HTTP request is threaded on the `DispatchRequest.raw` slot
 * by {@link toDispatchRequest}; grants read headers/method/segments via `req.raw`.
 */
const buildDispatcher = (tree: AnyNode, options: ServeOptions) =>
  dispatcher<HttpRequestLike>(tree, options.grants ? { grants: options.grants } : {})

/**
 * The DispatchRequest the HTTP adapter constructs. The canonical dispatch
 * fields (`path`, `input`, `meta`, `signal`) map from the HTTP request; the
 * whole {@link HttpRequestLike} rides through on the typed `raw` slot, where
 * header-reading grants read it as `req.raw`.
 */
const toDispatchRequest = (req: HttpRequestLike, meta?: Meta): DispatchRequest<HttpRequestLike> => ({
  path: req.segments,
  input: req.body,
  raw: req,
  ...(meta !== undefined ? { meta } : {}),
  ...(req.signal ? { signal: req.signal } : {}),
})

/**
 * Build a UNARY HTTP handler over a node tree. Returns a function from a parsed
 * request to a status + body. Streaming leaves are not representable in the
 * `{status, body}` shape — for those use {@link toWebHandler}, which frames a
 * stream as a chunked NDJSON body. A streaming leaf reaching `serve` is
 * surfaced as a 400 `not_unary` error rather than mis-serialized.
 *
 * Backwards-compatible: the unary path produces byte-identical results to the
 * prior hand-rolled interpreter — it is the regression contract.
 */
export const serve = (tree: AnyNode, options: ServeOptions = {}) => {
  const dispatch = buildDispatcher(tree, options)
  const errorStatus = options.errorStatus ?? defaultErrorStatus
  return async (req: HttpRequestLike): Promise<HttpResponseLike> => {
    const outcome = await dispatch(toDispatchRequest(req))
    if (outcome.kind === 'stream') {
      return { status: 400, body: { code: 'not_unary', message: 'leaf is streaming; use the streaming handler' } }
    }
    const result = outcome.result
    if (result.ok) return { status: 200, body: result.value }
    return { status: errorStatus(result.error), body: result.error }
  }
}

/** Map a unary outcome's Result to a status (shared by serve + toWebHandler). */
export const outcomeStatus = (result: Result<unknown, unknown>, errorStatus = defaultErrorStatus): number =>
  result.ok ? 200 : errorStatus(result.error)

export { defaultErrorStatus }
export { buildDispatcher, toDispatchRequest }
export type { DispatchOutcome }
