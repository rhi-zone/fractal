// packages/http/src/index.ts — @rhi-zone/fractal-http
//
// HTTP kit built on @rhi-zone/fractal-core.
//
// Every combinator produces/consumes Node<P,Res> = { meta, handler }.
// meta descriptors are rich enough for OpenAPI projection (future package).
//
// Provides:
//   - path(table): dispatch on first path segment, consume it
//   - methods(table): dispatch on req.method (with path-exhaustion guard)
//   - param(name, child): captures next path segment → string, uses core capture()
//   - query(name, child): captures URL query-string value → string
//   - header(name, child): captures HTTP header value → string
//   - body(child): pulls the LAZY body handle
//   - validate(parse, inner): SYNC combinator → async per-request handler
//   - serve(node, req): run an HTTP request through a fully-discharged Node
//
// V=string pinning: param/query/header pin V=string via C extends Record<K,string>.
// G1 safety: param('x', leaf<{x:number}>(...)) is a COMPILE ERROR.

import {
  type Pass,
  pass,
  type Handler,
  type Req,
  type Node,
  capture,
  resolveSchema,
} from '@rhi-zone/fractal-core'
import type { StandardSchemaV1 } from '@standard-schema/spec'

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
// HTTP-specific meta variants
// ---------------------------------------------------------------------------

export type PathMeta    = { kind: "path";    children: Record<string, import('@rhi-zone/fractal-core').Meta> }
export type MethodsMeta = { kind: "methods"; verbs: Record<string, import('@rhi-zone/fractal-core').Meta> }
export type ParamMeta   = { kind: "param";   name: string; in: "path"; schema: { type: "string" }; child: import('@rhi-zone/fractal-core').Meta }
export type QueryMeta   = { kind: "query";   name: string; in: "query"; schema: { type: "string" }; child: import('@rhi-zone/fractal-core').Meta }
export type HeaderMeta  = { kind: "header";  name: string; in: "header"; schema: { type: "string" }; child: import('@rhi-zone/fractal-core').Meta }
export type BodyMeta    = { kind: "body";    child: import('@rhi-zone/fractal-core').Meta }
export type ValidateMeta = { kind: "validate"; schema: Record<string, unknown>; child: import('@rhi-zone/fractal-core').Meta }

// ---------------------------------------------------------------------------
// HTTP kit combinators
// ---------------------------------------------------------------------------

/**
 * path: dispatch on the first segment of req.path, consume it.
 * Returns Pass if no segment or no match.
 * meta: { kind: "path", children: { [seg]: child.meta } }
 */
export function path<P extends Record<string, unknown>, Res>(
  table: Record<string, Node<P, Res>>,
): Node<P, Res> {
  const childMetas: Record<string, import('@rhi-zone/fractal-core').Meta> = {}
  for (const [k, n] of Object.entries(table)) {
    childMetas[k] = n.meta
  }
  return {
    meta: { kind: "path", children: childMetas } satisfies PathMeta,
    handler: async (req) => {
      const httpReq = req as HttpReq<P>
      const [seg, ...rest] = httpReq.path
      if (seg === undefined) return pass
      const n = table[seg]
      if (n === undefined) return pass
      return n.handler({ ...req, path: rest })
    },
  }
}

/**
 * methods: dispatch on req.method.
 * Returns Pass if no match OR if the path is not fully consumed (non-empty).
 * This makes methods a leaf-level combinator: it only fires when all path
 * segments have been consumed by enclosing path and param combinators.
 * meta: { kind: "methods", verbs: { [VERB]: child.meta } }
 */
export function methods<P extends Record<string, unknown>, Res>(
  table: Record<string, Node<P, Res>>,
): Node<P, Res> {
  const verbMetas: Record<string, import('@rhi-zone/fractal-core').Meta> = {}
  for (const [k, n] of Object.entries(table)) {
    verbMetas[k] = n.meta
  }
  return {
    meta: { kind: "methods", verbs: verbMetas } satisfies MethodsMeta,
    handler: async (req) => {
      const httpReq = req as HttpReq<P>
      // Only match at the leaf — pass through if path is not exhausted.
      if (httpReq.path.length > 0) return pass
      const n = table[httpReq.method]
      if (n === undefined) return pass
      return n.handler(req)
    },
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
 * G1 safety: param('x', leaf<{x:number}>(...)) is a compile error because
 * {x:number} does not satisfy C extends Record<'x',string>.
 * Confirmed by the @ts-expect-error probe below.
 *
 * meta: { kind: "param", name, in: "path", schema: {type:"string"}, child: child.meta }
 */
export function param<
  K extends string,
  C extends Record<K, string>,
  Res,
>(name: K, child: Node<C, Res>): Node<Omit<C, K>, Res> {
  const childMeta = child.meta
  return {
    meta: { kind: "param", name, in: "path", schema: { type: "string" }, child: childMeta } satisfies ParamMeta,
    handler: async (req) => {
      const httpReq = req as HttpReq<Omit<C, K>>
      const [seg, ...rest] = httpReq.path
      if (seg === undefined) return pass
      const enriched = {
        ...req,
        path: rest,
        params: { ...(req.params as object), [name]: seg } as unknown as C,
      } as unknown as HttpReq<C>
      return child.handler(enriched)
    },
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
export const _g1Probe = param("x", { meta: { kind: "leaf" }, handler: _g1LeafWantsNumber })

/**
 * query: captures a URL query parameter as `name`, injects as string.
 *
 * Same Omit<C,K> algebra as param. V pinned to string.
 * Returns Pass if absent.
 * meta: { kind: "query", name, in: "query", schema: {type:"string"}, child: child.meta }
 */
export function query<
  K extends string,
  C extends Record<K, string>,
  Res,
>(name: K, child: Node<C, Res>): Node<Omit<C, K>, Res> {
  const childMeta = child.meta
  const captured = capture(
    name,
    (req) => {
      const httpReq = req as unknown as HttpReq<Omit<C, K>>
      const value = httpReq.query[name]
      return value === undefined ? pass : value
    },
    child,
  )
  return {
    ...captured,
    meta: { kind: "query", name, in: "query", schema: { type: "string" }, child: childMeta } satisfies QueryMeta,
  }
}

/**
 * header: captures an HTTP header as `name`, injects as string.
 *
 * Same Omit<C,K> algebra as param and query. V pinned to string.
 * Header names are lowercased on intake (HTTP/2 mandates lowercase).
 * Returns Pass if absent.
 * meta: { kind: "header", name, in: "header", schema: {type:"string"}, child: child.meta }
 */
export function header<
  K extends string,
  C extends Record<K, string>,
  Res,
>(name: K, child: Node<C, Res>): Node<Omit<C, K>, Res> {
  const childMeta = child.meta
  const captured = capture(
    name,
    (req) => {
      const httpReq = req as unknown as HttpReq<Omit<C, K>>
      const value = httpReq.headers[name]
      return value === undefined ? pass : value
    },
    child,
  )
  return {
    ...captured,
    meta: { kind: "header", name, in: "header", schema: { type: "string" }, child: childMeta } satisfies HeaderMeta,
  }
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
 *
 * If `child` is a ValidatedHandler (from `validate()`), the schema from the
 * validator is embedded in the meta descriptor for OpenAPI projection.
 *
 * meta: { kind: "body", child: validate.meta | { kind: "leaf" } }
 */
export function body<P extends Record<string, unknown>, Res>(
  child: HandlerWithBody<P, unknown, Res>,
): Node<P, Res> {
  const childMeta: import('@rhi-zone/fractal-core').Meta =
    (child as Partial<ValidatedHandler<P, unknown, Res>>).validatedMeta ?? { kind: 'leaf' }

  return {
    meta: { kind: "body", child: childMeta } satisfies BodyMeta,
    handler: async (req) => {
      const httpReq = req as HttpReq<P>
      const rawBody = httpReq.body !== undefined ? await httpReq.body() : undefined
      const enriched: ReqWithBody<P, unknown> = {
        ...req,
        body: rawBody,
      }
      return child(enriched)
    },
  }
}

// ---------------------------------------------------------------------------
// ValidatedHandler — a HandlerWithBody annotated with a schema meta
// ---------------------------------------------------------------------------

/**
 * ValidatedHandler: a HandlerWithBody with an optional `validatedMeta`
 * property so that `body()` can pick up the schema for OpenAPI projection.
 */
export type ValidatedHandler<
  P extends Record<string, unknown>,
  T,
  Res,
> = HandlerWithBody<P, unknown, Res> & { validatedMeta?: ValidateMeta }

/**
 * validate: SYNC combinator that returns an async per-request handler.
 *
 * Accepts either:
 *   - a raw parse function: (raw: unknown) => T | Promise<T>
 *   - a StandardSchemaV1<unknown, T>: uses schema['~standard'].validate
 *
 * Returns a ValidatedHandler (a HandlerWithBody with an optional `.validatedMeta`)
 * so that `body()` can embed the schema in its meta descriptor.
 *
 * The async work happens PER REQUEST inside the returned handler. Building
 * the route tree is pure data construction and is synchronous.
 */
export function validate<
  T,
  P extends Record<string, unknown> = Record<string, never>,
  Res = unknown,
>(
  schemaOrParse: StandardSchemaV1<unknown, T> | ((raw: unknown) => T | Promise<T>),
  inner: HandlerWithBody<P, T, Res>,
): ValidatedHandler<P, T, Res> {
  const isStdSchema = (
    typeof schemaOrParse === 'object' &&
    schemaOrParse !== null &&
    '~standard' in schemaOrParse
  )

  // Extract JSON-Schema for meta (best-effort; `{}` if unavailable)
  const jsonSchema: Record<string, unknown> = isStdSchema
    ? resolveSchema(schemaOrParse as StandardSchemaV1, 'input')
    : {}

  const parseFn = isStdSchema
    ? async (raw: unknown): Promise<T> => {
        const result = await (schemaOrParse as StandardSchemaV1<unknown, T>)['~standard'].validate(raw)
        if (result.issues) {
          throw new Error(
            `[fractal-http] validate: validation failed — ${result.issues.map((i) => i.message).join(', ')}`,
          )
        }
        return result.value
      }
    : (raw: unknown) => Promise.resolve((schemaOrParse as (raw: unknown) => T | Promise<T>)(raw))

  const handler: ValidatedHandler<P, T, Res> = async (req) => {
    const parsed = await parseFn(req.body)
    const enriched: ReqWithBody<P, T> = { ...req, body: parsed }
    return inner(enriched)
  }

  handler.validatedMeta = {
    kind: 'validate',
    schema: jsonSchema,
    child: { kind: 'leaf' },
  } satisfies ValidateMeta

  return handler
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
 * serve: run an HTTP request through a fully-discharged Node.
 * Handles path splitting, query-string parsing, and maps Pass → 404.
 *
 * `n` must be Node<{}> — any undischarged params are a compile error.
 */
export async function serve<Res>(
  n: Node<Record<string, never>, Res>,
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
  const res = await n.handler(httpReq)
  if (res === pass) return { status: 404, body: null }
  return { status: 200, body: res as Res }
}

// Re-export core for consumers that only import fractal-http
export type { Handler, Req, Pass, Node, Meta, NodeMiddleware, StandardSchemaV1, StandardJSONSchemaV1 } from '@rhi-zone/fractal-core'
export { pass, leaf, typed, pipe, run, choice, resolveSchema } from '@rhi-zone/fractal-core'
