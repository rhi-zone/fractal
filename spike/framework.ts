// spike/framework.ts
//
// DESIGN SPIKE: surface-agnostic, runtime-agnostic web framework
//
// Layering (each lower layer is a TARGET, not a foundation):
//   1. CORE   — surface- AND runtime-agnostic.
//              Handler = async (req: CoreReq) => Result
//              Router = a VALUE you build, mount(), attach middleware to.
//              No http import. No runtime import.
//   2. HTTP   — maps a Router to (req: Request) => Promise<Response> (WHATWG).
//              Defines Ctx over Request with typed context vars (set by mw).
//              No Bun/Node import.
//   3. RUNTIME — serveBun(h) — ~3 lines, proves runtime-neutrality by reference.
//              In this spike we call the WHATWG handler directly with constructed
//              new Request(...) — no socket binding needed.
//
// Proven against real sample clusters:
//   - Config GET/PATCH pairs (24 hand-written) → 2 generic routes + registry
//   - POST /integrations/:name/test (19 near-identical) → 1 route + dispatch map
//   - CRUD block → crud() helper that returns a mountable sub-router
//   - All under /admin with auth+scope middleware declared ONCE at mount
//
// ACCEPTANCE tests at bottom: each scenario printed with status + body.

export {} // Ensure module scope — no global leakage

// ============================================================================
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  LAYER 1 — CORE                                                         ║
// ║  No http import. No runtime import.                                     ║
// ╚══════════════════════════════════════════════════════════════════════════╝
// ============================================================================

// ---------------------------------------------------------------------------
// Sentinel
// ---------------------------------------------------------------------------

const PASS = Symbol("fractal.Pass")
/** Pass = "not me, try next handler / return 404". */
type Pass = typeof PASS
const pass: Pass = PASS

// ---------------------------------------------------------------------------
// Core request — an opaque carrier; each layer adds its own fields
// ---------------------------------------------------------------------------

/** CoreReq<Ctx>: minimal opaque envelope.
 *  Ctx carries typed context variables set by middleware (user, scopes, etc.)
 *  Params for path segments are injected alongside Ctx by the http layer's
 *  router, not by a core algebra — this spike uses simpler direct injection.
 */
type CoreReq<Ctx extends Record<string, unknown> = Record<string, unknown>> = {
  readonly _ctx: Ctx
}

/** CoreHandler<Ctx, Res>: the fundamental arrow.
 *  Composition is function composition.
 */
type CoreHandler<Ctx extends Record<string, unknown>, Res> =
  (req: CoreReq<Ctx>) => Promise<Res | Pass>

// ---------------------------------------------------------------------------
// Middleware — a function that wraps a handler
// ---------------------------------------------------------------------------

/** Middleware<Ctx, AddedCtx, Res>:
 *  Receives a handler that needs Ctx & AddedCtx, returns a handler that only
 *  needs Ctx (it supplies AddedCtx itself by injecting into req._ctx).
 */
type Middleware<
  Ctx extends Record<string, unknown>,
  AddedCtx extends Record<string, unknown>,
  Res,
> = (
  next: CoreHandler<Ctx & AddedCtx, Res>,
) => CoreHandler<Ctx, Res>

/** applyMiddleware: compose an ordered list of middlewares, outermost first.
 *
 *  The generic chain is collapsed: each step narrows Ctx independently.
 *  TypeScript cannot infer the chain's cumulative type through a generic
 *  reduce — this is a well-known TS limitation with heterogeneous pipelines.
 *  In practice, at a mount point all middleware share the same added-ctx type
 *  (or you group them with `withMiddleware`).  The cast is load-bearing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyMiddleware<Ctx extends Record<string, unknown>, Res>(
  handler: CoreHandler<Ctx, Res>,
  middlewares: Array<(next: CoreHandler<any, any>) => CoreHandler<any, any>>,
): CoreHandler<Ctx, Res> {
  return middlewares.reduceRight(
    (acc: CoreHandler<any, any>, mw) => mw(acc),
    handler,
  ) as CoreHandler<Ctx, Res>
}

// ---------------------------------------------------------------------------
// Core: no http or runtime symbols past this point in layer 1
// (http layer below imports only WHATWG Request/Response — built-in, no runtime)
// ---------------------------------------------------------------------------

// ============================================================================
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  LAYER 2 — HTTP                                                         ║
// ║  Maps Router → (req: Request) => Promise<Response>  (WHATWG standard)  ║
// ║  No Bun import. No Node import.                                         ║
// ╚══════════════════════════════════════════════════════════════════════════╝
// ============================================================================

// ---------------------------------------------------------------------------
// Ctx — the HTTP layer's request context
// ---------------------------------------------------------------------------

/** HttpCtx<TypedVars>: the framework's own request context.
 *
 *  - method:   HTTP verb (uppercase)
 *  - segments: remaining path segments (consumed by router dispatch)
 *  - params:   path params captured by router (e.g. { id: "42" })
 *  - query:    raw query-string accessor (possibly-undefined values)
 *  - headers:  raw header accessor (possibly-undefined values)
 *  - body:     lazy body thunk (pulled at most once)
 *  - vars:     typed context variables set by middleware (user, scopes, …)
 *
 *  TypedVars is a type-level map: middleware that sets `user` widens it.
 *  Handlers read ctx.vars.user with static type inferred from the middleware.
 */
type HttpCtx<TypedVars extends Record<string, unknown> = Record<string, never>> = {
  method: string
  segments: string[]
  params: Record<string, string>
  query: URLSearchParams
  headers: Headers
  body: () => Promise<unknown>
  vars: TypedVars
}

/** Req in the http layer: CoreReq carrying an HttpCtx */
type Req<TypedVars extends Record<string, unknown> = Record<string, never>> =
  CoreReq<HttpCtx<TypedVars>>

// ---------------------------------------------------------------------------
// Standard Schema fixture (hand-rolled — NO valibot dep)
// ---------------------------------------------------------------------------

/** StandardSchemaV1 minimal interface — enough to represent what the http
 *  layer needs for declared-validation adapters. */
interface StandardSchema<In, Out = In> {
  readonly "~standard": {
    validate(
      value: unknown,
    ): { value: Out; issues?: undefined } | { issues: Array<{ message: string }>; value?: undefined }
  }
  readonly _in?: In
  readonly _out?: Out
}

/** Tiny object-schema builder used in tests below.
 *  schema({ name: "string" }) produces a StandardSchema that validates
 *  an object with the given required string fields. */
function schema<const Fields extends Record<string, "string" | "number">>(
  fields: Fields,
): StandardSchema<
  { [K in keyof Fields]: Fields[K] extends "string" ? string : number },
  { [K in keyof Fields]: Fields[K] extends "string" ? string : number }
> {
  type Out = { [K in keyof Fields]: Fields[K] extends "string" ? string : number }
  return {
    "~standard": {
      validate(value: unknown) {
        if (typeof value !== "object" || value === null) {
          return { issues: [{ message: "Expected an object" }] }
        }
        const obj = value as Record<string, unknown>
        const result = {} as Record<string, unknown>
        for (const [k, t] of Object.entries(fields)) {
          if (typeof obj[k] !== t) {
            return { issues: [{ message: `Field "${k}" must be a ${t}` }] }
          }
          result[k] = obj[k]
        }
        return { value: result as Out }
      },
    },
  }
}

// ---------------------------------------------------------------------------
// ValidatedBody<S> — extracts the output type from a StandardSchema
// ---------------------------------------------------------------------------

type InferSchema<S> = S extends StandardSchema<unknown, infer Out> ? Out : never

// ---------------------------------------------------------------------------
// Route — a single endpoint definition
// ---------------------------------------------------------------------------

/** RouteSchema: declared validation for a route (opt-in adapter layer).
 *  When declared, the http layer validates once; the handler receives typed values.
 *  Invalid input → 400 Response. */
interface RouteSchema {
  body?: StandardSchema<unknown>
  query?: StandardSchema<unknown>
}

/** ValidatedReq<TypedVars, S>: when declared validation is attached,
 *  the handler sees validated typed values instead of raw. */
type ValidatedReq<
  TypedVars extends Record<string, unknown>,
  S extends RouteSchema,
> = Req<TypedVars> & {
  readonly _ctx: HttpCtx<TypedVars>
  validatedBody: S["body"] extends StandardSchema<unknown> ? InferSchema<S["body"]> : never
  validatedQuery: S["query"] extends StandardSchema<unknown> ? InferSchema<S["query"]> : never
}

/** Route<TypedVars, S>: a route definition (data, not function). */
interface Route<
  TypedVars extends Record<string, unknown> = Record<string, never>,
  S extends RouteSchema = RouteSchema,
> {
  method: string
  /** Relative path pattern (e.g. "/:id" or "/test"). Supports :param segments. */
  pattern: string
  schema?: S
  handler: (req: ValidatedReq<TypedVars, S>) => Promise<Response>
}

/** route() — helper to construct a Route value. TypeScript infers S from the
 *  `schema` field, which threads the typed values into the handler signature. */
function route<
  TypedVars extends Record<string, unknown>,
  S extends RouteSchema,
>(r: Route<TypedVars, S>): Route<TypedVars, S> {
  return r
}

// ---------------------------------------------------------------------------
// Router — a VALUE you build, mount, and attach middleware to
// ---------------------------------------------------------------------------

/** RouterMiddleware: a middleware function in the http layer's terms. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouterMiddleware<AddedVars extends Record<string, unknown>> = (
  ctx: HttpCtx<Record<string, unknown>>,
  next: (ctx: HttpCtx<Record<string, unknown> & AddedVars>) => Promise<Response>,
) => Promise<Response>

/** MountedRouter: a sub-router mounted at a prefix with optional middleware. */
interface MountedRouter {
  prefix: string
  router: Router<Record<string, unknown>>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  middlewares: Array<RouterMiddleware<any>>
}

/** Router<TypedVars>: the central VALUE.
 *  - routes: list of Route definitions
 *  - mounts: list of sub-routers mounted at prefixes
 *  - middlewares: middleware applied to all routes in this router
 */
class Router<TypedVars extends Record<string, unknown> = Record<string, never>> {
  private _routes: Array<Route<TypedVars, RouteSchema>> = []
  private _mounts: MountedRouter[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _middlewares: Array<RouterMiddleware<any>> = []

  /** add: register a Route on this router. */
  add<S extends RouteSchema>(r: Route<TypedVars, S>): this {
    this._routes.push(r as Route<TypedVars, RouteSchema>)
    return this
  }

  /** use: attach middleware to this router (applied to all routes). */
  use<AddedVars extends Record<string, unknown>>(
    mw: RouterMiddleware<AddedVars>,
  ): Router<TypedVars & AddedVars> {
    this._middlewares.push(mw)
    return this as unknown as Router<TypedVars & AddedVars>
  }

  /** mount: attach a sub-router under a prefix, with optional at-mount middleware.
   *  Middleware listed here applies to ALL routes in the sub-router. */
  mount<SubVars extends Record<string, unknown>>(
    prefix: string,
    subRouter: Router<SubVars>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...mountMiddlewares: Array<RouterMiddleware<any>>
  ): this {
    this._mounts.push({
      prefix,
      router: subRouter as unknown as Router<Record<string, unknown>>,
      middlewares: mountMiddlewares,
    })
    return this
  }

  /** Internal: dispatch a request through this router's routes and mounts.
   *  ctx.segments is consumed as dispatch descends into mounts.
   *  Returns a Response or null (Pass = no match). */
  async _dispatch(ctx: HttpCtx<Record<string, unknown>>): Promise<Response | null> {
    // Apply this router's own middleware chain
    return this._runWithMiddlewares(ctx, this._middlewares, (ctx2) =>
      this._dispatchInner(ctx2),
    )
  }

  private async _runWithMiddlewares(
    ctx: HttpCtx<Record<string, unknown>>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mws: Array<RouterMiddleware<any>>,
    final: (ctx: HttpCtx<Record<string, unknown>>) => Promise<Response | null>,
  ): Promise<Response | null> {
    const run = async (
      idx: number,
      ctx2: HttpCtx<Record<string, unknown>>,
    ): Promise<Response | null> => {
      if (idx >= mws.length) return final(ctx2)
      const mw = mws[idx]!
      // mw is responsible for calling next (or not). We capture what it returns.
      // If it returns early (403, etc.) without calling next, we get that Response.
      // If it calls next, the next chain result flows back through mw's return.
      // We wrap `next` so that if the inner chain returns null (no match), we
      // pass notFound() to the middleware — letting it see a Response either way.
      const mwResult = await mw(ctx2, async (nextCtx) => {
        const inner = await run(idx + 1, nextCtx as HttpCtx<Record<string, unknown>>)
        return inner ?? notFound()
      })
      // mwResult is a Response if mw returned early OR forwarded the next result.
      // Map it back to Response | null: a 404 from notFound() stays as Response,
      // but that's fine — the real "no match" null only comes from final() above.
      return mwResult
    }
    return run(0, ctx)
  }

  private async _dispatchInner(
    ctx: HttpCtx<Record<string, unknown>>,
  ): Promise<Response | null> {
    // Try sub-router mounts first
    for (const mount of this._mounts) {
      const prefix = mount.prefix.replace(/^\//, "")
      const [seg, ...rest] = ctx.segments
      if (seg === prefix) {
        const subCtx: HttpCtx<Record<string, unknown>> = { ...ctx, segments: rest }
        // Apply mount-level middleware, then dispatch into sub-router
        const result = await this._runWithMiddlewares(
          subCtx,
          mount.middlewares,
          (ctx2) => mount.router._dispatch(ctx2),
        )
        if (result !== null) return result
      }
    }

    // Try routes
    for (const r of this._routes) {
      if (r.method !== ctx.method && r.method !== "*") continue
      const match = matchPattern(r.pattern, ctx.segments)
      if (match === null) continue

      // Merge captured params
      const reqCtx: HttpCtx<Record<string, unknown>> = {
        ...ctx,
        params: { ...ctx.params, ...match.params },
        segments: match.remaining,
      }

      // Declared validation (opt-in adapter)
      let validatedBody: unknown = undefined
      let validatedQuery: unknown = undefined

      if (r.schema?.body !== undefined) {
        const rawBody = await reqCtx.body()
        const result = r.schema.body["~standard"].validate(rawBody)
        if (result.issues !== undefined) {
          return new Response(
            JSON.stringify({ error: "Bad Request", details: result.issues }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          )
        }
        validatedBody = result.value
      }

      if (r.schema?.query !== undefined) {
        const queryObj: Record<string, unknown> = {}
        reqCtx.query.forEach((v, k) => { queryObj[k] = v })
        const result = r.schema.query["~standard"].validate(queryObj)
        if (result.issues !== undefined) {
          return new Response(
            JSON.stringify({ error: "Bad Request", details: result.issues }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          )
        }
        validatedQuery = result.value
      }

      // Build the validated request visible to the handler
      const vReq = {
        _ctx: reqCtx,
        validatedBody,
        validatedQuery,
      } as ValidatedReq<Record<string, unknown>, RouteSchema>

      return r.handler(vReq as Parameters<typeof r.handler>[0])
    }

    return null // Pass
  }
}

// ---------------------------------------------------------------------------
// matchPattern — parse a route pattern like "/config/:section" vs segments
// ---------------------------------------------------------------------------

interface PatternMatch {
  params: Record<string, string>
  remaining: string[]
}

function matchPattern(pattern: string, segments: string[]): PatternMatch | null {
  const parts = pattern.replace(/^\//, "").split("/").filter(Boolean)
  const params: Record<string, string> = {}
  let segIdx = 0

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    const seg = segments[segIdx]
    if (seg === undefined) return null

    if (part.startsWith(":")) {
      params[part.slice(1)] = seg
      segIdx++
    } else if (part === seg) {
      segIdx++
    } else {
      return null
    }
  }

  return { params, remaining: segments.slice(segIdx) }
}

// ---------------------------------------------------------------------------
// notFound — convenience 404
// ---------------------------------------------------------------------------

function notFound(): Response {
  return new Response(JSON.stringify({ error: "Not Found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  })
}

// ---------------------------------------------------------------------------
// toHandler — compile a Router into a WHATWG (req: Request) => Promise<Response>
// This is the boundary between layer 2 and layer 3.
// ---------------------------------------------------------------------------

function toHandler(router: Router<Record<string, unknown>>): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const segments = url.pathname.replace(/^\//, "").split("/").filter(Boolean)

    // Lazy body thunk: pulled at most once, only when a handler calls body()
    let bodyCache: unknown = undefined
    let bodyCalled = false
    const bodyThunk = async (): Promise<unknown> => {
      if (bodyCalled) return bodyCache
      bodyCalled = true
      const ct = req.headers.get("content-type") ?? ""
      if (ct.includes("application/json")) {
        bodyCache = await req.json()
      } else if (ct.includes("text/")) {
        bodyCache = await req.text()
      } else {
        bodyCache = await req.arrayBuffer()
      }
      return bodyCache
    }

    const ctx: HttpCtx<Record<string, never>> = {
      method: req.method,
      segments,
      params: {},
      query: url.searchParams,
      headers: req.headers,
      body: bodyThunk,
      vars: {},
    }

    const result = await router._dispatch(ctx as HttpCtx<Record<string, unknown>>)
    return result ?? notFound()
  }
}

// ============================================================================
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  LAYER 3 — RUNTIME ADAPTER                                              ║
// ║  ~3 lines. Bun reference isolated here. Not invoked in the spike.       ║
// ╚══════════════════════════════════════════════════════════════════════════╝
// ============================================================================

// serveBun: the ONLY place a Bun symbol appears in this codebase.
// We do NOT invoke it — we prove runtime-neutrality by calling toHandler(...)
// directly with constructed `new Request(...)` below.
//
// function serveBun(h: (req: Request) => Promise<Response>) {
//   return Bun.serve({ fetch: h })
// }

// ============================================================================
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  HELPERS                                                                ║
// ╚══════════════════════════════════════════════════════════════════════════╝
// ============================================================================

// ---------------------------------------------------------------------------
// json / text / stream — convenience Response factories
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function text(data: string, status = 200): Response {
  return new Response(data, { status })
}

// SSE streaming response — handler returns this directly
function sseStream(
  produce: (emit: (event: string, data: unknown) => void) => void | Promise<void>,
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  const emit = (event: string, data: unknown): void => {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    writer.write(encoder.encode(chunk)).catch(() => {})
  }

  Promise.resolve(produce(emit)).then(() => writer.close()).catch(() => writer.close())

  return new Response(readable as unknown as BodyInit, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  })
}

// ---------------------------------------------------------------------------
// crud() — helper that returns a mountable sub-router for a resource
//
// Collapses per-entity duplication: one call per entity instead of 5 routes.
// Routes: GET /       list
//         POST /      create
//         GET /:id    get
//         PATCH /:id  patch
//         DELETE /:id delete
// ---------------------------------------------------------------------------

interface Store<T extends Record<string, unknown>> {
  list(): Promise<T[]>
  get(id: string): Promise<T | null>
  create(data: Partial<T>): Promise<T>
  patch(id: string, data: Partial<T>): Promise<T | null>
  delete(id: string): Promise<boolean>
}

function crud<T extends Record<string, unknown>>(
  _name: string,
  opts: { schema: StandardSchema<unknown, T>; store: Store<T> },
): Router<Record<string, never>> {
  const r = new Router<Record<string, never>>()

  r.add(route({
    method: "GET",
    pattern: "/",
    handler: async () => json(await opts.store.list()),
  }))

  r.add(route({
    method: "POST",
    pattern: "/",
    schema: { body: opts.schema },
    handler: async (req) => {
      const created = await opts.store.create(req.validatedBody as Partial<T>)
      return json(created, 201)
    },
  }))

  r.add(route({
    method: "GET",
    pattern: "/:id",
    handler: async (req) => {
      const item = await opts.store.get(req._ctx.params["id"]!)
      return item !== null ? json(item) : notFound()
    },
  }))

  r.add(route({
    method: "PATCH",
    pattern: "/:id",
    schema: { body: opts.schema },
    handler: async (req) => {
      const item = await opts.store.patch(req._ctx.params["id"]!, req.validatedBody as Partial<T>)
      return item !== null ? json(item) : notFound()
    },
  }))

  r.add(route({
    method: "DELETE",
    pattern: "/:id",
    handler: async (req) => {
      const ok = await opts.store.delete(req._ctx.params["id"]!)
      return ok ? json({ deleted: true }) : notFound()
    },
  }))

  return r
}

// ============================================================================
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  SAMPLE CLUSTER COLLAPSES                                               ║
// ╚══════════════════════════════════════════════════════════════════════════╝
// ============================================================================

// ---------------------------------------------------------------------------
// 1. Config GET/PATCH pairs — 24 hand-written → 2 generic routes + registry
// ---------------------------------------------------------------------------

// Section registry — data, not 24 handlers
interface ConfigSection<T extends Record<string, unknown>> {
  schema: StandardSchema<unknown, T>
  // In-memory store for spike (sample would use DB)
  _data: T
}

type SectionRegistry = {
  [section: string]: ConfigSection<Record<string, unknown>>
}

const configRegistry: SectionRegistry = {
  branding: {
    schema: schema({ logoUrl: "string", primaryColor: "string" }),
    _data: { logoUrl: "https://example.com/logo.png", primaryColor: "#4f46e5" },
  },
  email: {
    schema: schema({ fromAddress: "string", replyTo: "string" }),
    _data: { fromAddress: "hello@example.com", replyTo: "noreply@example.com" },
  },
  billing: {
    schema: schema({ currency: "string", trialDays: "number" }),
    _data: { currency: "USD", trialDays: 14 },
  },
}

// 2 generic routes covering all 24 config pairs:
const configRouter = new Router<Record<string, never>>()

configRouter.add(route({
  method: "GET",
  pattern: "/:section",
  handler: async (req) => {
    const section = req._ctx.params["section"]!
    const entry = configRegistry[section]
    if (entry === undefined) return notFound()
    return json(entry._data)
  },
}))

configRouter.add(route({
  method: "PATCH",
  pattern: "/:section",
  handler: async (req) => {
    const section = req._ctx.params["section"]!
    const entry = configRegistry[section]
    if (entry === undefined) return notFound()
    // Validate against section-specific schema — declared per-section, not per-route
    const rawBody = await req._ctx.body()
    const result = entry.schema["~standard"].validate(rawBody)
    if (result.issues !== undefined) {
      return json({ error: "Bad Request", details: result.issues }, 400)
    }
    entry._data = { ...entry._data, ...result.value }
    return json(entry._data)
  },
}))

// ---------------------------------------------------------------------------
// 2. POST /integrations/:name/test — 19 near-identical → 1 route + dispatch
// ---------------------------------------------------------------------------

type TestFn = (config: Record<string, unknown>) => Promise<{ ok: boolean; message: string }>

const integrationTesters: Record<string, TestFn> = {
  stripe: async (cfg) => ({
    ok: typeof cfg["apiKey"] === "string" && cfg["apiKey"].length > 0,
    message: "Stripe connectivity verified",
  }),
  sendgrid: async (cfg) => ({
    ok: typeof cfg["apiKey"] === "string",
    message: "SendGrid API key present",
  }),
  slack: async (cfg) => ({
    ok: typeof cfg["webhookUrl"] === "string",
    message: "Slack webhook reachable",
  }),
  // ... 16 more would follow the same pattern
}

const integrationsRouter = new Router<Record<string, never>>()

integrationsRouter.add(route({
  method: "POST",
  pattern: "/:name/test",
  handler: async (req) => {
    const name = req._ctx.params["name"]!
    const tester = integrationTesters[name]
    if (tester === undefined) return json({ error: `Unknown integration: ${name}` }, 404)
    const body = await req._ctx.body()
    const result = await tester(body as Record<string, unknown>)
    return json(result)
  },
}))

// ---------------------------------------------------------------------------
// 3. CRUD blocks — per-entity duplication collapses to one call per entity
// ---------------------------------------------------------------------------

// In-memory stores for spike
let userIdSeq = 1
const usersData: Array<{ id: string; name: string; email: string }> = []

const usersStore: Store<{ id: string; name: string; email: string }> = {
  list: async () => usersData,
  get: async (id) => usersData.find((u) => u.id === id) ?? null,
  create: async (data) => {
    const user = { id: String(userIdSeq++), name: data["name"] ?? "", email: data["email"] ?? "" }
    usersData.push(user)
    return user
  },
  patch: async (id, data) => {
    const idx = usersData.findIndex((u) => u.id === id)
    if (idx === -1) return null
    usersData[idx] = { ...usersData[idx]!, ...data }
    return usersData[idx]!
  },
  delete: async (id) => {
    const idx = usersData.findIndex((u) => u.id === id)
    if (idx === -1) return false
    usersData.splice(idx, 1)
    return true
  },
}

let orgIdSeq = 1
const orgsData: Array<{ id: string; name: string; plan: string }> = []

const orgsStore: Store<{ id: string; name: string; plan: string }> = {
  list: async () => orgsData,
  get: async (id) => orgsData.find((o) => o.id === id) ?? null,
  create: async (data) => {
    const org = { id: String(orgIdSeq++), name: data["name"] ?? "", plan: data["plan"] ?? "free" }
    orgsData.push(org)
    return org
  },
  patch: async (id, data) => {
    const idx = orgsData.findIndex((o) => o.id === id)
    if (idx === -1) return null
    orgsData[idx] = { ...orgsData[idx]!, ...data }
    return orgsData[idx]!
  },
  delete: async (id) => {
    const idx = orgsData.findIndex((o) => o.id === id)
    if (idx === -1) return false
    orgsData.splice(idx, 1)
    return true
  },
}

// Two entities, two calls — that's it
const usersRouter = crud("users", {
  schema: schema({ name: "string", email: "string" }),
  store: usersStore as Store<Record<string, unknown>>,
})

const orgsRouter = crud("orgs", {
  schema: schema({ name: "string", plan: "string" }),
  store: orgsStore as Store<Record<string, unknown>>,
})

// ---------------------------------------------------------------------------
// Auth middleware — declared ONCE at the /admin mount
// ---------------------------------------------------------------------------

// Typed context variables set by middleware
interface AuthVars extends Record<string, unknown> {
  user: { id: string; email: string }
  scopes: string[]
}

/** authMiddleware: sets user + scopes in ctx.vars.
 *  In a real app this would verify a JWT; in the spike it reads an x-user header.
 *  If the header is missing → 403 (not 401, sample pattern). */
const authMiddleware: RouterMiddleware<AuthVars> = async (ctx, next) => {
  const xUser = ctx.headers.get("x-user")
  if (xUser === null) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })
  }
  const authedCtx: HttpCtx<Record<string, unknown> & AuthVars> = {
    ...ctx,
    vars: {
      ...ctx.vars,
      user: { id: "u-1", email: xUser },
      scopes: ["admin"],
    },
  }
  return next(authedCtx)
}

// ---------------------------------------------------------------------------
// /admin router — auth middleware declared ONCE at the mount
// ---------------------------------------------------------------------------

const adminRouter = new Router<Record<string, never>>()

// A simple /admin/me endpoint that reads typed ctx.vars.user
adminRouter.add(route({
  method: "GET",
  pattern: "/me",
  handler: async (req) => {
    // Accessing vars — these are typed as `Record<string, unknown>` on the
    // plain Router<Record<string,never>>. See AWKWARD section in commit message.
    const vars = req._ctx.vars as { user?: { id: string; email: string }; scopes?: string[] }
    return json({ user: vars.user, scopes: vars.scopes })
  },
}))

// Mount sub-routers under /admin
adminRouter.mount("/users", usersRouter as unknown as Router<Record<string, unknown>>)
adminRouter.mount("/orgs", orgsRouter as unknown as Router<Record<string, unknown>>)

// SSE endpoint — streaming, no special support needed; a Response IS a stream
adminRouter.add(route({
  method: "GET",
  pattern: "/events",
  handler: async (_req) => {
    return sseStream((emit) => {
      emit("connected", { ts: Date.now() })
      emit("status", { active: true, message: "All systems operational" })
      emit("done", { ts: Date.now() })
    })
  },
}))

// ---------------------------------------------------------------------------
// Top-level app — root router, mounts admin WITH auth middleware at the mount
// ---------------------------------------------------------------------------

const app = new Router<Record<string, never>>()

// Raw query param demo — no capture combinator, direct access
app.add(route({
  method: "GET",
  pattern: "/search",
  handler: async (req) => {
    const q = req._ctx.query.get("q")    // raw, possibly-undefined
    const limit = req._ctx.query.get("limit")  // raw
    return json({ q, limit, raw: true })
  },
}))

// Mount config under /config (no auth for this example)
app.mount("/config", configRouter as unknown as Router<Record<string, unknown>>)

// Mount integrations under /integrations (no auth)
app.mount("/integrations", integrationsRouter as unknown as Router<Record<string, unknown>>)

// Mount admin WITH auth middleware at the mount point — declared ONCE
app.mount("/admin", adminRouter as unknown as Router<Record<string, unknown>>, authMiddleware)

// ============================================================================
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  ACCEPTANCE TEST HARNESS                                               ║
// ║  Calls (Request)=>Promise<Response> in-process — NO socket, NO Bun.   ║
// ╚══════════════════════════════════════════════════════════════════════════╝
// ============================================================================

const handle = toHandler(app as unknown as Router<Record<string, unknown>>)

async function hit(
  method: string,
  url: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  const init: RequestInit = { method }
  if (opts.headers !== undefined || opts.body !== undefined) {
    const headers: Record<string, string> = opts.headers ?? {}
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json"
      init.body = JSON.stringify(opts.body)
    }
    init.headers = headers
  }
  const res = await handle(new Request(url, init))
  const body = await res.text()
  return { status: res.status, body }
}

function section(title: string): void {
  console.log(`\n${"─".repeat(60)}`)
  console.log(`  ${title}`)
  console.log("─".repeat(60))
}

function report(label: string, result: { status: number; body: string }): void {
  console.log(`${label}: [${result.status}] ${result.body}`)
}

// Run all acceptance tests
const BASE = "http://localhost"

section("1. CRUD: list users (empty)")
report("  GET /admin/users/", await hit("GET", `${BASE}/admin/users/`, { headers: { "x-user": "alice@example.com" } }))

section("2. CRUD: create user")
report("  POST /admin/users/", await hit("POST", `${BASE}/admin/users/`, {
  headers: { "x-user": "alice@example.com" },
  body: { name: "Alice", email: "alice@example.com" },
}))

section("3. CRUD: list users (now has Alice)")
report("  GET /admin/users/", await hit("GET", `${BASE}/admin/users/`, { headers: { "x-user": "alice@example.com" } }))

section("4. CRUD: create org")
report("  POST /admin/orgs/", await hit("POST", `${BASE}/admin/orgs/`, {
  headers: { "x-user": "alice@example.com" },
  body: { name: "Acme Corp", plan: "pro" },
}))

section("5. Config PATCH — valid body → 200")
report("  PATCH /config/branding", await hit("PATCH", `${BASE}/config/branding`, {
  body: { logoUrl: "https://cdn.example.com/logo-v2.png", primaryColor: "#7c3aed" },
}))

section("6. Config PATCH — invalid body → 400")
report("  PATCH /config/branding (bad)", await hit("PATCH", `${BASE}/config/branding`, {
  body: { logoUrl: 12345, primaryColor: "#7c3aed" },  // logoUrl wrong type
}))

section("7. Config GET — reads updated data")
report("  GET /config/branding", await hit("GET", `${BASE}/config/branding`))

section("8. Integrations :name/test")
report("  POST /integrations/stripe/test", await hit("POST", `${BASE}/integrations/stripe/test`, {
  body: { apiKey: "sk_test_abc123" },
}))
report("  POST /integrations/slack/test", await hit("POST", `${BASE}/integrations/slack/test`, {
  body: { webhookUrl: "https://hooks.slack.com/abc" },
}))
report("  POST /integrations/unknown/test", await hit("POST", `${BASE}/integrations/unknown/test`, {
  body: {},
}))

section("9. SSE endpoint — read event-stream chunks")
const sseRes = await handle(new Request(`${BASE}/admin/events`, {
  headers: { "x-user": "alice@example.com" },
}))
console.log(`  Content-Type: ${sseRes.headers.get("content-type")}`)
const sseText = await sseRes.text()
console.log(`  Events received:\n${sseText.split("\n\n").filter(Boolean).map((e) => `    ${e.replace(/\n/g, " | ")}`).join("\n")}`)

section("10. /admin/me WITH auth → 200")
report("  GET /admin/me", await hit("GET", `${BASE}/admin/me`, { headers: { "x-user": "alice@example.com" } }))

section("11. /admin/me WITHOUT auth → 403")
report("  GET /admin/me (no header)", await hit("GET", `${BASE}/admin/me`))

section("12. Raw query params — no capture combinator")
report("  GET /search?q=fractal&limit=10", await hit("GET", `${BASE}/search?q=fractal&limit=10`))

section("13. Binary/blob — prove it's just a Response body (free)")
// Binary is free: a handler returns a Response directly, body can be any BodyInit.
// We route it via a dedicated router to confirm the full stack carries it.
const blobRouter = new Router<Record<string, never>>()
blobRouter.add(route({
  method: "GET",
  pattern: "/blob",
  handler: async () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // PNG magic bytes
    return new Response(data, { headers: { "Content-Type": "image/png" } })
  },
}))
const blobHandle = toHandler(blobRouter as unknown as Router<Record<string, unknown>>)
const blobRes = await blobHandle(new Request(`${BASE}/blob`))
const blobBuf = await blobRes.arrayBuffer()
console.log(`  GET /blob: [${blobRes.status}] ${blobRes.headers.get("content-type")} len=${blobBuf.byteLength} bytes`)

section("DONE")
console.log("")
