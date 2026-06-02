// packages/http/src/index.ts — @rhi-zone/fractal-http
//
// HTTP kit built on @rhi-zone/fractal-core.
//
// Every combinator produces/consumes Node<P,Res,M> = { meta: M; handler }.
// meta descriptors are rich enough for OpenAPI projection and typed-client
// derivation (see packages/openapi, and the upcoming client package).
//
// Provides:
//   - path(table): dispatch on first path segment, consume it
//   - methods(table): dispatch on req.method (with path-exhaustion guard)
//   - param(name, child): captures next path segment → string, uses core capture()
//   - query(name, child): captures URL query-string value → string
//   - header(name, child): captures HTTP header value → string
//   - body(child): pulls the LAZY body handle
//   - validate(parse, inner): SYNC combinator → async per-request handler
//   - route(collection?, opts): both-and combinator: collection at path-exhausted,
//     exact children, param fallthrough — carries TRouteMeta for client derivation
//   - serve(node, req): run an HTTP request through a fully-discharged Node
//
// V=string pinning: param/query/header pin V=string via C extends Record<K,string>.
// G1 safety: param('x', leaf<{x:number}>(...)) is a COMPILE ERROR.
//
// choice() stays the general alternation primitive. Its branches collapse —
// literal keys are NOT preserved in the meta type, making it opaque to the
// typed client (like pred to OpenAPI). Use route() for structured routing.

import {
  type Pass,
  pass,
  type Handler,
  type Req,
  type Node,
  type Meta,
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
// NodeShape: the open shape used in table constraints.
// Loose on P, Res, M — combinators only need to call handler.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface NodeShape extends Node<any, any, any> {}

// ---------------------------------------------------------------------------
// HTTP-specific meta variants — tightened to carry literal table types
//
// PathMeta<Children>, MethodsMeta<Verbs>, ParamMeta<K,M>, BodyMeta<T,M>
// preserve literal keys + child meta types for typed-client derivation.
// The wide-union aliases (PathMeta, MethodsMeta, etc.) export the narrowed
// generic forms; existing code using `meta.children` or `meta.verbs` as
// Record<string,Meta> continues to work via the open-record constraint.
// ---------------------------------------------------------------------------

export type PathMeta<Children extends Record<string, NodeShape> = Record<string, NodeShape>> = {
  kind: "path"
  children: Children
}

export type MethodsMeta<Verbs extends Record<string, NodeShape> = Record<string, NodeShape>> = {
  kind: "methods"
  verbs: Verbs
}

export type ParamMeta<K extends string = string, ChildMeta extends Meta = Meta> = {
  kind: "param"
  name: K
  in: "path"
  schema: { type: "string" }
  child: ChildMeta
}

export type QueryMeta   = { kind: "query";   name: string; in: "query"; schema: { type: "string" }; child: Meta }
export type HeaderMeta  = { kind: "header";  name: string; in: "header"; schema: { type: "string" }; child: Meta }

export type BodyMeta<T = unknown, ChildMeta extends Meta = Meta> = {
  kind: "body"
  _bodyType?: T
  child: ChildMeta
}

export type ValidateMeta = { kind: "validate"; schema: Record<string, unknown>; child: Meta }

// ---------------------------------------------------------------------------
// TRouteMeta — the both-and route combinator's meta type.
//
// Carries all three slots: collection, exact children, param fallthrough.
// Each slot's type is preserved literally for typed-client derivation.
//
// ParamSpec<K, Child>: the param slot — a named param key and its child node.
//
// Circular-ref note: The recursive Meta union uses `any` inside TRouteMeta
// to avoid TS2456 circular-alias errors (same pattern as spike/path-bothand.ts).
// ---------------------------------------------------------------------------

export type ParamSpec<K extends string = string, Child extends NodeShape = NodeShape> = {
  name: K
  child: Child
}

export type RouteMeta<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Collection extends NodeShape | undefined = any,
  Children extends Record<string, NodeShape> = Record<string, NodeShape>,
  ParamK extends string = string,
  ParamChild extends NodeShape = NodeShape,
> = {
  kind: "route"
  collection: Collection
  children: Children
  param: ParamSpec<ParamK, ParamChild> | undefined
}

// ---------------------------------------------------------------------------
// HTTP kit combinators
// ---------------------------------------------------------------------------

/**
 * path: dispatch on the first segment of req.path, consume it.
 * Returns Pass if no segment or no match.
 * Generic over the literal table type T so child keys + child meta types
 * are preserved for typed-client derivation.
 * meta: { kind: "path", children: { [seg]: childNode } }
 */
export function path<
  T extends Record<string, NodeShape>,
>(table: T): Node<Record<string, never>, unknown, PathMeta<T>> {
  return {
    meta: { kind: "path", children: table } satisfies PathMeta<T>,
    handler: async (req) => {
      const httpReq = req as HttpReq<Record<string, never>>
      const [seg, ...rest] = httpReq.path
      if (seg === undefined) return pass
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const n = table[seg] as NodeShape | undefined
      if (n === undefined) return pass
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return n.handler({ ...req, path: rest } as Req<any>)
    },
  }
}

/**
 * methods: dispatch on req.method.
 * Returns Pass if no match OR if the path is not fully consumed (non-empty).
 * This makes methods a leaf-level combinator: it only fires when all path
 * segments have been consumed by enclosing path and param combinators.
 * Generic over the literal table type T so verb keys + child meta types
 * are preserved for typed-client derivation.
 * meta: { kind: "methods", verbs: { [VERB]: childNode } }
 */
export function methods<
  T extends Record<string, NodeShape>,
>(table: T): Node<Record<string, never>, unknown, MethodsMeta<T>> {
  return {
    meta: { kind: "methods", verbs: table } satisfies MethodsMeta<T>,
    handler: async (req) => {
      const httpReq = req as HttpReq<Record<string, never>>
      // Only match at the leaf — pass through if path is not exhausted.
      if (httpReq.path.length > 0) return pass
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const n = table[httpReq.method] as NodeShape | undefined
      if (n === undefined) return pass
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return n.handler(req as Req<any>)
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
 * Generic over M (child meta) so the child's precise meta type is preserved
 * in ParamMeta<K, M> for typed-client derivation.
 *
 * meta: { kind: "param", name, in: "path", schema: {type:"string"}, child: child.meta }
 */
export function param<
  K extends string,
  C extends Record<K, string>,
  Res,
  M extends Meta = Meta,
>(name: K, child: Node<C, Res, M>): Node<Omit<C, K>, Res, ParamMeta<K, M>> {
  const childMeta = child.meta
  return {
    meta: { kind: "param", name, in: "path", schema: { type: "string" }, child: childMeta } satisfies ParamMeta<K, M>,
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
  const childMeta: Meta =
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
// route() — the both-and combinator
//
// route(collection?, { children?, param? })
//
// A single node that handles:
//   - path exhausted → delegate to collection (a methods node)
//   - exact segment match → delegate to matching child
//   - no exact match → delegate to param child (captures segment as named param)
//   - no param child → Pass
//
// Dispatch order: path-exhausted → collection; exact child; param fallthrough; Pass.
//
// TRouteMeta carries all three slots with precise types, enabling the typed client
// to derive a callable-object hybrid surface (callable for param, properties for
// collection verbs and exact children).
//
// choice() stays the general alternation primitive (opaque to the typed client).
// route() is the structured routing combinator (transparent to the typed client).
// ---------------------------------------------------------------------------

type RouteOptions<
  Children extends Record<string, NodeShape>,
  ParamK extends string,
  ParamChild extends NodeShape,
> = {
  children?: Children
  param?: ParamSpec<ParamK, ParamChild>
}

// Overload 1: collection present
export function route<
  Collection extends NodeShape,
  Children extends Record<string, NodeShape> = Record<never, never>,
  ParamK extends string = never,
  ParamChild extends NodeShape = never,
>(
  collection: Collection,
  options?: RouteOptions<Children, ParamK, ParamChild>,
): Node<Record<string, never>, unknown, RouteMeta<Collection, Children, ParamK, ParamChild>>

// Overload 2: no collection (explicit undefined)
export function route<
  Children extends Record<string, NodeShape>,
  ParamK extends string = never,
  ParamChild extends NodeShape = never,
>(
  collection: undefined,
  options: RouteOptions<Children, ParamK, ParamChild>,
): Node<Record<string, never>, unknown, RouteMeta<undefined, Children, ParamK, ParamChild>>

// Implementation
export function route(
  collection: NodeShape | undefined,
  options: RouteOptions<Record<string, NodeShape>, string, NodeShape> = {},
): Node<Record<string, never>, unknown, RouteMeta> {
  const children = options.children ?? {} as Record<string, NodeShape>
  const paramSpec = options.param

  const meta: RouteMeta = {
    kind: "route",
    collection,
    children,
    param: paramSpec,
  }

  const handler: Handler<Record<string, never>, unknown> = async (req) => {
    const httpReq = req as HttpReq<Record<string, never>>
    const [seg, ...rest] = httpReq.path

    // Path exhausted → collection
    if (seg === undefined) {
      if (collection === undefined) return pass
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return collection.handler({ ...req, path: [] } as Req<any>)
    }

    // Exact child match
    const exactChild = children[seg] as NodeShape | undefined
    if (exactChild !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return exactChild.handler({ ...req, path: rest } as Req<any>)
    }

    // Param fallthrough
    if (paramSpec !== undefined) {
      const enriched = {
        ...req,
        path: rest,
        params: { ...(req.params as object), [paramSpec.name]: seg },
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return paramSpec.child.handler(enriched as Req<any>)
    }

    return pass
  }

  return { meta, handler }
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
