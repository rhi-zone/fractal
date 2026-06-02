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
//   - query(name, child): captures a URL query-string value → injects into params
//     (same Omit<C,K> algebra; reads from req.query: Record<string,string>)
//   - header(name, child): captures an HTTP header value → injects into params
//     (same Omit<C,K> algebra; reads from req.headers: Record<string,string>)
//   - body(child): provides req.body: unknown to the child handler
//     (whole-payload facet, NOT a named string token — different shape from the
//      three string-capture combinators; see design note below)
//   - validate(parse, inner): opt-in typed validation over body
//     (turns unknown → T; the only place a schema/codec surface appears; Standard
//      Schema would slot in here; core never bakes a schema)
//   - serve(handler, req): run an HTTP request through a fully-discharged handler
//
// All combinators return core `Handler<P, Res>`. There is no separate
// `HttpHandler` type — the core Handler IS the type, and kit combinators
// internally access HTTP-specific fields (path, method) by casting.
// This preserves type safety at kit boundaries and unification at the core.
//
// ─── Param-bag decision ────────────────────────────────────────────────────
// Captured query and header values land in req.params — the SAME unified bag as
// path params. Reason: the existing typed() combinator reads from
// req.params as Record<string,string>, and the Omit<C,K> discharge algebra works
// uniformly over that bag. A separate slot would require a second bag, a second
// typed combinator, and a second discharge mechanism — complexity without benefit,
// because the string-only constraint on all three (param/query/header) already
// distinguishes them from body (which is unknown and lives in its own facet).
//
// ─── Body design note ──────────────────────────────────────────────────────
// body() is NOT a string-capture combinator. It adds a `body: unknown` facet to
// the request and passes it to the child. It does NOT inject into req.params
// because (a) body is not a named string token, (b) it may be any type after
// validation, and (c) merging it into the params bag would conflate two different
// discharge algebras (Omit<C,K> string-discharge vs. type-validation discharge).
// validate(parse, inner) is the opt-in bridge from unknown → T, exactly mirroring
// how typed() bridges string → T for params. Both are middleware-shaped; both are
// orthogonal to the structural routing core.

import { type Pass, pass, type Handler, type Req } from "./core.ts"

// ---------------------------------------------------------------------------
// HTTP request fields (kit-internal shape)
// ---------------------------------------------------------------------------

type HttpFields = {
  path: string[]
  method: string
  query: Record<string, string>
  headers: Record<string, string>
  body?: unknown
}
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

/**
 * query: captures a URL query parameter as `name`, injects it into req.params.
 *
 * Same Omit<C,K> algebra as param. Reads from req.query: Record<string,string>.
 * Returns Pass if the query parameter is absent.
 *
 * Values land in req.params — the unified bag, consistent with path param.
 * See the "Param-bag decision" note at the top of this file.
 */
export function query<K extends string, C extends Record<K, string>, Res>(
  name: K,
  child: Handler<C, Res>,
): Handler<Omit<C, K>, Res> {
  return async (req) => {
    const httpReq = req as HttpReq<Omit<C, K>>
    const value = httpReq.query[name]
    if (value === undefined) return pass
    const enriched = {
      ...req,
      params: { ...(req.params as object), [name]: value } as C,
    } as unknown as HttpReq<C>
    return child(enriched)
  }
}

/**
 * header: captures an HTTP header as `name`, injects it into req.params.
 *
 * Same Omit<C,K> algebra as param and query. Reads from req.headers: Record<string,string>.
 * Returns Pass if the header is absent.
 *
 * Values land in req.params — the unified bag, consistent with param and query.
 * Header names are lowercased on intake (HTTP/2 mandates lowercase; HTTP/1.1 is
 * case-insensitive). Consumers should pass lowercase names here.
 */
export function header<K extends string, C extends Record<K, string>, Res>(
  name: K,
  child: Handler<C, Res>,
): Handler<Omit<C, K>, Res> {
  return async (req) => {
    const httpReq = req as HttpReq<Omit<C, K>>
    const value = httpReq.headers[name]
    if (value === undefined) return pass
    const enriched = {
      ...req,
      params: { ...(req.params as object), [name]: value } as C,
    } as unknown as HttpReq<C>
    return child(enriched)
  }
}

// ---------------------------------------------------------------------------
// Body facet
//
// body() is NOT a string-capture combinator — it exposes the whole request
// payload as req.body: unknown. It does NOT inject into req.params because the
// body is not a named string token; it may be any type after validation; and
// merging it into the params bag would conflate two different discharge algebras.
//
// The type-safe path is:
//   body(validate(parse, inner))
// where validate() turns unknown → T and wires the result into a typed field
// that the inner handler reads from req.body. This mirrors how typed() bridges
// string → T for params. Both are opt-in, orthogonal, and composable.
// ---------------------------------------------------------------------------

/**
 * ReqWithBody: the request shape visible inside a body-aware handler.
 * `body: T` is added alongside the standard Req<P> fields.
 */
export type ReqWithBody<P, T> = Req<P> & { body: T }

/**
 * HandlerWithBody: a handler that reads a typed body.
 * The body slot is separate from params (see design note above).
 */
export type HandlerWithBody<P, T, Res> = (req: ReqWithBody<P, T>) => Promise<Res | Pass>

/**
 * body: makes the raw request body (unknown) available to the child as req.body.
 *
 * The child handler's first parameter is ReqWithBody<P, unknown> — it receives
 * `body: unknown`. The opt-in validate() layer is what turns unknown into T.
 * Using body() without validate() is valid: the handler receives raw unknown
 * and can inspect it however it likes.
 */
export function body<P, Res>(
  child: HandlerWithBody<P, unknown, Res>,
): Handler<P, Res> {
  return async (req) => {
    const httpReq = req as HttpReq<P>
    const enriched: ReqWithBody<P, unknown> = {
      ...req,
      body: httpReq.body,
    }
    return child(enriched)
  }
}

/**
 * validate: opt-in typed validation over the body facet.
 *
 * Mirrors typed() for params: takes a parse function (unknown → T | throws),
 * wraps a HandlerWithBody<P, T, Res>, and returns a HandlerWithBody<P, unknown, Res>.
 * Returning Pass on validation failure makes the route opt-out-able (upstream
 * choice() can catch it); throwing is also valid for non-recoverable errors.
 *
 * A Standard Schema validator would slot in here — just wrap it:
 *   validate(v => schema.parse(v), inner)
 */
export function validate<T, P = Record<string, never>, Res = unknown>(
  parse: (raw: unknown) => T,
  inner: HandlerWithBody<P, T, Res>,
): HandlerWithBody<P, unknown, Res> {
  return async (req) => {
    const parsed = parse(req.body)
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
  params?: Record<string, string>
  /** HTTP headers (lowercase names); serve() defaults to {} if omitted */
  headers?: Record<string, string>
  /** Raw request body; serve() passes through as-is (undefined if omitted) */
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

  const httpReq: HttpReq<Record<string, never>> = {
    method: req.method,
    path: segments,
    query: queryRecord,
    headers: req.headers ?? {},
    body: req.body,
    params: (req.params ?? {}) as Record<string, never>,
  }
  const res = await h(httpReq)
  if (res === pass) return { status: 404, body: null }
  return { status: 200, body: res as Res }
}

// Re-export core for consumers that only import http.ts
export type { Handler, Req, Pass } from "./core.ts"
export { pass, leaf, typed, pipe, run } from "./core.ts"
