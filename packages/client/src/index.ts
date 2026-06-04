// packages/client/src/index.ts — @rhi-zone/fractal-client
//
// A TYPED CLIENT derived from a fractal router — end-to-end inference from one
// server definition, matching/beating Eden `treaty` and Hono `hc`.
//
// THE CRUX (lives in @rhi-zone/fractal-core): the router TYPE accumulates each
// registered route as a `RouteSpec { method, pattern, params, input, output }`.
// This file walks that accumulated tuple at the type level to produce a typed
// callable surface, and at runtime serialises each call into either an
// in-process dispatch (Hyper unification — same handler, no network) or a
// `fetch` (HTTP transport). Both share the SAME derived `ClientOf` type.
//
// CALL ERGONOMICS (chosen — beats Eden's segment chaining on conciseness):
//
//   client["/users/:id"].get({ params: { id: "1" } })   -> Promise<User>
//   client["/users"].post({ body: { name, email } })     -> Promise<User>
//   client["/users"].get()                               -> Promise<User[]>
//
// One indexed access by the LITERAL pattern, then the lowercase method, then a
// single typed args object ({ params?, body? }) whose keys appear only when the
// route actually has params / a validated body. Output is the handler's domain
// value (recovered via fractal-http's phantom-typed `json<T>` / `withValidation`
// `__output`), NOT the opaque `Response`.

import { isMethodMismatch } from "@rhi-zone/fractal-core"
import type { RouteSpec, RoutesOf, Router, RoutingCtx } from "@rhi-zone/fractal-core"

// ============================================================================
// ClientOf<Router> — the derived typed surface
// ============================================================================

/** Does this spec carry typed path params? */
type HasParams<Spec extends RouteSpec> =
  keyof Spec["params"] extends never ? false : true

/** Does this spec carry a validated body (input ≠ never)? */
type HasInput<Spec extends RouteSpec> =
  [Spec["input"]] extends [never] ? false : true

/** The single args object a call accepts — `params` and/or `body` appear only
 *  when the route actually has them. Empty when neither (call takes no args). */
type CallArgs<Spec extends RouteSpec> =
  (HasParams<Spec> extends true ? { params: Spec["params"] } : Record<never, never>)
  & (HasInput<Spec> extends true ? { body: Spec["input"] } : Record<never, never>)

/** Recover the DOMAIN body type from a route's captured output. HTTP handlers
 *  return a phantom-typed `Response` (`fractal-http`'s `json<T>` / `text`), which
 *  carries the body type in a `__body` phantom; we unwrap it here so the client
 *  surfaces `T`, not the opaque `Response`. A union of typed responses (e.g.
 *  `json(user) | json(null)`) distributes to the union of bodies. A handler that
 *  returns a non-typed value (or a node's recovered `__output`) passes through. */
type BodyOf<O> =
  [O] extends [never] ? never
  : O extends { readonly __body?: infer T }
    ? [T] extends [undefined] ? O : T
    : O

/** The call signature for one route: typed args in, typed domain output out. */
type CallSig<Spec extends RouteSpec> =
  keyof CallArgs<Spec> extends never
    ? () => Promise<BodyOf<Spec["output"]>>
    : (args: CallArgs<Spec>) => Promise<BodyOf<Spec["output"]>>

/** Every distinct literal pattern in the accumulated routes. */
type Patterns<Routes extends readonly RouteSpec[]> = Routes[number]["pattern"]

/** The typed client surface for a tuple of accumulated routes. */
export type ClientOfRoutes<Routes extends readonly RouteSpec[]> = {
  readonly [P in Patterns<Routes>]: {
    readonly [Spec in Extract<Routes[number], { pattern: P }> as Lowercase<Spec["method"]>]:
      CallSig<Spec>
  }
}

/** The typed client surface derived from a Router type. */
export type ClientOf<R> = ClientOfRoutes<RoutesOf<R>>

// ============================================================================
// Transport — the runtime mechanism (same ClientOf type, different execution)
// ============================================================================

/** A serialised call the transport executes: a method + interpolated path +
 *  optional JSON body. The transport returns the parsed domain value. */
export interface TransportCall {
  readonly method: string
  /** The interpolated path, e.g. "/users/1" (params already substituted). */
  readonly path: string
  /** Path segments of `path` (router dispatch consumes these). */
  readonly segments: string[]
  /** The route's path params, e.g. { id: "1" }. */
  readonly params: Record<string, string>
  /** The request body (already a value; serialised by the transport). */
  readonly body?: unknown
}

/** A transport runs a serialised call and resolves the parsed domain value. */
export interface Transport {
  call(desc: TransportCall): Promise<unknown>
}

// Any HTTP-shaped router (HttpCtx / Response) with any accumulated routes.
type AnyHttpRouter = Router<
  AnyHttpCtx,
  Record<string, unknown>,
  Record<string, unknown>,
  Response,
  readonly RouteSpec[]
>

interface AnyHttpCtx extends RoutingCtx<Record<string, unknown>> {
  readonly query: URLSearchParams
  readonly headers: Headers
  readonly body: () => Promise<unknown>
  readonly request: Request
}

// ============================================================================
// inProcess — Hyper unification: invoke the SAME handler in memory, no network
// ============================================================================

/** Build a transport that dispatches each call through the router IN-PROCESS —
 *  the exact same handler the server runs, no fetch, no serialisation over a
 *  socket. The handler returns a Response; we parse its body to the domain
 *  value so the client sees server-identical results with the derived type. */
export function inProcess(router: AnyHttpRouter): Transport {
  return {
    async call(desc) {
      const url = `http://in-process${desc.path}`
      const reqInit: RequestInit = { method: desc.method }
      if (desc.body !== undefined) {
        reqInit.body = JSON.stringify(desc.body)
        reqInit.headers = { "content-type": "application/json" }
      }
      const request = new Request(url, reqInit)

      let bodyCache: unknown
      let bodyCalled = false
      const ctx: AnyHttpCtx = {
        method: desc.method.toUpperCase(),
        segments: desc.segments,
        params: desc.params,
        query: new URL(url).searchParams,
        headers: request.headers,
        body: async () => {
          if (bodyCalled) return bodyCache
          bodyCalled = true
          bodyCache = desc.body
          return bodyCache
        },
        request,
        vars: {},
      }

      const result = await router.dispatch(ctx)
      if (result === null) throw new ClientError(404, `no route matched ${desc.method} ${desc.path}`)
      if (isMethodMismatch(result)) {
        throw new ClientError(405, `method ${desc.method} not allowed on ${desc.path}`)
      }
      return parseResponse(result)
    },
  }
}

// ============================================================================
// http — serialise the call into a fetch, parse the response
// ============================================================================

/** Build a transport that issues a real `fetch` to `baseUrl + path`, sending the
 *  body as JSON and parsing the response. Same `ClientOf` type as `inProcess`. */
export function http(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Transport {
  const base = baseUrl.replace(/\/$/, "")
  return {
    async call(desc) {
      const init: RequestInit = { method: desc.method }
      if (desc.body !== undefined) {
        init.body = JSON.stringify(desc.body)
        init.headers = { "content-type": "application/json" }
      }
      const res = await fetchImpl(`${base}${desc.path}`, init)
      if (!res.ok) {
        throw new ClientError(res.status, `request failed: ${desc.method} ${desc.path}`, await safeParse(res))
      }
      return parseResponse(res)
    },
  }
}

// ============================================================================
// client — wrap a router (+ transport) in the typed proxy surface
// ============================================================================

/** Derive a typed client from a router. With no transport, defaults to the
 *  in-process transport (the router itself runs the handlers). Pass `http(url)`
 *  (or any `Transport`) to target a real server. The returned value has the
 *  fully-derived `ClientOf<typeof router>` type. */
export function client<R extends AnyHttpRouter>(
  router: R,
  transport: Transport = inProcess(router),
): ClientOf<R> {
  // Proxy over patterns: client["/users/:id"] -> { get, post, ... }.
  // Each method is a function taking { params?, body? } and serialising the call.
  const patternProxy = new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_t, pattern: string | symbol) {
      if (typeof pattern === "symbol") return undefined
      return new Proxy(Object.create(null) as Record<string, unknown>, {
        get(_t2, method: string | symbol) {
          if (typeof method === "symbol") return undefined
          return (args?: { params?: Record<string, string>; body?: unknown }) => {
            const params = args?.params ?? {}
            const path = interpolate(pattern, params)
            const segments = path.replace(/^\//, "").split("/").filter(Boolean)
            return transport.call({
              method: method.toUpperCase(),
              path,
              segments,
              params,
              body: args?.body,
            })
          }
        },
      })
    },
  })
  return patternProxy as ClientOf<R>
}

// ============================================================================
// Errors + helpers
// ============================================================================

/** A failed client call — carries the HTTP status and (when available) the
 *  parsed error body the server returned. */
export class ClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = "ClientError"
  }
}

/** Substitute `:name` segments in a pattern with the given params. */
function interpolate(pattern: string, params: Record<string, string>): string {
  return pattern.replace(/:([^/]+)/g, (_m, name: string) => {
    const v = params[name]
    if (v === undefined) throw new ClientError(0, `missing path param ":${name}" for ${pattern}`)
    return encodeURIComponent(v)
  })
}

/** Parse a Response body to its domain value (JSON when so typed, else text). */
async function parseResponse(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? ""
  if (ct.includes("application/json")) return res.json()
  if (ct.startsWith("text/")) return res.text()
  return res.arrayBuffer()
}

async function safeParse(res: Response): Promise<unknown> {
  try {
    return await parseResponse(res)
  } catch {
    return undefined
  }
}
