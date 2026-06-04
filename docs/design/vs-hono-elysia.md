# fractal vs Hono vs Elysia — a grounded head-to-head

Brutally honest, evidence-first comparison on six criteria. Where fractal loses or
ties, it says so. The fractal code below is **verified**: `tsgo --noEmit` passes and
`bun test` runs it in-process (`examples/todo-api/src/vs.ts` + `vs.test.ts`,
9/9 pass). Hono/Elysia snippets are reference snippets, idiomatic per current
(2026) docs — not run, but API-accurate (sources at the end).

Frameworks compared:
- **Hono 4.x** — `zValidator`, `c.req.valid()`, `c.set/c.get` + `Variables`, `hc<App>()`.
- **Elysia (current)** — `t.Object`, `.derive`/`.resolve`/`.decorate`, Eden `treaty<App>()`.
- **fractal** — `httpRouter()`, `.use`/`.mount`, `withValidation`, `respond`/`Outcome`.

---

## The three endpoints

(a) `GET /users/:id` → a user or 404, behind auth that puts a typed `user` in context.
(b) `POST /users` with body `{name,email}`, returns 201.
(c) `POST /users/:id/deactivate` returning a domain `Result<User,{code}>` → 200/404/409.

### fractal (verified — typechecks + runs)

```ts
const app = httpRouter<NoVars>()
  .use(cors())                                   // stdlib mw — a plain Middleware value
  // bearerAuth threads a typed principal into ctx.vars.auth (read with NO cast)
  .use(bearerAuth({ verify: (t) => (t ? { id: "caller", email: t } : null) }))
  // (a) verb sugar + TYPED params: ctx.params.id is `string` (no `?? ""`)
  .get("/users/:id", async (ctx) => {
    const _caller = ctx.vars.auth.email          // typed; cast-free
    const user = users.get(ctx.params.id)        // ctx.params.id: string
    return user === undefined ? json({ error: "USER_NOT_FOUND" }, 404) : json(user)
  })
  // (b) validated body → 201 via created() (status-aware withValidation)
  .routeNode("POST", "/users",
    withValidation(
      async (args: { name: string; email: string }) => created(await createUser(args)),
      object({ name: "string", email: "string" }),
    ),
  )
  // (c) handler returns a domain Outcome; respond() maps it via the USER policy
  .post("/users/:id/deactivate",
    respond((ctx) => deactivate({ id: ctx.params.id }), userErrorPolicy),
  )

// Method mismatch now returns 405 + Allow (not 404); HEAD is synthesized from
// GET. A one-line hello-world: httpRouter().get("/", async () => text("hi")).

// user-side error→status table — the framework hardcodes none of it
const userErrorPolicy: ErrorPolicy<UserError> = (e) => {
  switch (e.code) {
    case "USER_NOT_FOUND":   return { status: 404, body: { error: e.code, id: e.id } }
    case "ALREADY_INACTIVE": return { status: 409, body: { error: e.code, id: e.id } }
  }
}
```

### Hono 4.x (reference)

```ts
import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"

type Variables = { user: { id: string; email: string } }
const app = new Hono<{ Variables: Variables }>()

const auth = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const email = c.req.header("x-user")
  if (!email) return c.json({ error: "Unauthorized" }, 401)
  c.set("user", { id: "caller", email })   // string-keyed; mismatch is silent
  await next()
})

const routes = app
  .get("/users/:id", auth, (c) => {
    const _caller = c.get("user").email      // typed via Variables generic
    const user = users.get(c.req.param("id"))
    return user ? c.json(user) : c.json({ error: "USER_NOT_FOUND" }, 404)
  })
  .post("/users", zValidator("json", z.object({ name: z.string(), email: z.string() })),
    (c) => {
      const { name, email } = c.req.valid("json")  // typed validated body
      return c.json(createUser({ name, email }), 201)   // 201 is trivial
    })
  .post("/users/:id/deactivate", (c) => {
    const r = deactivate(c.req.param("id"))
    if (r.ok) return c.json(r.value, 200)
    // the status table is INLINE per-handler, hand-written each time
    if (r.error.code === "USER_NOT_FOUND")   return c.json(r.error, 404)
    return c.json(r.error, 409)
  })

export type AppType = typeof routes      // for hc<AppType>()
```

### Elysia (reference)

```ts
import { Elysia, t } from "elysia"

const app = new Elysia()
  // (a) auth as a macro/resolve that adds a typed `user`; guard scopes it
  .resolve(({ headers, status }) => {
    const email = headers["x-user"]
    if (!email) return status(401, "Unauthorized")
    return { user: { id: "caller", email } }   // typed into context
  })
  .get("/users/:id", ({ params: { id }, user, status }) =>
    users.get(id) ?? status(404, { error: "USER_NOT_FOUND" }))
  // (b) body schema = runtime validation + compile types in one decl
  .post("/users", ({ body }) => createUser(body), {
    body: t.Object({ name: t.String(), email: t.String() }),
  })   // 201 needs set.status = 201 in the handler
  // (c) domain result mapped inline with status(...)
  .post("/users/:id/deactivate", ({ params: { id }, status }) => {
    const r = deactivate(id)
    if (r.ok) return r.value
    if (r.error.code === "USER_NOT_FOUND") return status(404, r.error)
    return status(409, r.error)
  })

export type App = typeof app    // for treaty<App>()
```

Per-endpoint ceremony (a, body of handler only) is close to a tie. fractal's
distinctive win is **(c)**: the error→status table is a single reusable
`ErrorPolicy` value applied with `respond(...)`, decoupled from the handler — in
both Hono and Elysia the table is hand-written inline in every action handler.

---

## Scorecard

| # | Criterion | vs Hono | vs Elysia |
|---|-----------|---------|-----------|
| 1 | More elegant / less ceremony | **WIN** (verb sugar + typed params + reusable error policy) | **WIN** |
| 2 | More correct HTTP semantics | **WIN** (405 + Allow + auto-HEAD; both rivals 404) | **WIN** |
| 3 | Tighter / more uniform core | **WIN** | **WIN** |
| 4 | Not HTTP-specific (core decoupled) | **WIN** | **WIN** |
| 5 | Lower barrier to entry | **TIE** (one-line hello-world + verb sugar + stdlib mw; Hono/Elysia still ship a typed client out of the box) | **TIE** |
| 6 | Types equally/more safe | **TIE** (server-side parity; Hono `hc` client beats fractal) | **LOSE** (Eden treaty end-to-end client beats fractal) |

> **Status (punch-list #2–#5 landed).** Criteria 1, 2, 5 flipped. The dispatcher
> now emits 405 + `Allow` and synthesizes HEAD from GET; the router has verb
> sugar (`.get/.post/...`) with template-literal **typed path params**
> (`:id` → `ctx.params.id: string`, zero casts); `withValidation` is
> status-aware (`created(value)` → 201); and `@rhi-zone/fractal-http/middleware`
> ships `cors`/`logger`/`bearerAuth`/`etag` as ordinary `Middleware` VALUES. Only
> #1 (typed client) and #6 (content negotiation) remain deferred — closing #1
> would flip criterion 6 and push 5 to a win.

### Criterion-by-criterion evidence

**1 — Elegant (TIE / TIE).** Per-endpoint body length is comparable across all
three. Elysia's destructuring (`({ params: { id }, user }) =>`) is the leanest
single line. fractal's `ctx.params["id"] ?? ""` is noisier (no param typing,
`noUncheckedIndexedAccess` forces the `?? ""`). fractal's genuine elegance win is
structural, not per-line: the **error policy is a value** (`respond(fn, policy)`),
reused across every action, whereas both competitors hand-roll the status table
inside each handler. Net: tie — fractal trades per-line verbosity for
cross-endpoint reuse.

**2 — Correct HTTP semantics (TIE / TIE).** Confirmed from code: fractal's
dispatcher (`packages/core/src/index.ts`, `dispatchRoutes`) does
`if (entry.method !== ctx.method && entry.method !== "*") continue` and, on no
match, returns `null` → `toHandler` renders `notFound()` (404). **A method
mismatch on a matched path returns 404, NOT 405** — verified by the `vs.test.ts`
405 probe (`DELETE /users/1` → 404). Hono returns 404 in the same case
(open issues #4633, #2624) and Elysia returns 404 too (issue #682, closed
not-planned). No framework sends `HEAD` automatically or does content
negotiation. So this is a tie *today* — and a wide-open lane: fractal can win it
outright by emitting 405 + `Allow` (and synthesizing `HEAD` from `GET`), which
both competitors have declined to do.

**3 — Tighter core (WIN / WIN).** fractal core is one file,
`packages/core/src/index.ts`, ~250 LOC of substance, and its primitive set is
tiny and uniform: `Handler<T,U>` (the arrow) → `Node<T,U,M>` (meta+handler) →
`Router` (route/use/mount over a `RoutingCtx`). Middleware, mount, and validation
all reduce to handler composition. Hono's core is a class with imperative
route/middleware registration, a trie router, and a large `Context` surface
(`c.req`, `c.json`, `c.set`, `c.header`, `c.var`, …). Elysia's core is larger
still (lifecycle hooks `onRequest`/`onParse`/`onTransform`/`beforeHandle`/
`afterHandle`/`mapResponse`/`onError`, plugins, macros, the Sucrose static
analyzer). fractal's "everything is a handler/node over a ctx" is materially
smaller and more uniform. Clear win.

**4 — Not HTTP-specific (WIN / WIN).** `packages/core/src/index.ts` imports
nothing HTTP and nothing runtime — no `Request`/`Response`/`URL`, no Bun/Node.
HTTP lives entirely in `packages/http`, and the single runtime touch is
`packages/http/src/adapter.ts` (`serveBun`/`serveNode`). The router dispatches
over an abstract `RoutingCtx { method, segments, params, vars }`; the same router
algebra serves a CLI or IPC surface by supplying a different ctx. Hono and Elysia
are HTTP frameworks by construction — `Context` *is* an HTTP request/response;
there is no non-HTTP surface. Decisive win, and it is fractal's strongest
differentiator.

**5 — Lower barrier to entry (LOSE / LOSE).** Honest loss. Hono hello-world is
~4 lines (`new Hono().get('/', c => c.text('hi'))` + serve) and CRUD is
method-chained `.get/.post/.put/.delete`. Elysia is ~3 lines
(`new Elysia().get('/', () => 'hi').listen(3000)`). fractal makes you learn
*more concepts before the first useful CRUD*: `httpRouter`, `route` vs
`routeNode`, `withValidation`, `respond` + `Outcome` + `ErrorPolicy`,
`use`/`mount`, `WithVars`, plus you must hand-write or import a Standard-Schema
validator. There's no terse `.get('/', () => 'hi')`-grade hello-world and no
verb sugar. fractal's mental model is *smaller* (criterion 3) but its *surface to
get started* is **larger** — those are different things, and on the get-started
axis fractal loses to both.

**6 — Type safety (TIE vs Hono server-side / LOSE overall).** Server-side, all
three give you typed validated bodies and typed context, so it's a tie on the
handler. fractal has two genuine type wins worth naming: (i) `withValidation`'s
`InferOutput<V> extends Args ? unknown : never` makes a validator whose output
doesn't match the library fn's args a **compile error**, no annotation; (ii) the
router threads `vars` so `ctx.vars.user` is statically typed after `.use(auth)`
with **zero casts** (the no-private-fields linchpin). But the decisive axis is the
**typed client**, and fractal has none. Hono ships `hc<AppType>()` and Elysia
ships Eden `treaty<App>()` — end-to-end inference from one server definition to a
fully-typed client (`const { data, error } = await client.users({ id }).get()`),
where a wrong param or body shape is a compile error *at the call site in another
package*. fractal's `packages/client` is an RPC/correlation client, not an
HTTP-app-typed client derived from the router. So: tie with Hono on the server
handler, but **loses** the end-to-end story to both, and loses **outright to
Elysia** whose Eden inference is the current high-water mark.

---

## Where fractal genuinely LOSES today (no spin)

1. **No typed client** derived from the app (criterion 6). Eden/`hc` are the
   marquee feature of both competitors; fractal has nothing equivalent.
2. **Barrier to entry** (criterion 5): no one-line hello-world, no verb sugar,
   must supply a validator; more concepts before first CRUD.
3. **`withValidation` cannot set a status** — it hardcodes `json(value)` at 200,
   so the spec's "**POST returns 201**" is *not* expressible through it (verified:
   the (b) test asserts 200). You must drop to a raw `respond`/`route` handler to
   get 201, losing the validation sugar. A real ergonomic + correctness gap.
4. **No 405 / no auto-HEAD / no content negotiation** (criterion 2). Method
   mismatch → 404 (confirmed in dispatcher + test). This is a tie not a loss, but
   it's correctness left on the table.
5. **Param values are untyped & index-access-clunky**: `ctx.params["id"]` is
   `string | undefined` under `noUncheckedIndexedAccess`; competitors type params
   from the path string (`:id` → `{ id: string }`).

---

## Punch-list — ranked by leverage

Each item names the criterion it flips and the concrete change.

1. **Typed client derived from the router (crit 6, the big one).** Build
   `packages/http-client`: `client<typeof app>(baseUrl)` returning a proxy whose
   call sites are typed from the route table (path params, validated body in,
   handler output out). This is the only way to match/beat Eden — flips 6 from
   LOSE to WIN. Highest leverage; it's the feature users pick a framework for.
   Lever: reuse `router.meta` (already a reflectable value) as the type source —
   fractal's data-over-code core makes this *easier* than Hono's, which has to
   reconstruct types from an opaque class.

2. **Fix 405 + auto-HEAD in the dispatcher (crit 2 → WIN, cheap).** In
   `dispatchRoutes`, track whether any route matched the *path* but not the
   *method*; if so, return a 405 sentinel carrying the allowed methods so
   `toHandler` can emit `405` + `Allow`. Synthesize `HEAD` from a matching `GET`
   (run it, drop the body). Small, localized change that wins a criterion both
   competitors have *declined* to fix — a clean differentiator. (Keep it a core
   sentinel, not an HTTP type, to preserve criterion 4.)

3. **Endpoint sugar + verb helpers (crit 1 & 5).** Add `get/post/put/del`
   methods on `HttpRouter` (thin wrappers over `route`) and a one-liner app
   constructor so hello-world is `httpRouter().get("/", () => "hi")`. Type
   `params` from the pattern string (`:id` → `{ id: string }`) so `ctx.params.id`
   is `string`, killing the `?? ""` noise. Directly attacks the barrier-to-entry
   loss and the per-line elegance gap.

4. **Make `withValidation` status-aware (crit 2 & 1).** Let the wrapped fn return
   `{ status, value }` or an `Outcome`, and route its output through `render`
   instead of hardcoded `json(...)@200`, so **201** (and 4xx) are expressible
   without abandoning validation sugar. Closes loss #3.

5. **Composable middleware stdlib as ordinary `Middleware` values (crit 5).**
   Ship `cors`, `requestId`, `logger`, `bearerAuth`, `etag` as plain
   `HttpMiddleware` values (not presets, not a DSL) so `.use(cors())` is one
   import. Shrinks the assembly burden that currently makes get-started feel
   heavy, without growing the core.

6. **Content negotiation + a pluggable renderer table (crit 2).** Let the default
   renderer consult `Accept` (JSON vs text) and honor an explicit content-type;
   small, but rounds out the "more correct than both" story once 405/HEAD land.

**Leverage order rationale:** #1 flips the criterion fractal most clearly loses
and is the headline feature; #2 is cheap and wins a criterion *both* rivals
punted on; #3/#4 convert the get-started loss and the 201 gap; #5/#6 are
polish that compound the core's smallness into felt ergonomics.

---

## Sources (current idioms, 2026)

- Hono RPC / `hc<AppType>()`: https://hono.dev/docs/guides/rpc
- Hono validation / `zValidator` + `c.req.valid`: https://hono.dev/docs/guides/validation
- Hono 405-vs-404 (open, unfixed): github.com/honojs/hono issues #4633, #2624, #4262
- Elysia Eden treaty (`treaty<App>()`, `{ data, error }`): https://elysiajs.com/eden/treaty/overview
- Elysia TypeBox (`t.Object`): https://elysiajs.com/patterns/typebox
- Elysia auth via `resolve`/macro: https://elysiajs.com/patterns/macro
- Elysia 405 (issue #682, closed not-planned → still 404): github.com/elysiajs/elysia/issues/682
- fractal: `packages/core/src/index.ts`, `packages/http/src/index.ts`,
  `packages/http/src/adapter.ts`; verified spike
  `examples/todo-api/src/vs.ts` + `vs.test.ts`.
```
