// spike/http.ts — HTTP kit
//
// Everything here is HTTP-specific. core.ts has zero imports from this file
// and zero knowledge of HTTP verbs, URL paths, or status codes.
//
// The HTTP kit provides:
//   - path(table): dispatch on first path segment, consume it
//   - methods(table): dispatch on req.method
//   - param(name, child): captures next path segment → injects into params
//     (path-consuming; the Omit<C,K> type algebra mirrors core's typed pattern)
//   - serve(handler, req): run an HTTP request through a fully-discharged handler
//
// All combinators return core `Handler<P, Res>`. There is no separate
// `HttpHandler` type — the core Handler IS the type, and kit combinators
// internally access HTTP-specific fields (path, method) by casting.
// This preserves type safety at kit boundaries and unification at the core.

import { type Pass, pass, type Handler, type Req } from "./core.ts"

// ---------------------------------------------------------------------------
// HTTP request fields (kit-internal shape)
// ---------------------------------------------------------------------------

type HttpFields = { path: string[]; method: string }
type HttpReq<P> = Req<P> & HttpFields

// ---------------------------------------------------------------------------
// HTTP kit combinators
// All return the core Handler<P, Res> type.
// ---------------------------------------------------------------------------

/**
 * path: dispatch on the first segment of req.path, consume it.
 * Returns Pass if no segment or no match.
 *
 * The request must carry `path: string[]`. This is guaranteed by `serve()`.
 */
export function path<P, Res>(
  table: Record<string, Handler<P, Res>>,
): Handler<P, Res> {
  return async (req) => {
    const httpReq = req as HttpReq<P>
    const [seg, ...rest] = httpReq.path
    if (seg === undefined) return pass
    const h = table[seg]
    if (h === undefined) return pass
    return h({ ...req, path: rest })
  }
}

/**
 * methods: dispatch on req.method.
 * Returns Pass if no match OR if the path is not fully consumed (non-empty).
 * This makes methods a leaf-level combinator: it only fires when all path
 * segments have been consumed by enclosing `path` and `param` combinators.
 */
export function methods<P, Res>(
  table: Record<string, Handler<P, Res>>,
): Handler<P, Res> {
  return async (req) => {
    const httpReq = req as HttpReq<P>
    // Only match at the leaf — pass through if path is not exhausted.
    if (httpReq.path.length > 0) return pass
    const h = table[httpReq.method]
    if (h === undefined) return pass
    return h(req)
  }
}

/**
 * param: captures the next path segment as `name`, injects it into req.params.
 *
 * This is the path-CONSUMING param — it lives in the HTTP kit because it
 * consumes a URL segment. The type algebra (Omit<C,K>) is identical to what
 * core's `typed` uses.
 *
 * C is the child's full param requirement (must include K as string).
 * Returns Handler<Omit<C,K>, Res> — discharges exactly K.
 */
export function param<K extends string, C extends Record<K, string>, Res>(
  name: K,
  child: Handler<C, Res>,
): Handler<Omit<C, K>, Res> {
  return async (req) => {
    const httpReq = req as HttpReq<Omit<C, K>>
    const [seg, ...rest] = httpReq.path
    if (seg === undefined) return pass
    const enriched = {
      ...req,
      path: rest,
      params: { ...(req.params as object), [name]: seg } as C,
    } as unknown as HttpReq<C>
    return child(enriched)
  }
}

// ---------------------------------------------------------------------------
// HTTP choice (re-exported from core for convenience with HTTP context)
// ---------------------------------------------------------------------------

export { choice } from "./core.ts"

// ---------------------------------------------------------------------------
// HTTP serve entrypoint
// ---------------------------------------------------------------------------

export interface HttpRequest {
  method: string
  /** URL path, e.g. "/todos/42" — split to ["todos", "42"] by serve() */
  url: string
  params?: Record<string, string>
}

export interface HttpResponse<T> {
  status: number
  body: T | null
}

/**
 * serve: run an HTTP request through a fully-discharged handler.
 * Handles path splitting and maps Pass → 404.
 *
 * `h` must be `Handler<{}>` — any undischarged params are a compile error.
 */
export async function serve<Res>(
  h: Handler<Record<string, never>, Res>,
  req: HttpRequest,
): Promise<HttpResponse<Res>> {
  const segments = req.url.replace(/^\//, "").split("/").filter(Boolean)
  const httpReq: HttpReq<Record<string, never>> = {
    method: req.method,
    path: segments,
    params: (req.params ?? {}) as Record<string, never>,
  }
  const res = await h(httpReq)
  if (res === pass) return { status: 404, body: null }
  return { status: 200, body: res as Res }
}

// Re-export core for consumers that only import http.ts
export type { Handler, Req, Pass } from "./core.ts"
export { pass, leaf, typed, pipe, run } from "./core.ts"
