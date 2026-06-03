// spike/linchpins.ts
//
// LINCHPIN PROOFS — typed-context-through-mount (zero casts) +
//                   withValidation validator≡Args (inferred, checked)
//
// Run: bun spike/linchpins.ts
// Typecheck: node_modules/.bin/tsgo --noEmit --project spike/tsconfig.json

export {} // module scope

// ============================================================================
// SHARED PRIMITIVES
// ============================================================================

/** Typed HTTP context threaded through the middleware chain. */
interface HttpCtx<Vars extends Record<string, unknown> = Record<string, never>> {
  readonly method: string
  readonly segments: string[]
  readonly params: Record<string, string>
  readonly query: URLSearchParams
  readonly headers: Headers
  readonly body: () => Promise<unknown>
  readonly vars: Vars
}

// ============================================================================
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  LINCHPIN 1 — Typed context through mount, ZERO casts                  ║
// ╚══════════════════════════════════════════════════════════════════════════╝
// ============================================================================
//
// APPROACH: avoid class with private fields (which forces invariance).
// Use a plain interface + factory function.  The Router<Vars> is covariant in
// its dispatch slot because the slot is only consumed, never produced as Vars.
//
// Router<Vars> stores:
//   - a list of route entries (method+pattern+handler that accepts HttpCtx<Vars>)
//   - a list of mounts: each mount wraps the sub-router with a ContextRefiner
//     that narrows Vars to a wider superset
//
// Mount with middleware works as follows:
//   mount<Extra>(prefix, mw, subRouter: Router<Vars & Extra>)
//     => this returns Router<Vars> (parent is still just Vars)
//     The middleware adds Extra to the context, then dispatches into subRouter.
//     The sub-router's handler receives HttpCtx<Vars & Extra> — checked statically.
//
// Key: subRouter is typed as Router<Vars & Extra>, so the handler inside it sees
// the enriched Vars.  No cast needed at the mount call-site because Router is
// structurally typed (interface + function, no private fields).

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

type Handler<Vars extends Record<string, unknown>> =
  (ctx: HttpCtx<Vars>) => Promise<Response>

type Middleware<Vars extends Record<string, unknown>, Extra extends Record<string, unknown>> =
  (ctx: HttpCtx<Vars>, next: (ctx: HttpCtx<Vars & Extra>) => Promise<Response>) => Promise<Response>

// A route entry is fully erased to its base Vars after registration.
interface RouteEntry<Vars extends Record<string, unknown>> {
  method: string
  pattern: RegExp
  paramNames: string[]
  handler: Handler<Vars>
}

// A mount entry: prefix + a handler that already knows how to run the sub-tree
// with whatever extra context it needs.
interface MountEntry<Vars extends Record<string, unknown>> {
  prefix: string
  dispatch: (ctx: HttpCtx<Vars>) => Promise<Response | null>
}

// The Router value — interface, no private fields, structurally typed.
// Vars is the context this router's handlers require.
interface Router<Vars extends Record<string, unknown>> {
  readonly _routes: ReadonlyArray<RouteEntry<Vars>>
  readonly _mounts: ReadonlyArray<MountEntry<Vars>>
}

// ---------------------------------------------------------------------------
// Builder — a separate functional type so we can return Router<Vars & Extra>
// from use() without a cast at the call site.
// ---------------------------------------------------------------------------

interface Builder<Vars extends Record<string, unknown>> {
  /** Register a handler for method+pattern. */
  route(method: string, pattern: string, handler: Handler<Vars>): Builder<Vars>

  /**
   * Mount a sub-router under a prefix, threading Extra context via middleware.
   *
   * The sub-router's handlers see HttpCtx<Vars & Extra> statically.
   * No cast at the call site — the mount signature enforces it.
   */
  mount<Extra extends Record<string, unknown>>(
    prefix: string,
    mw: Middleware<Vars, Extra>,
    subRouter: Router<Vars & Extra>,
  ): Builder<Vars>

  /**
   * Mount a sub-router without extra context (no middleware needed).
   * This is a simpler overload for unauthenticated mounts.
   */
  mountPlain(prefix: string, subRouter: Router<Vars>): Builder<Vars>

  /** Build the immutable Router value. */
  build(): Router<Vars>
}

// ---------------------------------------------------------------------------
// parsePattern — convert "/admin/:id" → { re, paramNames }
// ---------------------------------------------------------------------------

function parsePattern(pattern: string): { re: RegExp; paramNames: string[] } {
  const paramNames: string[] = []
  const reStr = pattern.replace(/:([^/]+)/g, (_m, name: string) => {
    paramNames.push(name)
    return "([^/]+)"
  })
  return { re: new RegExp(`^${reStr}$`), paramNames }
}

// ---------------------------------------------------------------------------
// createBuilder — factory; no class, no private fields.
// ---------------------------------------------------------------------------

function createBuilder<Vars extends Record<string, unknown>>(): Builder<Vars> {
  const routes: Array<RouteEntry<Vars>> = []
  const mounts: Array<MountEntry<Vars>> = []

  const builder: Builder<Vars> = {
    route(method, pattern, handler) {
      const { re, paramNames } = parsePattern(pattern)
      routes.push({ method: method.toUpperCase(), pattern: re, paramNames, handler })
      return builder
    },

    mount<Extra extends Record<string, unknown>>(
      prefix: string,
      mw: Middleware<Vars, Extra>,
      subRouter: Router<Vars & Extra>,
    ) {
      const stripped = prefix.replace(/^\//, "").replace(/\/$/, "")

      const dispatch = async (ctx: HttpCtx<Vars>): Promise<Response | null> => {
        // Check prefix match
        const [head, ...tail] = ctx.segments
        if (head !== stripped) return null

        const subCtx: HttpCtx<Vars> = { ...ctx, segments: tail }

        // Apply middleware: it enriches the ctx and dispatches into subRouter
        return mw(subCtx, async (enrichedCtx) => {
          const result = await dispatchRouter(subRouter, enrichedCtx)
          return result ?? new Response("Not Found", { status: 404 })
        })
      }

      mounts.push({ prefix: stripped, dispatch })
      return builder
    },

    mountPlain(prefix: string, subRouter: Router<Vars>) {
      const stripped = prefix.replace(/^\//, "").replace(/\/$/, "")

      const dispatch = async (ctx: HttpCtx<Vars>): Promise<Response | null> => {
        const [head, ...tail] = ctx.segments
        if (head !== stripped) return null
        const subCtx: HttpCtx<Vars> = { ...ctx, segments: tail }
        return dispatchRouter(subRouter, subCtx)
      }

      mounts.push({ prefix: stripped, dispatch })
      return builder
    },

    build() {
      return { _routes: routes, _mounts: mounts }
    },
  }

  return builder
}

// ---------------------------------------------------------------------------
// dispatchRouter — walks routes then mounts
// ---------------------------------------------------------------------------

async function dispatchRouter<Vars extends Record<string, unknown>>(
  router: Router<Vars>,
  ctx: HttpCtx<Vars>,
): Promise<Response | null> {
  // Try routes first
  const segment = "/" + ctx.segments.join("/")
  for (const entry of router._routes) {
    if (entry.method !== ctx.method) continue
    const m = entry.pattern.exec(segment)
    if (m === null) continue
    const params: Record<string, string> = {}
    entry.paramNames.forEach((name, i) => { params[name] = m[i + 1] ?? "" })
    const routeCtx: HttpCtx<Vars> = { ...ctx, params }
    return entry.handler(routeCtx)
  }
  // Try mounts
  for (const mount of router._mounts) {
    const result = await mount.dispatch(ctx)
    if (result !== null) return result
  }
  return null
}

// ---------------------------------------------------------------------------
// NoVars — the base "no specific vars required" type.
// Using {} (empty object) rather than Record<string,never> avoids the
// contradiction: Record<string,never> & AuthVars requires every key to be
// never, which breaks the intersection.  {} means "no required vars" and
// intersects cleanly with any Record<string,unknown> extension.
// ---------------------------------------------------------------------------

type NoVars = Record<never, never> // equivalent to {} but self-documenting

// ---------------------------------------------------------------------------
// toHandler — Router<NoVars> → (Request) => Promise<Response>
// The root router needs no vars in context (middleware adds them at mount time).
// ---------------------------------------------------------------------------

function toHandler(
  router: Router<NoVars>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const url = new URL(req.url)
    const segments = url.pathname.replace(/^\//, "").split("/").filter(Boolean)
    const ctx: HttpCtx<NoVars> = {
      method: req.method.toUpperCase(),
      segments,
      params: {},
      query: url.searchParams,
      headers: req.headers,
      body: () => req.json().catch(() => null),
      vars: {},
    }
    const result = await dispatchRouter(router, ctx)
    return result ?? new Response("Not Found", { status: 404 })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

// ============================================================================
// PROOF — Linchpin 1
// ============================================================================

// AuthVars — what the auth middleware adds
interface AuthVars extends Record<string, unknown> {
  user: { id: string; email: string }
  scopes: string[]
}

// Auth middleware — takes ctx with no extra vars, calls next with AuthVars added
const authMiddleware: Middleware<NoVars, AuthVars> = async (ctx, next) => {
  const xUser = ctx.headers.get("x-user")
  if (xUser === null) {
    return json({ error: "Forbidden" }, 403)
  }
  const enriched: HttpCtx<NoVars & AuthVars> = {
    ...ctx,
    vars: {
      user: { id: "u-1", email: xUser },
      scopes: ["admin"],
    },
  }
  return next(enriched)
}

// The admin sub-router — requires AuthVars in context.
// AuthVars extends Record<string, unknown> so it is also NoVars & AuthVars.
// Handlers can read ctx.vars.user, ctx.vars.scopes — no cast.
const adminRouter: Router<NoVars & AuthVars> = createBuilder<NoVars & AuthVars>()
  .route("GET", "/me", async (ctx) => {
    // ZERO casts — ctx.vars is typed as AuthVars
    const user = ctx.vars.user   // type: { id: string; email: string }
    const scopes = ctx.vars.scopes  // type: string[]
    return json({ user, scopes })
  })
  .route("GET", "/profile/:id", async (ctx) => {
    // ctx.vars.user.id — no cast, statically typed
    return json({ requestedId: ctx.params["id"], requestedBy: ctx.vars.user.id })
  })
  .build()

// TYPE PROBE — ctx.vars in the admin router's handlers is NoVars & AuthVars
type AdminHandlerCtx = HttpCtx<NoVars & AuthVars>
type _AdminVarsProbe = AdminHandlerCtx["vars"]
// Expected: { user: { id: string; email: string }; scopes: string[] }

// NEGATIVE PROBE — a handler on a NON-authed router must NOT see ctx.vars.user
const publicRouter: Router<NoVars> = createBuilder<NoVars>()
  .route("GET", "/ping", async (ctx) => {
    // @ts-expect-error — 'user' does not exist on type 'Record<string, never>'
    const _bad: { id: string } = ctx.vars.user
    return json({ pong: true })
  })
  .build()

// Root app — mounts admin with auth middleware (no cast needed)
const app: Router<NoVars> = createBuilder<NoVars>()
  .mountPlain("/pub", publicRouter)
  // mount<AuthVars>(prefix, mw, subRouter: Router<Record<string,never> & AuthVars>)
  // subRouter type = Router<AuthVars> — matches, no cast
  .mount("/admin", authMiddleware, adminRouter)
  .build()

// ============================================================================
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  LINCHPIN 2 — withValidation(fn, validator): validator≡Args, inferred  ║
// ╚══════════════════════════════════════════════════════════════════════════╝
// ============================================================================

// ---------------------------------------------------------------------------
// Minimal StandardSchemaV1 fixture — NO real valibot dep
// ---------------------------------------------------------------------------

interface StandardSchema<_In, Out> {
  readonly "~standard": {
    readonly version: 1
    validate(
      value: unknown,
    ):
      | { readonly value: Out; readonly issues?: undefined }
      | { readonly issues: ReadonlyArray<{ readonly message: string }>; readonly value?: undefined }
  }
}

// InferOutput — extracts Out from a StandardSchema
type InferOutput<S> = S extends StandardSchema<unknown, infer Out> ? Out : never

// ---------------------------------------------------------------------------
// withValidation
//
// fn: (args: Args) => Promise<Result>
// validator: StandardSchema<unknown, Args>    ← Args inferred from fn, checked
//
// Returns a node with:
//   handler: (req: Request) => Promise<Response>  (validate → fn → render)
//   meta.validator: the validator (exposed for OpenAPI etc.)
//
// InferOutput<V> extends Args ensures the validator output is assignable to fn's
// input without any manual annotation.
// ---------------------------------------------------------------------------

interface ValidatedNode<Args, Result> {
  handler: (req: Request) => Promise<Response>
  meta: {
    validator: StandardSchema<unknown, Args>
    fn: (args: Args) => Promise<Result>
  }
}

function withValidation<Args, Result, V extends StandardSchema<unknown, Args>>(
  fn: (args: Args) => Promise<Result>,
  validator: V & (InferOutput<V> extends Args ? unknown : never),
): ValidatedNode<Args, Result> {
  return {
    handler: async (req: Request) => {
      let body: unknown
      try {
        body = await req.json()
      } catch {
        return json({ error: "Invalid JSON" }, 400)
      }
      const result = validator["~standard"].validate(body)
      if (result.issues !== undefined) {
        return json({ error: "Validation failed", issues: result.issues }, 400)
      }
      const output = await fn(result.value)
      return json(output)
    },
    meta: {
      validator,
      fn,
    },
  }
}

// ---------------------------------------------------------------------------
// Tiny schema builder fixture
// ---------------------------------------------------------------------------

type FieldMap = Record<string, "string" | "number">
type SchemaOutput<F extends FieldMap> = {
  [K in keyof F]: F[K] extends "string" ? string : number
}

function makeSchema<F extends FieldMap>(fields: F): StandardSchema<unknown, SchemaOutput<F>> {
  return {
    "~standard": {
      version: 1,
      validate(value: unknown) {
        if (typeof value !== "object" || value === null) {
          return { issues: [{ message: "Expected an object" }] }
        }
        const obj = value as Record<string, unknown>
        const out: Record<string, unknown> = {}
        for (const [k, t] of Object.entries(fields)) {
          if (typeof obj[k] !== t) {
            return { issues: [{ message: `Field "${k}" must be a ${t}` }] }
          }
          out[k] = obj[k]
        }
        return { value: out as SchemaOutput<F> }
      },
    },
  }
}

// ---------------------------------------------------------------------------
// POSITIVE CASES
// ---------------------------------------------------------------------------

// Case A: fn wants { name: string; email: string }; validator produces exactly that
type UserArgs = { name: string; email: string }

async function createUser(args: UserArgs): Promise<{ id: string; name: string }> {
  return { id: "u-1", name: args.name }
}

const userValidator = makeSchema({ name: "string", email: "string" })
const createUserNode = withValidation(createUser, userValidator)
// handler: (req: Request) => Promise<Response>  ✓
// meta.validator is the validator ✓

// TYPE PROBE — Args is inferred from fn, not manually annotated
type _CreateUserArgs = Parameters<typeof createUser>[0]
// Expected: { name: string; email: string }

// Case B: coercion — fn wants { limit: number }; validator input is unknown but output is { limit: number }
// (coercion lives inside the validator; only output type is checked)
type PaginateArgs = { limit: number }

async function paginateItems(args: PaginateArgs): Promise<{ items: string[]; limit: number }> {
  return { items: Array(args.limit).fill("item"), limit: args.limit }
}

// A validator that coerces: parses numeric strings in the validate fn,
// but its output type is { limit: number }
const coercingLimitValidator: StandardSchema<unknown, { limit: number }> = {
  "~standard": {
    version: 1,
    validate(value: unknown) {
      if (typeof value !== "object" || value === null) {
        return { issues: [{ message: "Expected an object" }] }
      }
      const obj = value as Record<string, unknown>
      const raw = obj["limit"]
      const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN
      if (isNaN(num)) return { issues: [{ message: "limit must be numeric" }] }
      return { value: { limit: num } }
    },
  },
}

const paginateNode = withValidation(paginateItems, coercingLimitValidator)
// Coercion case: validator input is unknown, output is { limit: number } ≡ PaginateArgs ✓

// ---------------------------------------------------------------------------
// NEGATIVE CASES — @ts-expect-error must be consumed (if unused: tsgo error)
// ---------------------------------------------------------------------------

// NEGATIVE A: validator output missing `email` — must be a compile error
async function needsNameAndEmail(args: { name: string; email: string }): Promise<void> {}
const missingEmailValidator = makeSchema({ name: "string" })
// missingEmailValidator output is { name: string }, but fn needs { name: string; email: string }
// @ts-expect-error — validator output { name: string } is not assignable to { name: string; email: string }
const _badNodeA = withValidation(needsNameAndEmail, missingEmailValidator)

// NEGATIVE B: validator output has wrong field type — must be a compile error
async function needsStringName(args: { name: string; email: string }): Promise<void> {}
const wrongTypeValidator = makeSchema({ name: "number", email: "string" })
// wrongTypeValidator output has name: number, but fn needs name: string
// @ts-expect-error — validator output { name: number; email: string } not assignable to { name: string; email: string }
const _badNodeB = withValidation(needsStringName, wrongTypeValidator)

// ============================================================================
// RUNTIME SANITY CHECKS
// ============================================================================

const appHandler = toHandler(app)

async function hit(
  method: string,
  url: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  const init: RequestInit = { method }
  const headers: Record<string, string> = opts.headers ?? {}
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json"
    init.body = JSON.stringify(opts.body)
  }
  init.headers = headers
  const res = await appHandler(new Request(url, init))
  return { status: res.status, body: await res.text() }
}

const BASE = "http://localhost"

console.log("=== LINCHPIN 1: Typed context through mount ===\n")

// 1a. Auth middleware sets user; handler reads ctx.vars.user — no cast
const me1 = await hit("GET", `${BASE}/admin/me`, { headers: { "x-user": "alice@example.com" } })
console.log(`GET /admin/me (with x-user): [${me1.status}] ${me1.body}`)

// 1b. No auth header → 403
const me2 = await hit("GET", `${BASE}/admin/me`)
console.log(`GET /admin/me (no header):   [${me2.status}] ${me2.body}`)

// 1c. Handler reads ctx.vars.user.id for path param route
const profile = await hit("GET", `${BASE}/admin/profile/u-99`, { headers: { "x-user": "alice@example.com" } })
console.log(`GET /admin/profile/u-99:     [${profile.status}] ${profile.body}`)

// 1d. Public route — no vars required
const ping = await hit("GET", `${BASE}/pub/ping`)
console.log(`GET /pub/ping:               [${ping.status}] ${ping.body}`)

console.log("\n=== LINCHPIN 2: withValidation validator≡Args ===\n")

// 2a. Valid body → handler called, returns result
const validReq = new Request(`${BASE}/create-user`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Alice", email: "alice@example.com" }),
})
const validRes = await createUserNode.handler(validReq)
console.log(`withValidation(createUser) — valid body:   [${validRes.status}] ${await validRes.text()}`)

// 2b. Invalid body → 400
const invalidReq = new Request(`${BASE}/create-user`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Alice" }),  // missing email
})
const invalidRes = await createUserNode.handler(invalidReq)
console.log(`withValidation(createUser) — missing email:[${invalidRes.status}] ${await invalidRes.text()}`)

// 2c. Coercion case — string "5" coerced to number 5
const coerceReq = new Request(`${BASE}/paginate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ limit: "5" }),  // string input, coerced to number
})
const coerceRes = await paginateNode.handler(coerceReq)
console.log(`withValidation(paginateItems) — coerce "5":[${coerceRes.status}] ${await coerceRes.text()}`)

// 2d. meta.validator exposed
console.log(`meta.validator exposed:     ${typeof createUserNode.meta.validator["~standard"].validate === "function" ? "yes" : "no"}`)

console.log("\n=== TYPE PROBES (compile-time only, shown as comments) ===")
console.log("_AdminVarsProbe = HttpCtx<AuthVars>[\"vars\"]")
console.log("  => { user: { id: string; email: string }; scopes: string[] }")
console.log("_CreateUserArgs = Parameters<typeof createUser>[0]")
console.log("  => { name: string; email: string }")
console.log("\nAll @ts-expect-error directives must be consumed (no unused-directive errors).")
console.log("\nDONE")
