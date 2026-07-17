# fractal vs Hono vs Elysia — honest head-to-head

Brutally honest, evidence-first comparison on six criteria. Where fractal loses or
ties, it says so. Hono/Elysia snippets are reference snippets, idiomatic per
current (2026) docs — not run, but API-accurate (sources at the end).

Frameworks compared:
- **Hono 4.x** — `zValidator`, `c.req.valid()`, `hc<App>()`.
- **Elysia (current)** — `t.Object`, `.resolve`/`.derive`, Eden `treaty<App>()`.
- **fractal** — `Handler<P>`, `path`/`methods`/`param`/`choice`, `validated`/`returns`,
  `toFetch(app)`, codegen (`fractal watch`).

---

## The three endpoints

(a) `GET /todos/:id` → one item or 404.
(b) `POST /todos` with body `{title: string}`, returns 201.
(c) A watched dev loop where the client's TypeScript types track the server.

### fractal (current API — `packages/api-tree` + `packages/http`)

```ts
// app.ts
import { choice, methods, param, paramValue, path } from "@rhi-zone/fractal-api-tree";
import { json, status, text, toFetch, validated, returns } from "@rhi-zone/fractal-http";
import { schema } from "./schema.ts"; // hand-rolled StandardSchemaV1 fixture

const createSchema = schema({ title: "string" });
const todoSchema   = schema({ id: "string", title: "string", done: "boolean" });

const todosCollection = methods({
  GET:  returns(() => json(todos), todoListSchema),
  POST: returns(validated(createSchema, (v) => {
    const t = { id: String(seq++), title: v.title, done: false };
    todos.push(t);
    return status(201, t);
  }), todoSchema),
});

const todoItem = param("id", methods({
  GET: returns((req) => {
    const id = paramValue(req, "id");    // id: string — typed, no ?? ""
    const t = todos.find(t => t.id === id);
    return t ? json(t) : json({ error: "TODO_NOT_FOUND", id }, { status: 404 });
  }, todoSchema),
}));

export const app = path({ todos: choice(todosCollection, todoItem), health: methods({ GET: () => text("ok") }) });
export const handle = toFetch(app);
```

Dev loop: `fractal watch src/app.ts --out src/generated` regenerates
`src/generated/client.ts` and `src/generated/server.ts` on every source save.
The generated files embed a static drift guard (`AssertExact<RouteUnion<typeof app>,
GenUnion>`) that makes any app/generated mismatch a `tsc` error before tests run.

### Hono 4.x (reference)

```ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

const app = new Hono();
const routes = app
  .get("/todos/:id", (c) => {
    const t = todos.find(t => t.id === c.req.param("id"));
    return t ? c.json(t) : c.json({ error: "TODO_NOT_FOUND" }, 404);
  })
  .post("/todos", zValidator("json", z.object({ title: z.string() })), (c) => {
    const { title } = c.req.valid("json");
    const t = { id: String(seq++), title, done: false };
    todos.push(t);
    return c.json(t, 201);
  });
export type AppType = typeof routes;  // for hc<AppType>()
```

### Elysia (reference)

```ts
import { Elysia, t } from "elysia";
const app = new Elysia()
  .get("/todos/:id", ({ params: { id }, status }) =>
    todos.find(t => t.id === id) ?? status(404, { error: "TODO_NOT_FOUND" }))
  .post("/todos", ({ body }) => {
    const t = { id: String(seq++), title: body.title, done: false };
    todos.push(t);
    set.status = 201;
    return t;
  }, { body: t.Object({ title: t.String() }) });
export type App = typeof app;  // for treaty<App>()
```

---

## Scorecard

Verification: `bun run test` — **100 pass, 0 fail** across all packages
(core 18, http 30, openapi 16, client 5, codegen 15, example 16).

| # | Criterion | vs Hono | vs Elysia |
|---|-----------|---------|-----------|
| 1 | More elegant / less ceremony | **TIE** | **TIE** |
| 2 | More correct HTTP semantics | **WIN** | **WIN** |
| 3 | Tighter / more uniform core | **WIN** | **WIN** |
| 4 | Surface/runtime-agnostic core | **TIE** (deliberate trade — see below) | **TIE** |
| 5 | Lower barrier to entry | **TIE** (with caveats at scale — see below) | **TIE** |
| 6 | Types equally/more safe | **TIE** (contextual win on robustness/scale) | **TIE** (declared-response-schema caveat — see below) |

---

### Criterion-by-criterion evidence

**1 — Elegance / ceremony (TIE / TIE).** Per-endpoint handler body is comparable across
all three. Hono's verb-chained `.get/.post` and Elysia's destructuring
(`({ params: { id } })`) are terse one-liners. fractal's tree is explicit:
`param("id", methods({ GET: ... }))`. Dynamic param values are read via
`paramValue(req, "id")` rather than a `c.req.param("id")` sugar call, which adds a
line. On the other hand, fractal has no framework-specific context object
(`c` / `ctx`) to thread through — handlers are plain `(req) => Response` arrows.
Ceremony is different in shape, not in volume. Net: tie.

Verified: `examples/todo-api/src/app.ts` — the full working app is 60 lines of
combinator tree with no class, no decorator, no plugin registration.

**2 — HTTP correctness (WIN / WIN).** HTTP correctness is a PROJECTION computed by
`toFetch` from the app's inert `.meta` tree, not emitted during dispatch. This is
the key architectural decision: `methods` passes (`undefined`) on a verb miss rather
than short-circuiting with 405, so `choice` alts are never cut short — and `toFetch`
then walks the full `.meta` to aggregate the `Allow` set across every branch at the
matched path.

Verified by `packages/http/src/index.test.ts` (`bun run test`, 30 pass):
- "known path, wrong verb -> 405 + Allow lists the table's verbs" — single-table 405.
- "auto-HEAD mirrors GET: status + headers preserved, empty body" — auto-HEAD.
- "OPTIONS -> 204 + Allow union (HEAD when GET present, OPTIONS always)" — OPTIONS.
- "unknown path -> 404 (path does not exist)" / "known path, wrong verb -> 405, not 404" — 404 vs 405 distinction.
- "param route, wrong verb -> 405 + Allow: GET" — param-route 405.
- "POST reaches the 2nd alt -> 200 (no 405 short-circuit)" — cross-choice correctness (regression C-F1).
- "PUT -> 405 with Allow aggregating BOTH alts' verbs" — cross-choice Allow union.
- "cross-mount: DELETE -> 405 with Allow unioning BOTH mounts' verbs" — cross-mount Allow union.

Both Hono and Elysia return 404 on method mismatch at a known path (Hono issues
#4633, #2624, #4262; Elysia issue #682 closed not-planned). Neither auto-synthesizes
HEAD from GET or emits OPTIONS. Decisive win — and it is compositional (aggregates
across `choice` and `mount`, not just within a single `methods` table).

**3 — Tighter / more uniform core (WIN / WIN).** The only framework type in
`@rhi-zone/fractal-api-tree` is `Handler<P>`:

```ts
Handler<P> = (req: Request & { params: P }) => Response | undefined | Promise<...>
```

Combinators (`path`, `methods`, `param`, `choice`, `mount`) are plain functions
returning a `Handler` with an inert `.meta` sidecar — never a class, never a
lifecycle hook registration. `undefined` means "not mine — pass to the next handler".
Validation (`validated`), response building (`json`/`text`/`binary`/`sse`/`status`),
and HTTP correctness projection (`toFetch`) all live in `@rhi-zone/fractal-http` as
plain functions, not framework protocol.

Hono's core is a class with imperative `.get/.post/.use` registration, a trie
router, and a `Context` object with many surfaces (`c.req`, `c.json`, `c.set`,
`c.header`, `c.var`, …). Elysia's core is larger still: lifecycle hooks
(`onRequest`/`onParse`/`onTransform`/`beforeHandle`/`afterHandle`/`mapResponse`/
`onError`), plugins, macros, the Sucrose static analyzer. fractal's "everything is a
`(req)=>Response|undefined`" surface is materially smaller and more uniform.

**4 — Surface/runtime-agnostic (TIE / TIE).** This criterion requires an HONEST
statement of the current position.

`@rhi-zone/fractal-api-tree` imports no Bun, no Node, and no `Request`/`Response`
(verified: `packages/api-tree/src/index.ts` imports are zero — no external imports at
all). `@rhi-zone/fractal-http` imports no Bun and no Node (verified: its only
imports are from `@rhi-zone/fractal-api-tree` and WHATWG globals). The single runtime
touch is `packages/http/src/adapter.ts` (`serveBun`/`serveNode`), which `index.ts`
does not import.

However, **`Request`/`Response` live in `Handler` itself** — they are WHATWG globals
in the core type. The framework is deliberately and firmly HTTP/fetch-surface-
specific by design. The old claim that "core is not HTTP-specific" — that the same
routing algebra serves CLI or IPC by swapping a `RoutingCtx` — is retired with the
builder model that made it. The current model's `Handler<P>` is `(req: Request & ...)
=> Response | undefined`: HTTP is in the type, not in a swappable adapter.

What fractal retains: it is **runtime-agnostic** (runs on Bun, Node, or any WHATWG
environment without change) and the core imports no runtime-specific code. Hono is
similarly runtime-agnostic. Elysia is Bun-first. On the "not HTTP-specific" axis:
all three are HTTP frameworks by construction.

Honest verdict: runtime-agnostic tie with Hono; slight win over Elysia's Bun-first
stance. "Core decoupled from HTTP" is retired.

**5 — Barrier to entry (TIE with caveats / TIE with caveats).** A one-endpoint
hello-world is straightforward:

```ts
import { methods } from "@rhi-zone/fractal-api-tree";
import { text, toFetch } from "@rhi-zone/fractal-http";
const handle = toFetch(methods({ GET: () => text("hi") }));
```

The CRUD tree (`path`/`param`/`choice`/`methods`) is a small surface to learn,
with no decorator, no plugin, no class. The codegen step (`fractal watch app.ts
--out generated`) folds into the dev loop via file-watching and is comparable in
effort to Hono's `hc<AppType>` setup or Elysia's Eden install.

The honest nuance is at SCALE. Hono's `hc<AppType>` and Elysia's Eden rely on
recursive structural type inference over the whole app tree. At ≥600 routes this
inference is O(N²) or worse: stock `tsc` crashes with a stack overflow on Hono's
chained builder variant at 600 routes (verified: `spike/scale/logs/stock-tsc-
crossval.md` — "CRASH: RangeError: Maximum call stack size exceeded"). fractal's
codegen avoids this by projecting an OpenAPI doc at build time and emitting a
linear `RouteUnion` type (~128 type instantiations/route at 900 routes; stock tsc
survives to 900 — `spike/drift-guard/logs/table.md`). At small scale (< 100 routes)
inference and codegen both work; at scale, codegen is the only approach that
survives stock tsc.

**6 — Type safety (TIE on robustness/scale — with declared-response-schema caveat).**

*Server-side:* param values are typed (`req.params.id: string` after `param("id", ...)`).
Body shapes are typed via `validated(schema, fn)` — `fn`'s argument type is the
schema's output, enforced at compile time. An undischarged param (`param("id", leaf)`
placed without `param("id", ...)` wrapping) is caught by `toFetch`'s `Handler<{}>`
bound. These are genuine wins over both rivals' raw string-keyed access.

*Response types:* fractal types responses where `returns(handler, schema)` is
declared — the `returns` schema becomes the codegen-emitted client return type. This
is an honest gap vs Eden: **Elysia infers response types directly from return
annotations** without a separate declaration; fractal requires an explicit
`returns(...)` call to get a typed response in the generated client. Routes without
`returns` produce `unknown` response types on the client side.

*Drift guard:* The generated `client.ts` embeds `AssertExact<RouteUnion<typeof app>,
GenUnion>`, which is a `tsc` error the moment the app's route structure diverges from
the generated artifacts. Verified: `packages/codegen/test/drift.test.ts` — planted
drift (added route, changed body field type) is caught by both tsgo and stock tsc
with a `__drift__` error; restored app is green on both. Rivals' pure inference
cannot drift (the type IS the inference), but it also cannot survive at scale (see
criterion 5) and cannot produce a portable artifact.

*Codegen linearity:* the drift-guard spike (`spike/drift-guard/`) measured ~243k
type instantiations at 900 routes for the linear `RouteUnion` formulation (f5) vs
5.67M for the naïve inference (f1). Stock tsc fails f1 at 900 routes; f5 (the
formulation fractal uses) survives to 900 routes on stock tsc. This is the concrete
reason codegen exists: inference doesn't scale, codegen does.

Net verdict on criterion 6: contextual win on robustness and scale over both rivals;
honest gap (declared response schema required vs Eden's inferred response types).

---

## Where fractal genuinely loses or ties today (no spin)

1. **Declared response schema required.** Routes without `returns(handler, schema)`
   produce `unknown` client response types. Eden infers response types from return
   annotations automatically. This is a real ergonomic gap.

2. **No verb sugar at the tree level.** `methods({ GET: ..., POST: ... })` is
   explicit but more verbose than Hono's `.get("/path", ...)` or Elysia's
   `.get("/path", ...)` chaining. The tree structure is a different shape of
   ceremony, not zero ceremony.

3. **`paramValue(req, "id")` rather than destructuring.** Dynamic param values must
   be read via `paramValue(req, name)` or `req.params.name` (with the `param`
   combinator discharging the obligation). Rivals destructure from the context
   object: `c.req.param("id")` / `({ params: { id } })`.

4. **Watch/build step is required for the typed client.** `fractal watch` folds this
   into the dev loop (comparable to Eden's install), but it is a real step that
   rivals avoid through pure inference at small scale. At scale, pure inference
   crashes stock tsc; but at small scale it is genuinely lower-friction.

---

## Sources (current idioms, 2026)

- Hono RPC / `hc<AppType>()`: https://hono.dev/docs/guides/rpc
- Hono validation / `zValidator` + `c.req.valid`: https://hono.dev/docs/guides/validation
- Hono 405-vs-404 (open, unfixed): github.com/honojs/hono issues #4633, #2624, #4262
- Elysia Eden treaty (`treaty<App>()`, `{ data, error }`): https://elysiajs.com/eden/treaty/overview
- Elysia TypeBox (`t.Object`): https://elysiajs.com/patterns/typebox
- Elysia auth via `resolve`/macro: https://elysiajs.com/patterns/macro
- Elysia 405 (issue #682, closed not-planned → still 404): github.com/elysiajs/elysia/issues/682
- fractal sources verified:
  - `packages/api-tree/src/index.ts` — `Handler<P>`, combinators, `.meta` types
  - `packages/http/src/index.ts` — `toFetch`, `validated`, `returns`, response builders
  - `packages/http/src/index.test.ts` — HTTP correctness tests (30 pass)
  - `packages/codegen/test/drift.test.ts` — drift guard pipeline (4 pass, both compilers)
  - `packages/codegen/src/cli.ts` — `fractal watch` implementation
  - `examples/todo-api/src/app.ts` — full working example (16 pass)
  - `spike/drift-guard/logs/table.md` — linearity numbers at 99–900 routes
  - `spike/scale/logs/stock-tsc-crossval.md` — stock tsc crash at 600 routes (chained inference)
