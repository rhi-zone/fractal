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
  readonly dispatch: (ctx: Ctx) => Promise<Result | null>
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
> {
  /** Register a handler for method + pattern. Returns this for chaining. */
  route(
    method: string,
    pattern: string,
    handler: (ctx: WithVars<Ctx, Cur>) => Promise<Result>,
    meta?: unknown,
  ): Router<Ctx, In, Cur, Result>

  /** Register a pre-built node ({ meta, handler }) for method + pattern. */
  routeNode(
    method: string,
    pattern: string,
    n: Node<WithVars<Ctx, Cur>, Result>,
  ): Router<Ctx, In, Cur, Result>

  /** Attach middleware applied to every route registered AFTER this call,
   *  widening the visible Vars by `Extra`. Subsequent handlers see
   *  `Cur & Extra` — no cast. Dispatch input (`In`) is unchanged. */
  use<Extra extends Record<string, unknown>>(
    mw: Middleware<Ctx, Cur, Extra, Result>,
  ): Router<Ctx, In, Cur & Extra, Result>

  /** Mount a sub-router under a prefix, threading `Extra` via middleware.
   *  The sub-router's input vars are `Cur & Extra` statically — ZERO casts at
   *  the call site (Router is structural; no private fields). */
  mount<Extra extends Record<string, unknown>>(
    prefix: string,
    mw: Middleware<Ctx, Cur, Extra, Result>,
    subRouter: Router<Ctx, Cur & Extra, Cur & Extra, Result>,
  ): Router<Ctx, In, Cur, Result>

  /** Mount a sub-router under a prefix with no added context. */
  mountPlain(
    prefix: string,
    subRouter: Router<Ctx, Cur, Cur, Result>,
  ): Router<Ctx, In, Cur, Result>

  /** The reflection descriptors of registered routes + mounts. */
  readonly meta: ReadonlyArray<unknown>

  /** Dispatch a request through this router. Returns null on no match. */
  dispatch(ctx: WithVars<Ctx, In>): Promise<Result | null>
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
>(): Router<Ctx, Vars, Vars, Result> {
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

  async function dispatchRoutes(ctx: RoutingCtx): Promise<Result | null> {
    const path = "/" + ctx.segments.join("/")
    for (const entry of routes) {
      if (entry.method !== ctx.method && entry.method !== "*") continue
      const m = entry.pattern.exec(path)
      if (m === null) continue
      const params: Record<string, string> = { ...ctx.params }
      entry.paramNames.forEach((name, i) => { params[name] = m[i + 1] ?? "" })
      const routeCtx = { ...ctx, params } as RoutingCtx
      return entry.handler(routeCtx)
    }
    for (const mount of mounts) {
      const result = await mount.dispatch(ctx)
      if (result !== null) return result
    }
    return null
  }

  const router: Router<Ctx, Vars, Vars, Result> = {
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
      return router.route(method, pattern, n.handler as (ctx: WithVars<Ctx, Vars>) => Promise<Result>, n.meta)
    },

    use<Extra extends Record<string, unknown>>(mw: Middleware<Ctx, Vars, Extra, Result>) {
      pending.push(mw as unknown as AnyMw)
      return router as unknown as Router<Ctx, Vars, Vars & Extra, Result>
    },

    mount<Extra extends Record<string, unknown>>(
      prefix: string,
      mw: Middleware<Ctx, Vars, Extra, Result>,
      subRouter: Router<Ctx, Vars & Extra, Vars & Extra, Result>,
    ) {
      const stripped = stripSlashes(prefix)
      const dispatch = async (ctx: RoutingCtx): Promise<Result | null> => {
        const [head, ...tail] = ctx.segments
        if (head !== stripped) return null
        const subCtx = { ...ctx, segments: tail } as WithVars<Ctx, Vars>
        return mw(subCtx, (enriched) =>
          subRouter.dispatch(enriched).then((r) => r ?? notFoundResult()),
        )
      }
      mounts.push({
        prefix: stripped,
        meta: { kind: "mount", prefix: stripped, child: subRouter.meta },
        dispatch: dispatch as (ctx: RoutingCtx) => Promise<Result | null>,
      })
      return router
    },

    mountPlain(prefix, subRouter) {
      const stripped = stripSlashes(prefix)
      const dispatch = async (ctx: RoutingCtx): Promise<Result | null> => {
        const [head, ...tail] = ctx.segments
        if (head !== stripped) return null
        const subCtx = { ...ctx, segments: tail } as WithVars<Ctx, Vars>
        return subRouter.dispatch(subCtx)
      }
      mounts.push({
        prefix: stripped,
        meta: { kind: "mount", prefix: stripped, child: subRouter.meta },
        dispatch: dispatch as (ctx: RoutingCtx) => Promise<Result | null>,
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

  return router
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
