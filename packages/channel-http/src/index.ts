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
  type CapGrant as DispatchCapGrant,
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
 * A function that produces the pre-opened handle for one capability `kind`,
 * given the HTTP request. Distinct from the kernel's `CapGrant` (which receives
 * a `DispatchRequest`): this variant is typed over `HttpRequestLike` so HTTP
 * grant implementations can read headers, method, and segments directly.
 */
export type HttpCapGrant = (req: HttpRequestLike) => Record<string, unknown>

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
 * Build the shared `Dispatcher` for a tree + grants. Adapts each `HttpCapGrant`
 * (typed over `HttpRequestLike`) to the kernel's `DispatchCapGrant` (typed over
 * `DispatchRequest`). The `DispatchRequest` constructed below carries the HTTP
 * fields (`segments`, `headers`, `body`, `method`) alongside the canonical
 * dispatch fields, so header-reading grants keep working unchanged.
 */
const buildDispatcher = (tree: AnyNode, options: ServeOptions) => {
  const grants = options.grants ?? {}
  // Adapt each HttpCapGrant to a DispatchCapGrant. The DispatchRequest we
  // construct in `serve`/`toWebHandler` carries the HTTP request fields the
  // grantor needs (it is the same object shape with `path` instead of
  // `segments`); we expose `segments`/`headers`/`body` on it too (see below).
  const adapted: Record<string, DispatchCapGrant> = {}
  for (const [kind, grant] of Object.entries(grants)) {
    adapted[kind] = (req) => grant(req as unknown as HttpRequestLike)
  }
  return dispatcher(tree, { grants: adapted })
}

/**
 * The DispatchRequest the HTTP adapter constructs. It carries the canonical
 * dispatch fields (`path`, `input`, `meta`, `signal`) PLUS the original HTTP
 * fields (`segments`, `body`, `headers`, `method`) so existing header-reading
 * `HttpCapGrant`s — which were written against `HttpRequestLike` — keep working
 * unchanged. (`segments` === `path`; `body` === `input`.)
 */
const toDispatchRequest = (req: HttpRequestLike, meta?: Meta): DispatchRequest =>
  ({
    path: req.segments,
    input: req.body,
    ...(meta !== undefined ? { meta } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
    // HTTP fields retained for header-reading grants:
    segments: req.segments,
    body: req.body,
    headers: req.headers,
    method: req.method,
  }) as DispatchRequest

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
