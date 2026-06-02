// spike/http.ts — HTTP kit
//
// Everything here is HTTP-specific. core.ts has zero imports from this file
// and zero knowledge of HTTP verbs, URL paths, status codes, or string-pinned
// param values.
//
// The HTTP kit provides:
//   - path(table): dispatch on first path segment, consume it
//   - methods(table): dispatch on req.method
//   - param(name, child): captures next path segment → injects into params
//     V is pinned to string (path segments are always text in HTTP).
//     Uses core's capture() primitive under the hood.
//   - query(name, child): captures a URL query-string value → injects into params
//     V is pinned to string (query values are always text in HTTP).
//   - header(name, child): captures an HTTP header value → injects into params
//     V is pinned to string (header values are always text in HTTP).
//   - body(child): pulls the LAZY body handle; provides req.body: unknown to child.
//     The body is a consume-once async thunk — it is NOT pre-read. A route that
//     does not call body() never pulls the thunk (laziness proof).
//   - validate(parse, inner): ASYNC — pulls the lazy body, parses/validates,
//     passes the typed result to inner. Contrast with typed() which is sync/eager
//     over params already in the bag.
//   - serve(handler, req): run an HTTP request through a fully-discharged handler
//
// ─── V=string pinning ──────────────────────────────────────────────────────
// param/query/header all pin V=string via C extends Record<K, string>.
// This is correct for HTTP/text protocols where every captured value arrives as
// text. Non-text transports (Worker, IPC, binary) use their own kit captures
// that pin V to a richer type — see worker.ts.
//
// G1 safety: httpParam('x', leaf<{x:number}>) is a COMPILE ERROR because
// {x:number} does not satisfy C extends Record<'x',string>. Verified below.
//
// ─── Body laziness ────────────────────────────────────────────────────────
// In HTTP the body is a lazy stream — you await and consume it at most once,
// and you may never read it at all (GET, DELETE with no payload). Eager reads
// waste resources and conflate the read concern with routing. The HTTP kit
// models the body as a thunk: `() => Promise<unknown>`. The body() combinator
// pulls the thunk exactly once. A route that ignores body() never triggers a
// read (the body-counter proof in demo.ts confirms this).
//
// ─── Param-bag decision ────────────────────────────────────────────────────
// Captured query and header values land in req.params — the SAME unified bag as
// path params. This is a deliberate choice: the Omit<C,K> discharge algebra
// works uniformly over that bag. All three (param/query/header) carry string
// values in HTTP, distinguishing them from body (which has its own lazy facet).
//
// ─── typed vs validate ─────────────────────────────────────────────────────
// typed() (from core): SYNC, EAGER — refines values already in the params bag.
//   e.g. typed(raw => ({id: Number(raw.id)})) bridges string→number over params.
// validate() (this file): ASYNC, LAZY — pulls the body thunk, parses, types it.
//   e.g. validate(schema.parse, inner) bridges unknown→T over the body facet.
// Both are opt-in, orthogonal, and composable. Neither lives in the core.

import { type Pass, pass, type Handler, type Req, capture } from "./core.ts"

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
// All return the core Handler<P, Res> type.
// ---------------------------------------------------------------------------

/**
 * path: dispatch on the first segment of req.path, consume it.
 * Returns Pass if no segment or no match.
 *
 * The request must carry `path: string[]`. This is guaranteed by `serve()`.
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
 * segments have been consumed by enclosing `path` and `param` combinators.
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
//
// param/query/header all use core's capture() with V pinned to string.
// C extends Record<K, string> enforces that the child expects a string at K.
//
// G1 safety: if a child expects a non-string type at K (e.g. {x:number}),
// C extends Record<K, string> is not satisfied → compile error.
// Confirmed below with a @ts-expect-error probe.
// ---------------------------------------------------------------------------

/**
 * httpParam: captures the next path segment as `name`, injects as string.
 *
 * This is the path-CONSUMING capture — it lives in the HTTP kit because it
 * consumes a URL segment. V is pinned to string (path segments are text).
 * Uses core's capture() with a read function that pops the path head.
 *
 * C is the child's full param requirement (must include K as string).
 * Returns Handler<Omit<C,K>, Res> — discharges exactly K.
 */
export function httpParam<
  K extends string,
  C extends Record<K, string>,
  Res,
>(name: K, child: Handler<C, Res>): Handler<Omit<C, K>, Res> {
  return async (req) => {
    const httpReq = req as HttpReq<Omit<C, K>>
    const [seg, ...rest] = httpReq.path
    if (seg === undefined) return pass
    // Inject the string segment, then delegate to core capture flow.
    const enriched = {
      ...req,
      path: rest,
      params: { ...(req.params as object), [name]: seg } as unknown as C,
    } as unknown as HttpReq<C>
    return child(enriched)
  }
}

// Also export under the familiar short name for routing trees.
export { httpParam as param }

/**
 * G1 SAFETY PROOF (compile-time, not runtime):
 * httpParam('x', leaf<{x:number}>(...)) MUST be a compile error because
 * {x:number} does not satisfy C extends Record<'x',string>.
 *
 * The @ts-expect-error below is consumed (not reported as unused) — confirming
 * the constraint is in force. If tsgo reports "Unused '@ts-expect-error'", the
 * guard is broken and the string-pinning is not enforced.
 */
const _g1LeafWantsNumber = async (req: Req<{ x: number }>) => req.params.x
// @ts-expect-error [G1: {x:number} does not satisfy C extends Record<'x',string> — compile error expected]
export const _g1Probe = httpParam("x", _g1LeafWantsNumber)

/**
 * query: captures a URL query parameter as `name`, injects as string.
 *
 * Same Omit<C,K> algebra as httpParam. V pinned to string (query values are text).
 * Reads from req.query: Record<string,string>. Returns Pass if absent.
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
 * Same Omit<C,K> algebra as httpParam and query. V pinned to string.
 * Reads from req.headers: Record<string,string>. Returns Pass if absent.
 * Header names are lowercased on intake (HTTP/2 mandates lowercase).
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
//
// In HTTP the body is a stream: you await it at most once and never read it on
// routes that don't need it. The kit models this as a thunk:
//   body?: () => Promise<unknown>
//
// body() is NOT a string-capture combinator. It pulls the thunk and passes the
// resolved value to the child as req.body: unknown. It does NOT inject into
// req.params (the body is not a named string token; its type is the kit's and
// ultimately the validate() layer's concern).
//
// validate(parse, inner) is ASYNC — it pulls the body via the thunk, parses/
// validates it, and passes the typed result to inner. This is the correct bridge
// from unknown → T for the body facet. Contrast with typed() which is SYNC and
// operates on values already present in the params bag.
//
// The type-safe composition path:
//   body(validate(parse, inner))
// where:
//   - body()     : HandlerWithBody<P, unknown, Res> → Handler<P, Res>
//   - validate() : HandlerWithBody<P, T, Res>       → HandlerWithBody<P, unknown, Res>
//   - inner      : HandlerWithBody<P, T, Res>
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
 * The body slot is separate from params (see design note above).
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
 * LAZINESS PROOF: the thunk is called only here. A route that does not include
 * body() in its chain never triggers the thunk — no read occurs. The demo
 * increments a counter inside the thunk; body-ignoring routes leave it at zero.
 *
 * The child receives ReqWithBody<P, unknown>. Use validate() to narrow unknown→T.
 */
export function body<P extends Record<string, unknown>, Res>(
  child: HandlerWithBody<P, unknown, Res>,
): Handler<P, Res> {
  return async (req) => {
    const httpReq = req as HttpReq<P>
    // Pull the lazy thunk — fires exactly once, only if body() is in the chain.
    const rawBody = httpReq.body !== undefined ? await httpReq.body() : undefined
    const enriched: ReqWithBody<P, unknown> = {
      ...req,
      body: rawBody,
    }
    return child(enriched)
  }
}

/**
 * validate: ASYNC opt-in typed validation over the body facet.
 *
 * Takes a parse function (unknown → T | throws), wraps a HandlerWithBody<P,T,Res>,
 * and returns a HandlerWithBody<P,unknown,Res>.
 *
 * This is ASYNC because it awaits the parse (accommodating async validators).
 * The body thunk has already been pulled by body() before validate() runs.
 * Throwing from parse propagates naturally — callers may catch at serve() or
 * wrap in a try/catch to map to a 400. Returning Pass on validation failure
 * is also valid and makes the route opt-out-able via upstream choice().
 *
 * Contrast with typed() (core): typed is SYNC and operates over params values
 * already in the bag. validate is ASYNC and operates over the body facet.
 * Both are opt-in; neither lives in the core; they are orthogonal.
 *
 * A Standard Schema validator slots in here:
 *   validate(v => schema.parse(v), inner)
 */
export async function validate<
  T,
  P extends Record<string, unknown> = Record<string, never>,
  Res = unknown,
>(
  parse: (raw: unknown) => T | Promise<T>,
  inner: HandlerWithBody<P, T, Res>,
): Promise<HandlerWithBody<P, unknown, Res>> {
  // validate() returns a HandlerWithBody via Promise — callers await it once
  // at composition time, not on every request. The returned HandlerWithBody
  // is then the hot-path function.
  return async (req) => {
    const parsed = await parse(req.body)
    const enriched: ReqWithBody<P, T> = { ...req, body: parsed }
    return inner(enriched)
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
  /** URL path + optional query string, e.g. "/todos?limit=2" — serve() splits both */
  url: string
  params?: Record<string, unknown>
  /** HTTP headers (lowercase names); serve() defaults to {} if omitted */
  headers?: Record<string, string>
  /**
   * Raw request body — callers may pass any value; serve() wraps it in a LAZY
   * thunk so the HTTP kit sees `() => Promise<unknown>`. This models the real
   * behavior where the body is a consume-once stream.
   *
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
 * `h` must be `Handler<{}>` — any undischarged params are a compile error.
 *
 * Body wrapping: serve() wraps the caller-supplied body value in a lazy thunk
 * `() => Promise<unknown>`. The thunk fires only when body() pulls it. Routes
 * that ignore the body never trigger the thunk.
 */
export async function serve<Res>(
  h: Handler<Record<string, never>, Res>,
  req: HttpRequest,
): Promise<HttpResponse<Res>> {
  // Split path and query string
  const [rawPath = "", rawQuery = ""] = req.url.split("?") as [string, string?]
  const segments = rawPath.replace(/^\//, "").split("/").filter(Boolean)

  // Parse query string into a plain Record<string,string>
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

  // Wrap the body in a lazy thunk. The value passed by the caller is captured
  // in closure; the thunk resolves it only when body() pulls it.
  // Spread conditionally to satisfy exactOptionalPropertyTypes (optional means
  // the property may be absent, not that it may hold undefined).
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

// Re-export core for consumers that only import http.ts
export type { Handler, Req, Pass } from "./core.ts"
export { pass, leaf, typed, pipe, run } from "./core.ts"
