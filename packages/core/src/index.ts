// packages/core/src/index.ts — @rhi-zone/fractal-core
//
// Library-first framework core. Surface- AND runtime-agnostic:
//   - no HTTP (no WHATWG Request/Response, no URL)
//   - no runtime (no Bun, no Node)
//
// What lives here:
//   - Handler<T,U>            the fundamental arrow + composition
//   - Node<T,U>              the { meta, handler } composition unit
//   - StandardSchema         a Standard-Schema-shaped interface (types only)
//   - the router             interface + factory threading typed context
//                            (the proven linchpin encoding — interfaces, NoVars,
//                            NO classes-with-private-fields)
//
// LINCHPIN (load-bearing, from spike/linchpins.ts): the router is a plain
// interface + factory function. No class with private fields — private fields
// force generic invariance, which forces casts at mount. The structural
// interface keeps Router<Vars> covariant enough that mount() threads the
// enriched context with ZERO casts.

// ============================================================================
// Handler — the fundamental arrow
// ============================================================================

/** The composition unit at its most primitive: a (possibly async) function. */
export type Handler<T, U> = (t: T) => U | Promise<U>

/** Compose two handlers: run `a`, feed its result to `b`. */
export function compose<A, B, C>(
  a: Handler<A, B>,
  b: Handler<B, C>,
): Handler<A, C> {
  return async (input: A) => b(await a(input))
}

// ============================================================================
// Node — { meta, handler }
// ============================================================================

/** A node pairs reflectable metadata with an executable handler. */
export interface Node<T, U, M = unknown> {
  readonly meta: M
  readonly handler: Handler<T, U>
}

/** Construct a node from meta + handler. */
export function node<T, U, M>(meta: M, handler: Handler<T, U>): Node<T, U, M> {
  return { meta, handler }
}

// ============================================================================
// StandardSchema — Standard-Schema-shaped interface (types only)
// ============================================================================

/** A minimal Standard-Schema-shaped interface. Types only — no runtime. */
export interface StandardSchema<In, Out = In> {
  readonly "~standard": {
    readonly version: 1
    validate(
      value: unknown,
    ):
      | { readonly value: Out; readonly issues?: undefined }
      | { readonly issues: ReadonlyArray<{ readonly message: string }>; readonly value?: undefined }
    readonly _in?: In
  }
}

/** Extract the output type of a StandardSchema. */
export type InferOutput<S> = S extends StandardSchema<unknown, infer Out> ? Out : never

// ============================================================================
// NoVars — the base "no specific vars required" context
// ============================================================================

// Record<never, never> (≡ {}) rather than Record<string, never>:
// Record<string, never> & Extra requires every key to be never, breaking the
// intersection. Record<never, never> means "no required vars" and intersects
// cleanly with any Record<string, unknown> extension.
export type NoVars = Record<never, never>

// ============================================================================
// Routing context — the surface-agnostic substrate the router dispatches over
// ============================================================================

/** The minimal context the core router needs to dispatch.
 *
 *  A surface (HTTP, CLI, …) extends this with its own fields (query, headers,
 *  body, …) and supplies the concrete ctx at the toHandler boundary. The core
 *  router only reads `method`, `segments`, `params`, and threads `vars`.
 *
 *  `Vars` is the typed context map middleware contributes; handlers read it
 *  with the precise type, no cast. */
export interface RoutingCtx<Vars extends Record<string, unknown> = NoVars> {
  readonly method: string
  readonly segments: string[]
  readonly params: Record<string, string>
  readonly vars: Vars
}

/** A handler bound to a routing context carrying `Vars`. */
export type RouteHandler<Ctx extends RoutingCtx, Result> = Handler<Ctx, Result>

// ---------------------------------------------------------------------------
// Dispatch outcome — distinguishes "no path matched" from "method mismatch"
// ---------------------------------------------------------------------------

/** Core sentinel: a path matched but no entry matched the method. Carries the
 *  methods registered at that path so the surface can emit 405 + `Allow`.
 *
 *  Deliberately NOT an HTTP type — the core stays surface-agnostic. The HTTP
 *  surface maps this to a 405 Response; a CLI surface could map it differently. */
export interface MethodMismatch {
  readonly kind: "method-mismatch"
  readonly allow: string[]
}

/** What a router's `dispatch` resolves to:
 *   - `Result`         a handler matched and produced a value
 *   - `null`           no path matched (the surface renders its 404)
 *   - `MethodMismatch` a path matched but not the method (surface → 405 + Allow) */
export type Dispatched<Result> = Result | null | MethodMismatch

export function isMethodMismatch(v: unknown): v is MethodMismatch {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { kind?: unknown }).kind === "method-mismatch"
  )
}

/** Middleware: receives the current ctx and a `next` that expects the ctx
 *  enriched with `Extra`. It contributes `Extra` to vars then calls next.
 *  The enriched context's handlers see `Vars & Extra` statically. */
export type Middleware<
  Ctx extends RoutingCtx,
  Vars extends Record<string, unknown>,
  Extra extends Record<string, unknown>,
  Result,
> = (
  ctx: WithVars<Ctx, Vars>,
  next: (ctx: WithVars<Ctx, Vars & Extra>) => Promise<Result>,
) => Promise<Result>

/** Re-parameterise a routing context's `vars` slot. */
export type WithVars<Ctx extends RoutingCtx, Vars extends Record<string, unknown>> =
  Omit<Ctx, "vars"> & { readonly vars: Vars }

// ---------------------------------------------------------------------------
// Typed path params — parse the pattern STRING at the type level
//
// "/users/:id"            -> { id: string }
// "/users/:id/books/:bid" -> { id: string; bid: string }
// "/users"                -> {} (Record<never, never>)
//
// A `:name` segment runs until the next "/". Multiple params accumulate. No
// casts: the verb-sugar methods narrow ctx.params to PathParams<P>.
// ---------------------------------------------------------------------------

/** Extract the union of `:param` names from a route pattern string. */
export type PathParamNames<P extends string> =
  P extends `${infer _Head}:${infer Rest}`
    ? Rest extends `${infer Name}/${infer Tail}`
      ? Name | PathParamNames<`/${Tail}`>
      : Rest
    : never

/** A typed params record for a route pattern: `{ [name]: string }`, or `{}`. */
export type PathParams<P extends string> = {
  readonly [K in PathParamNames<P>]: string
}

/** A routing context whose `params` is narrowed to the pattern's typed params. */
export type WithParams<Ctx extends RoutingCtx, P extends string> =
  Omit<Ctx, "params"> & { readonly params: PathParams<P> }

// ---------------------------------------------------------------------------
// Route accumulation — the router TYPE carries each registered route as a
// descriptor so a client can be derived from the same value that serves.
//
// Each `.route`/`.get`/... appends a `RouteSpec` to the router's `Routes` tuple.
// `.mount` prefixes the sub-router's accumulated specs and concatenates them.
// This is the crux: routes must accumulate IN THE TYPE, cast-free, for ClientOf.
// ---------------------------------------------------------------------------

/** A single registered route, captured at the type level. */
export interface RouteSpec {
  /** The HTTP-ish method, uppercased ("GET", "POST", ...). */
  readonly method: string
  /** The literal route pattern, e.g. "/users/:id". */
  readonly pattern: string
  /** Typed path params parsed from the pattern. */
  readonly params: Record<string, string>
  /** The request input (validated body) — `never` when the route has none. */
  readonly input: unknown
  /** The handler's domain output (body type recovered from its return). */
  readonly output: unknown
}

/** Build a `RouteSpec` from its parts (keeps the verb signatures terse). */
export interface RouteOf<M extends string, P extends string, Input, Output> {
  readonly method: M
  readonly pattern: P
  readonly params: PathParams<P>
  readonly input: Input
  readonly output: Output
}

/** Extract the accumulated route tuple from a Router type. */
export type RoutesOf<R> =
  R extends Router<infer _C, infer _I, infer _Cur, infer _Res, infer Routes> ? Routes : never

/** Recover a node's declared input (validated body). A node may carry a phantom
 *  `__input` in its meta (set by `withValidation`); absent → `never`. */
export type NodeInput<N> = N extends { readonly meta: { readonly __input?: infer I } }
  ? [I] extends [undefined] ? never : I
  : never

/** Recover a node's declared domain output. A node may carry a phantom
 *  `__output` in its meta; absent → fall back to the handler's return type. */
export type NodeOutput<N> = N extends { readonly meta: { readonly __output?: infer O } }
  ? [O] extends [undefined]
    ? N extends { readonly handler: (...a: never[]) => infer R } ? Awaited<R> : unknown
    : O
  : N extends { readonly handler: (...a: never[]) => infer R } ? Awaited<R> : unknown

/** Prefix every spec's pattern in `Subs` with `Prefix` (for `.mount`). */
export type PrefixRoutes<Prefix extends string, Subs extends readonly RouteSpec[]> = {
  readonly [I in keyof Subs]: Subs[I] extends RouteSpec
    ? {
        readonly method: Subs[I]["method"]
        readonly pattern: JoinPath<Prefix, Subs[I]["pattern"]>
        readonly params: Subs[I]["params"]
        readonly input: Subs[I]["input"]
        readonly output: Subs[I]["output"]
      }
    : never
}

/** Join a mount prefix to a sub-pattern, normalising slashes:
 *  ("/admin", "/me") -> "/admin/me"; ("/admin", "/") -> "/admin". */
export type JoinPath<Prefix extends string, Sub extends string> =
  TrimSlash<Prefix> extends infer Pfx extends string
    ? TrimSlash<Sub> extends infer Sfx extends string
      ? Sfx extends "" ? `/${Pfx}` : `/${Pfx}/${Sfx}`
      : never
    : never

type TrimSlash<S extends string> =
  S extends `/${infer R}` ? TrimSlash<R> : S extends `${infer R}/` ? TrimSlash<R> : S

// ---------------------------------------------------------------------------
// Entries (erased to base Vars after registration)
// ---------------------------------------------------------------------------

interface RouteEntry<Ctx extends RoutingCtx, Result> {
  readonly method: string
  readonly pattern: RegExp
  readonly paramNames: string[]
  readonly meta: unknown
  readonly handler: (ctx: Ctx) => Promise<Result>
}

interface MountEntry<Ctx extends RoutingCtx, Result> {
  readonly prefix: string
  readonly meta: unknown
  readonly dispatch: (ctx: Ctx) => Promise<Dispatched<Result>>
}

/** The Router VALUE — interface, no private fields, structurally typed.
 *
 *  `Ctx`    the concrete routing context type (e.g. HttpCtx).
 *  `In`     the vars a caller must supply at `dispatch` (the router's input).
 *  `Cur`    the vars currently visible to handlers registered via `route` —
 *           widened by each `use()`. Starts equal to `In`.
 *  `Result` the handler return type (e.g. Response).
 *
 *  `use()` widens `Cur` (handlers see more), never `In` (callers supply the
 *  same base) — the middleware fills the gap at runtime. */
export interface Router<
  Ctx extends RoutingCtx,
  In extends Record<string, unknown>,
  Cur extends Record<string, unknown>,
  Result,
  Routes extends readonly RouteSpec[] = readonly [],
> {
  /** Register a handler for method + pattern. Returns this for chaining.
   *  Accumulates `{ method, pattern, params, output }` in the router's type. */
  route<P extends string, M extends string, R extends Result>(
    method: M,
    pattern: P,
    handler: (ctx: WithParams<WithVars<Ctx, Cur>, P>) => Promise<R>,
    meta?: unknown,
  ): Router<Ctx, In, Cur, Result, readonly [...Routes, RouteOf<Uppercase<M>, P, never, Awaited<R>>]>

  /** Register a pre-built node ({ meta, handler }) for method + pattern.
   *  Recovers the node's typed input/output (e.g. from `withValidation`). */
  routeNode<P extends string, M extends string, N extends Node<WithParams<WithVars<Ctx, Cur>, P>, Result, unknown>>(
    method: M,
    pattern: P,
    n: N,
  ): Router<Ctx, In, Cur, Result, readonly [...Routes, RouteOf<Uppercase<M>, P, NodeInput<N>, NodeOutput<N>>]>

  // -- verb sugar — thin wrappers over `route` that ALSO type ctx.params from
  //    the pattern string (`:id` → params.id: string). Desugar to `.route`.
  get<P extends string, R extends Result>(
    pattern: P,
    handler: (ctx: WithParams<WithVars<Ctx, Cur>, P>) => Promise<R>,
    meta?: unknown,
  ): Router<Ctx, In, Cur, Result, readonly [...Routes, RouteOf<"GET", P, never, Awaited<R>>]>
  post<P extends string, R extends Result>(
    pattern: P,
    handler: (ctx: WithParams<WithVars<Ctx, Cur>, P>) => Promise<R>,
    meta?: unknown,
  ): Router<Ctx, In, Cur, Result, readonly [...Routes, RouteOf<"POST", P, never, Awaited<R>>]>
  put<P extends string, R extends Result>(
    pattern: P,
    handler: (ctx: WithParams<WithVars<Ctx, Cur>, P>) => Promise<R>,
    meta?: unknown,
  ): Router<Ctx, In, Cur, Result, readonly [...Routes, RouteOf<"PUT", P, never, Awaited<R>>]>
  patch<P extends string, R extends Result>(
    pattern: P,
    handler: (ctx: WithParams<WithVars<Ctx, Cur>, P>) => Promise<R>,
    meta?: unknown,
  ): Router<Ctx, In, Cur, Result, readonly [...Routes, RouteOf<"PATCH", P, never, Awaited<R>>]>
  delete<P extends string, R extends Result>(
    pattern: P,
    handler: (ctx: WithParams<WithVars<Ctx, Cur>, P>) => Promise<R>,
    meta?: unknown,
  ): Router<Ctx, In, Cur, Result, readonly [...Routes, RouteOf<"DELETE", P, never, Awaited<R>>]>
  head<P extends string, R extends Result>(
    pattern: P,
    handler: (ctx: WithParams<WithVars<Ctx, Cur>, P>) => Promise<R>,
    meta?: unknown,
  ): Router<Ctx, In, Cur, Result, readonly [...Routes, RouteOf<"HEAD", P, never, Awaited<R>>]>
  options<P extends string, R extends Result>(
    pattern: P,
    handler: (ctx: WithParams<WithVars<Ctx, Cur>, P>) => Promise<R>,
    meta?: unknown,
  ): Router<Ctx, In, Cur, Result, readonly [...Routes, RouteOf<"OPTIONS", P, never, Awaited<R>>]>

  /** Attach middleware applied to every route registered AFTER this call,
   *  widening the visible Vars by `Extra`. Subsequent handlers see
   *  `Cur & Extra` — no cast. Dispatch input (`In`) is unchanged. */
  use<Extra extends Record<string, unknown>>(
    mw: Middleware<Ctx, Cur, Extra, Result>,
  ): Router<Ctx, In, Cur & Extra, Result, Routes>

  /** Mount a sub-router under a prefix, threading `Extra` via middleware.
   *  The sub-router's input vars are `Cur & Extra` statically — ZERO casts at
   *  the call site (Router is structural; no private fields). The sub-router's
   *  accumulated routes are prefixed and merged into this router's type. */
  mount<Extra extends Record<string, unknown>, P extends string, Subs extends readonly RouteSpec[]>(
    prefix: P,
    mw: Middleware<Ctx, Cur, Extra, Result>,
    subRouter: Router<Ctx, Cur & Extra, Cur & Extra, Result, Subs>,
  ): Router<Ctx, In, Cur, Result, readonly [...Routes, ...PrefixRoutes<P, Subs>]>

  /** Mount a sub-router under a prefix with no added context. */
  mountPlain<P extends string, Subs extends readonly RouteSpec[]>(
    prefix: P,
    subRouter: Router<Ctx, Cur, Cur, Result, Subs>,
  ): Router<Ctx, In, Cur, Result, readonly [...Routes, ...PrefixRoutes<P, Subs>]>

  /** The reflection descriptors of registered routes + mounts. */
  readonly meta: ReadonlyArray<unknown>

  /** Phantom carrier for the accumulated route tuple (type-level only; the
   *  runtime value is `undefined`). Lets `RoutesOf<typeof app>` and the client
   *  derivation read the accumulated specs without a separate type alias. */
  readonly __routes?: Routes

  /** Dispatch a request through this router. Resolves to the handler's `Result`,
   *  `null` (no path matched → surface 404), or a `MethodMismatch` (a path
   *  matched but not the method → surface 405 + `Allow`). */
  dispatch(ctx: WithVars<Ctx, In>): Promise<Dispatched<Result>>
}

// ---------------------------------------------------------------------------
// parsePattern — "/admin/:id" → { re, paramNames }
// ---------------------------------------------------------------------------

function parsePattern(pattern: string): { re: RegExp; paramNames: string[] } {
  const paramNames: string[] = []
  const reStr = pattern.replace(/:([^/]+)/g, (_m, name: string) => {
    paramNames.push(name)
    return "([^/]+)"
  })
  return { re: new RegExp(`^${reStr}$`), paramNames }
}

function stripSlashes(prefix: string): string {
  return prefix.replace(/^\//, "").replace(/\/$/, "")
}

// ---------------------------------------------------------------------------
// createRouter — factory; NO class, NO private fields.
//
// `use` widens the return type to Router<Ctx, Vars & Extra, Result> while
// returning the SAME underlying mutable arrays (structurally typed). The
// pending-middleware stack is applied to handlers registered after the call.
// ---------------------------------------------------------------------------

type AnyMw = (
  ctx: RoutingCtx<Record<string, unknown>>,
  next: (ctx: RoutingCtx<Record<string, unknown>>) => Promise<unknown>,
) => Promise<unknown>

export function createRouter<
  Ctx extends RoutingCtx,
  Vars extends Record<string, unknown> = NoVars,
  Result = unknown,
>(): Router<Ctx, Vars, Vars, Result, readonly []> {
  const routes: Array<RouteEntry<RoutingCtx, Result>> = []
  const mounts: Array<MountEntry<RoutingCtx, Result>> = []
  const pending: AnyMw[] = []

  // Wrap a final handler in the currently-accumulated middleware stack.
  const wrap = (
    stack: AnyMw[],
    final: (ctx: RoutingCtx) => Promise<Result | null>,
  ): ((ctx: RoutingCtx) => Promise<Result | null>) => {
    return stack.reduceRight<(ctx: RoutingCtx) => Promise<Result | null>>(
      (next, mw) => (ctx) =>
        mw(
          ctx as RoutingCtx<Record<string, unknown>>,
          (enriched) => next(enriched) as Promise<unknown>,
        ) as Promise<Result | null>,
      final,
    )
  }

  // Run a single entry against a path, threading captured params into ctx.
  const runEntry = (
    entry: RouteEntry<RoutingCtx, Result>,
    ctx: RoutingCtx,
    m: RegExpExecArray,
  ): Promise<Result> => {
    const params: Record<string, string> = { ...ctx.params }
    entry.paramNames.forEach((name, i) => { params[name] = m[i + 1] ?? "" })
    const routeCtx = { ...ctx, params } as RoutingCtx
    return entry.handler(routeCtx)
  }

  async function dispatchRoutes(ctx: RoutingCtx): Promise<Dispatched<Result>> {
    const path = "/" + ctx.segments.join("/")
    // Methods registered at this exact path (drives 405 + Allow, and HEAD/GET).
    const pathMethods = new Set<string>()
    let headFallback: { entry: RouteEntry<RoutingCtx, Result>; m: RegExpExecArray } | undefined

    for (const entry of routes) {
      const m = entry.pattern.exec(path)
      if (m === null) continue
      // The path matched. Record the registered method for Allow/HEAD synthesis.
      if (entry.method !== "*") pathMethods.add(entry.method)
      if (entry.method === ctx.method || entry.method === "*") {
        return runEntry(entry, ctx, m)
      }
      // Auto-HEAD: remember the first GET as a fallback for a HEAD request.
      if (ctx.method === "HEAD" && entry.method === "GET" && headFallback === undefined) {
        headFallback = { entry, m }
      }
    }

    // No explicit HEAD route, but a GET matched: synthesize HEAD from GET.
    if (headFallback !== undefined) {
      return runEntry(headFallback.entry, ctx, headFallback.m)
    }

    for (const mount of mounts) {
      const result = await mount.dispatch(ctx)
      if (result !== null) return result
    }

    // A path matched but no method did → 405 (surface emits Allow). When HEAD is
    // requestable via GET, advertise it in Allow too.
    if (pathMethods.size > 0) {
      const allow = new Set(pathMethods)
      if (allow.has("GET")) allow.add("HEAD")
      return { kind: "method-mismatch", allow: [...allow] }
    }
    return null
  }

  // The IMPLEMENTATION is described by a non-accumulating, loosely-typed shape:
  // every builder method returns the same mutable `router`. The accumulation
  // lives entirely in the PUBLIC `Router` interface; the factory casts to it
  // once at `return` (localized internal `as`, like `use`/`mount` already did).
  // This keeps the public ClientOf/route-accumulation typing cast-free while the
  // runtime stays a single shared object.
  interface RouterImpl {
    route(method: string, pattern: string, handler: (ctx: RoutingCtx) => Promise<Result>, meta?: unknown): RouterImpl
    routeNode(method: string, pattern: string, n: Node<RoutingCtx, Result>): RouterImpl
    get(pattern: string, handler: (ctx: RoutingCtx) => Promise<Result>, meta?: unknown): RouterImpl
    post(pattern: string, handler: (ctx: RoutingCtx) => Promise<Result>, meta?: unknown): RouterImpl
    put(pattern: string, handler: (ctx: RoutingCtx) => Promise<Result>, meta?: unknown): RouterImpl
    patch(pattern: string, handler: (ctx: RoutingCtx) => Promise<Result>, meta?: unknown): RouterImpl
    delete(pattern: string, handler: (ctx: RoutingCtx) => Promise<Result>, meta?: unknown): RouterImpl
    head(pattern: string, handler: (ctx: RoutingCtx) => Promise<Result>, meta?: unknown): RouterImpl
    options(pattern: string, handler: (ctx: RoutingCtx) => Promise<Result>, meta?: unknown): RouterImpl
    use(mw: AnyMw): RouterImpl
    mount(prefix: string, mw: AnyMw, subRouter: Router<Ctx, Record<string, unknown>, Record<string, unknown>, Result, readonly RouteSpec[]>): RouterImpl
    mountPlain(prefix: string, subRouter: Router<Ctx, Record<string, unknown>, Record<string, unknown>, Result, readonly RouteSpec[]>): RouterImpl
    readonly meta: ReadonlyArray<unknown>
    dispatch(ctx: RoutingCtx): Promise<Dispatched<Result>>
  }

  const router: RouterImpl = {
    route(method, pattern, handler, meta) {
      const { re, paramNames } = parsePattern(pattern)
      const stack = [...pending]
      const wrapped = wrap(stack, handler as (ctx: RoutingCtx) => Promise<Result | null>)
      routes.push({
        method: method.toUpperCase(),
        pattern: re,
        paramNames,
        meta: meta ?? { kind: "route", method: method.toUpperCase(), pattern },
        handler: (ctx) => wrapped(ctx) as Promise<Result>,
      })
      return router
    },

    routeNode(method, pattern, n) {
      return router.route(method, pattern, n.handler as (ctx: RoutingCtx) => Promise<Result>, n.meta)
    },

    // Verb sugar — desugar to `route`. The handler's ctx.params is narrowed to
    // PathParams<P> at the type level; at RUNTIME params is the same
    // Record<string,string> route() supplies, so the verb handler is sound to
    // run as a route handler. The single cast here erases only the params
    // narrowing (a structural view), not user-facing inference.
    get(pattern, handler, meta) {
      return router.route("GET", pattern, handler, meta)
    },
    post(pattern, handler, meta) {
      return router.route("POST", pattern, handler, meta)
    },
    put(pattern, handler, meta) {
      return router.route("PUT", pattern, handler, meta)
    },
    patch(pattern, handler, meta) {
      return router.route("PATCH", pattern, handler, meta)
    },
    delete(pattern, handler, meta) {
      return router.route("DELETE", pattern, handler, meta)
    },
    head(pattern, handler, meta) {
      return router.route("HEAD", pattern, handler, meta)
    },
    options(pattern, handler, meta) {
      return router.route("OPTIONS", pattern, handler, meta)
    },

    use(mw) {
      pending.push(mw)
      return router
    },

    mount(prefix, mw, subRouter) {
      const stripped = stripSlashes(prefix)
      const dispatch = async (ctx: RoutingCtx): Promise<Dispatched<Result>> => {
        const [head, ...tail] = ctx.segments
        if (head !== stripped) return null
        const subCtx = { ...ctx, segments: tail } as RoutingCtx<Record<string, unknown>>
        // The middleware contract is "next resolves a Result". A sub-dispatch
        // that produces null / MethodMismatch is carried THROUGH next as the
        // Result, then unwrapped on the way out so the surface sees it.
        return mw(subCtx, (enriched) =>
          subRouter.dispatch(enriched as WithVars<Ctx, Record<string, unknown>>).then((r) => (r ?? notFoundResult()) as Result),
        ) as Promise<Dispatched<Result>>
      }
      mounts.push({
        prefix: stripped,
        meta: { kind: "mount", prefix: stripped, child: subRouter.meta },
        dispatch: dispatch as (ctx: RoutingCtx) => Promise<Dispatched<Result>>,
      })
      return router
    },

    mountPlain(prefix, subRouter) {
      const stripped = stripSlashes(prefix)
      const dispatch = async (ctx: RoutingCtx): Promise<Dispatched<Result>> => {
        const [head, ...tail] = ctx.segments
        if (head !== stripped) return null
        const subCtx = { ...ctx, segments: tail } as WithVars<Ctx, Record<string, unknown>>
        return subRouter.dispatch(subCtx)
      }
      mounts.push({
        prefix: stripped,
        meta: { kind: "mount", prefix: stripped, child: subRouter.meta },
        dispatch: dispatch as (ctx: RoutingCtx) => Promise<Dispatched<Result>>,
      })
      return router
    },

    get meta() {
      return [...routes.map((r) => r.meta), ...mounts.map((m) => m.meta)]
    },

    dispatch(ctx) {
      return dispatchRoutes(ctx as RoutingCtx)
    },
  }

  // Single localized cast from the loose impl to the accumulating public type.
  return router as unknown as Router<Ctx, Vars, Vars, Result, readonly []>
}

// `notFoundResult` is a hole the surface fills: the core has no Response type.
// A mount's middleware must call `next` and receive *something* when the
// sub-router passes (returns null). We return null-as-Result; the surface's
// toHandler maps a top-level null to its own 404. The middleware contract is
// "next always resolves a Result", so we coerce null → Result here; the only
// observable null is the top-level one in toHandler.
function notFoundResult<Result>(): Result {
  return null as Result
}
