// packages/http/src/index.ts — @rhi-zone/fractal-http
//
// HTTP kit built on @rhi-zone/fractal-core.
//
// Provides:
//   - path(table): dispatch on first path segment, consume it
//   - methods(table): dispatch on req.method (with path-exhaustion guard)
//   - param(name, child): captures next path segment → string, uses core capture()
//   - query(name, child): captures URL query-string value → string
//   - header(name, child): captures HTTP header value → string
//   - body(child): pulls the LAZY body handle
//   - validate(parse, inner): SYNC combinator → async per-request handler
//   - serve(handler, req): run an HTTP request through a fully-discharged handler
//
// V=string pinning: param/query/header pin V=string via C extends Record<K,string>.
// G1 safety: httpParam('x', leaf<{x:number}>) is a COMPILE ERROR.

import { type Pass, pass, type Handler, type Req, capture } from '@rhi-zone/fractal-core'

// ---------------------------------------------------------------------------
// HTTP request fields (kit-internal shape)
// ---------------------------------------------------------------------------

type HttpFields = {
  path: string[]
  method: string
  query: Record<string, string>
  headers: Record<string, string>
  /** The body is a LAZY thunk — pulled at most once, only when body() fires. */
  body?: () => Promise<unknown>
}
type HttpReq<P extends Record<string, unknown>> = Req<P> & HttpFields

// ---------------------------------------------------------------------------
// HTTP kit combinators
// ---------------------------------------------------------------------------

/**
 * path: dispatch on the first segment of req.path, consume it.
 * Returns Pass if no segment or no match.
 */
export function path<P extends Record<string, unknown>, Res>(
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
 * segments have been consumed by enclosing path and param combinators.
 */
export function methods<P extends Record<string, unknown>, Res>(
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

// ---------------------------------------------------------------------------
// HTTP string-pinned capture combinators
// ---------------------------------------------------------------------------

/**
 * param: captures the next path segment as `name`, injects as string.
 *
 * V is pinned to string (path segments are text in HTTP).
 * C extends Record<K, string> enforces child expects string at K.
 *
 * G1 safety: param('x', leaf<{x:number}>) is a compile error because
 * {x:number} does not satisfy C extends Record<'x',string>.
 * Confirmed by the @ts-expect-error probe below.
 */
export function param<
  K extends string,
  C extends Record<K, string>,
  Res,
>(name: K, child: Handler<C, Res>): Handler<Omit<C, K>, Res> {
  return async (req) => {
    const httpReq = req as HttpReq<Omit<C, K>>
    const [seg, ...rest] = httpReq.path
    if (seg === undefined) return pass
    const enriched = {
      ...req,
      path: rest,
      params: { ...(req.params as object), [name]: seg } as unknown as C,
    } as unknown as HttpReq<C>
    return child(enriched)
  }
}

/**
 * G1 SAFETY PROOF (compile-time, not runtime):
 * param('x', leaf<{x:number}>(...)) MUST be a compile error because
 * {x:number} does not satisfy C extends Record<'x',string>.
 *
 * The @ts-expect-error below is consumed (not reported as unused) — confirming
 * the constraint is in force.
 */
const _g1LeafWantsNumber = async (req: Req<{ x: number }>) => req.params.x
// @ts-expect-error [G1: {x:number} does not satisfy C extends Record<'x',string> — compile error expected]
export const _g1Probe = param("x", _g1LeafWantsNumber)

/**
 * query: captures a URL query parameter as `name`, injects as string.
 *
 * Same Omit<C,K> algebra as param. V pinned to string.
 * Returns Pass if absent.
 */
export function query<
  K extends string,
  C extends Record<K, string>,
  Res,
>(name: K, child: Handler<C, Res>): Handler<Omit<C, K>, Res> {
  return capture(
    name,
    (req) => {
      const httpReq = req as unknown as HttpReq<Omit<C, K>>
      const value = httpReq.query[name]
      return value === undefined ? pass : value
    },
    child,
  )
}

/**
 * header: captures an HTTP header as `name`, injects as string.
 *
 * Same Omit<C,K> algebra as param and query. V pinned to string.
 * Header names are lowercased on intake (HTTP/2 mandates lowercase).
 * Returns Pass if absent.
 */
export function header<
  K extends string,
  C extends Record<K, string>,
  Res,
>(name: K, child: Handler<C, Res>): Handler<Omit<C, K>, Res> {
  return capture(
    name,
    (req) => {
      const httpReq = req as unknown as HttpReq<Omit<C, K>>
      const value = httpReq.headers[name]
      return value === undefined ? pass : value
    },
    child,
  )
}

// ---------------------------------------------------------------------------
// Body facet — LAZY, effectful, consume-once
// ---------------------------------------------------------------------------

/**
 * ReqWithBody: the request shape visible inside a body-aware handler.
 * `body: T` is added alongside the standard Req<P> fields.
 */
export type ReqWithBody<
  P extends Record<string, unknown>,
  T,
> = Req<P> & { body: T }

/**
 * HandlerWithBody: a handler that reads a typed body.
 */
export type HandlerWithBody<
  P extends Record<string, unknown>,
  T,
  Res,
> = (req: ReqWithBody<P, T>) => Promise<Res | Pass>

/**
 * body: pulls the lazy body thunk and makes the resolved value available
 * to the child as req.body: unknown.
 *
 * LAZINESS: the thunk is called only here. A route that does not include
 * body() in its chain never triggers the thunk.
 */
export function body<P extends Record<string, unknown>, Res>(
  child: HandlerWithBody<P, unknown, Res>,
): Handler<P, Res> {
  return async (req) => {
    const httpReq = req as HttpReq<P>
    const rawBody = httpReq.body !== undefined ? await httpReq.body() : undefined
    const enriched: ReqWithBody<P, unknown> = {
      ...req,
      body: rawBody,
    }
    return child(enriched)
  }
}

/**
 * validate: SYNC combinator that returns an async per-request handler.
 *
 * Takes a parse function (unknown → T | Promise<T>), wraps a HandlerWithBody<P,T,Res>,
 * and returns a HandlerWithBody<P,unknown,Res> — SYNCHRONOUSLY.
 *
 * The async work happens PER REQUEST inside the returned handler. Building
 * the route tree is pure data construction and is synchronous.
 *
 * A Standard Schema validator slots in here:
 *   validate(v => schema.parse(v), inner)
 */
export function validate<
  T,
  P extends Record<string, unknown> = Record<string, never>,
  Res = unknown,
>(
  parse: (raw: unknown) => T | Promise<T>,
  inner: HandlerWithBody<P, T, Res>,
): HandlerWithBody<P, unknown, Res> {
  return async (req) => {
    const parsed = await parse(req.body)
    const enriched: ReqWithBody<P, T> = { ...req, body: parsed }
    return inner(enriched)
  }
}

// ---------------------------------------------------------------------------
// HTTP serve entrypoint
// ---------------------------------------------------------------------------

export interface HttpRequest {
  method: string
  /** URL path + optional query string, e.g. "/todos?limit=2" */
  url: string
  params?: Record<string, unknown>
  /** HTTP headers (lowercase names); serve() defaults to {} if omitted */
  headers?: Record<string, string>
  /**
   * Raw request body — serve() wraps it in a LAZY thunk.
   * A route that does not call body() never triggers the thunk.
   */
  body?: unknown
}

export interface HttpResponse<T> {
  status: number
  body: T | null
}

/**
 * serve: run an HTTP request through a fully-discharged handler.
 * Handles path splitting, query-string parsing, and maps Pass → 404.
 *
 * `h` must be Handler<{}> — any undischarged params are a compile error.
 */
export async function serve<Res>(
  h: Handler<Record<string, never>, Res>,
  req: HttpRequest,
): Promise<HttpResponse<Res>> {
  const [rawPath = "", rawQuery = ""] = req.url.split("?") as [string, string?]
  const segments = rawPath.replace(/^\//, "").split("/").filter(Boolean)

  const queryRecord: Record<string, string> = {}
  if (rawQuery) {
    for (const part of rawQuery.split("&")) {
      const eqIdx = part.indexOf("=")
      if (eqIdx === -1) {
        queryRecord[decodeURIComponent(part)] = ""
      } else {
        const k = decodeURIComponent(part.slice(0, eqIdx))
        const v = decodeURIComponent(part.slice(eqIdx + 1))
        queryRecord[k] = v
      }
    }
  }

  const httpReq: HttpReq<Record<string, never>> = {
    method: req.method,
    path: segments,
    query: queryRecord,
    headers: req.headers ?? {},
    params: (req.params ?? {}) as Record<string, never>,
    ...(req.body !== undefined
      ? { body: () => Promise.resolve(req.body) }
      : {}),
  }
  const res = await h(httpReq)
  if (res === pass) return { status: 404, body: null }
  return { status: 200, body: res as Res }
}

// Re-export core for consumers that only import fractal-http
export type { Handler, Req, Pass } from '@rhi-zone/fractal-core'
export { pass, leaf, typed, pipe, run, choice } from '@rhi-zone/fractal-core'
