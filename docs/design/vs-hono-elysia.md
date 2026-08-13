# fractal vs Hono vs Elysia — scorecard

Evidence-first comparison across seven criteria. Hono/Elysia snippets are reference
snippets, idiomatic per current (2026) docs — not run, but API-accurate (sources at
the end).

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

### fractal (current API — `packages/api-tree` + `packages/http-api-projector`)

```ts
// app.ts
import { choice, methods, param, paramValue, path } from "@rhi-zone/fractal-api-tree";
import {
  json,
  status,
  text,
  toFetch,
  validated,
  returns,
} from "@rhi-zone/fractal-http-api-projector";
import { schema } from "./schema.ts"; // hand-rolled StandardSchemaV1 fixture

const createSchema = schema({ title: "string" });
const todoSchema = schema({ id: "string", title: "string", done: "boolean" });

const todosCollection = methods({
  GET: returns(() => json(todos), todoListSchema),
  POST: returns(
    validated(createSchema, (v) => {
      const t = { id: String(seq++), title: v.title, done: false };
      todos.push(t);
      return status(201, t);
    }),
    todoSchema,
  ),
});

const todoItem = param(
  "id",
  methods({
    GET: returns((req) => {
      const id = paramValue(req, "id"); // id: string — typed, no ?? ""
      const t = todos.find((t) => t.id === id);
      return t ? json(t) : json({ error: "TODO_NOT_FOUND", id }, { status: 404 });
    }, todoSchema),
  }),
);

export const app = path({
  todos: choice(todosCollection, todoItem),
  health: methods({ GET: () => text("ok") }),
});
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
    const t = todos.find((t) => t.id === c.req.param("id"));
    return t ? c.json(t) : c.json({ error: "TODO_NOT_FOUND" }, 404);
  })
  .post("/todos", zValidator("json", z.object({ title: z.string() })), (c) => {
    const { title } = c.req.valid("json");
    const t = { id: String(seq++), title, done: false };
    todos.push(t);
    return c.json(t, 201);
  });
export type AppType = typeof routes; // for hc<AppType>()
```

### Elysia (reference)

```ts
import { Elysia, t } from "elysia";
const app = new Elysia()
  .get(
    "/todos/:id",
    ({ params: { id }, status }) =>
      todos.find((t) => t.id === id) ?? status(404, { error: "TODO_NOT_FOUND" }),
  )
  .post(
    "/todos",
    ({ body }) => {
      const t = { id: String(seq++), title: body.title, done: false };
      todos.push(t);
      set.status = 201;
      return t;
    },
    { body: t.Object({ title: t.String() }) },
  );
export type App = typeof app; // for treaty<App>()
```

---

## Scorecard

Verification: `bun run test` — **100 pass, 0 fail** across all packages
(core 18, http 30, openapi 16, client 5, codegen 15, example 16).

| #   | Criterion                     | vs Hono                                      | vs Elysia                                             |
| --- | ----------------------------- | -------------------------------------------- | ----------------------------------------------------- |
| 1   | More elegant / less ceremony  | **TIE**                                      | **TIE**                                               |
| 2   | More correct HTTP semantics   | **WIN**                                      | **WIN**                                               |
| 3   | Tighter / more uniform core   | **WIN**                                      | **WIN**                                               |
| 4   | Surface/runtime-agnostic core | **TIE** (deliberate trade — see below)       | **TIE**                                               |
| 5   | Lower barrier to entry        | **TIE** (with caveats at scale — see below)  | **TIE**                                               |
| 6   | Types equally/more safe       | **TIE** (contextual win on robustness/scale) | **TIE** (declared-response-schema caveat — see below) |
| 7   | Routing-dispatch performance  | **TIE** (no head-to-head timing — see below) | **TIE** (no head-to-head timing — see below)          |

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

Verified by `packages/http-api-projector/src/index.test.ts` (`bun run test`, 30 pass):

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
and HTTP correctness projection (`toFetch`) all live in `@rhi-zone/fractal-http-api-projector` as
plain functions, not framework protocol.

Hono's core is a class with imperative `.get/.post/.use` registration, a trie
router, and a `Context` object with many surfaces (`c.req`, `c.json`, `c.set`,
`c.header`, `c.var`, …). Elysia's core is larger still: lifecycle hooks
(`onRequest`/`onParse`/`onTransform`/`beforeHandle`/`afterHandle`/`mapResponse`/
`onError`), plugins, macros, the Sucrose static analyzer. fractal's "everything is a
`(req)=>Response|undefined`" surface is materially smaller and more uniform.

**4 — Surface/runtime-agnostic (TIE / TIE).**

`@rhi-zone/fractal-api-tree` imports no Bun, no Node, and no `Request`/`Response`
(verified: `packages/api-tree/src/index.ts` imports are zero — no external imports at
all). `@rhi-zone/fractal-http-api-projector` imports no Bun and no Node (verified: its only
imports are from `@rhi-zone/fractal-api-tree` and WHATWG globals). The single runtime
touch is `packages/http-api-projector/src/adapter.ts`, which `index.ts` does not import.

However, **`Request`/`Response` live in `Handler` itself** — they are WHATWG globals
in the core type. The framework is deliberately and firmly HTTP/fetch-surface-
specific by design. The old claim that "core is not HTTP-specific" — that the same
routing algebra serves CLI or IPC by swapping a `RoutingCtx` — is retired with the
builder model that made it. The current model's `Handler<P>` is `(req: Request & ...)
=> Response | undefined`: HTTP is in the type, not in a swappable adapter.

**Adapter coverage.** This sub-criterion was previously unearned: the doc claimed
a tie on "runtime-target support" while `adapter.ts` shipped exactly two adapters
(`serveBun`, `serveNode`) against Hono's seven (Node, Deno, Bun, Cloudflare
Workers, Fastly Compute, Vercel Edge, AWS Lambda). That gap is now closed —
`adapter.ts` ships seven adapters matching Hono's target list one-for-one:

- `serveBun` / `serveNode` (pre-existing) — bind a listening socket via
  `Bun.serve` / `node:http`.
- `serveDeno` — binds a listening socket via `Deno.serve`; same shape as
  `serveBun` since Deno's `Request`/`Response` are native WHATWG.
- `serveFastlyCompute` — registers Compute's `fetch` event listener
  (`event.request` → handler → `event.respondWith`).
- `toCloudflareWorker` — translates to the module-worker `{ fetch(request, env,
ctx) }` export shape, dropping the unused `env`/`ctx` bindings.
- `toVercelEdge` — identity function; Vercel's edge runtime dispatches with the
  exact `(req: Request) => Promise<Response>` shape already used throughout the
  package, so there's nothing to translate.
- `toAwsLambdaHandler` — the one adapter that isn't a thin Request/Response
  passthrough: translates `APIGatewayProxyEventV2` (Lambda Function URLs / API
  Gateway HTTP APIs v2) to `Request` and back, matching the event shape Hono's
  own `aws-lambda` adapter targets (headers/cookies folding, text vs.
  base64-encoded body by content type).

Each new adapter is a small, independent function — no shared "adapter
framework" was introduced, consistent with the rest of the package's style.
Tests (`packages/http-api-projector/src/adapter-edge.test.ts`) exercise each
adapter's translation/wiring logic directly (stubbing the ambient `Deno`/
`addEventListener` globals where needed), the same approach `adapter.test.ts`
already used for `serveNode`'s `node:http` shim — none of them run inside their
actual target isolate, since a Workers/Lambda/Fastly sandbox isn't available in
this repo's test environment.

**Caveat:** breadth is now matched, but not maturity. Hono's adapters have run in
production across those seven runtimes for years and are exercised by real
deployments; fractal's are new, verified only by unit tests against each
platform's documented event/response contract, not against a live Workers
isolate, a real Lambda invocation, or a Fastly Compute sandbox. The architectural
claim (a portable `FetchHandler` core plus one small file for all runtime wiring)
is earned; production-hardening on each target is not.

What fractal retains: it is **runtime-agnostic** (runs on Bun, Node, Deno, or
any WHATWG environment without change) and the core imports no runtime-specific
code. Hono is similarly runtime-agnostic. Elysia is Bun-first. On the "not
HTTP-specific" axis: all three are HTTP frameworks by construction.

Verdict: runtime-agnostic tie with Hono, now backed by matching adapter breadth
(both ship 7 runtime targets) rather than architecture alone; Hono still leads
on adapter maturity/production mileage. Slight win over Elysia's Bun-first
stance. "Core decoupled from HTTP" is retired.

**5 — Barrier to entry (TIE with caveats / TIE with caveats).** A one-endpoint
hello-world is straightforward:

```ts
import { methods } from "@rhi-zone/fractal-api-tree";
import { text, toFetch } from "@rhi-zone/fractal-http-api-projector";
const handle = toFetch(methods({ GET: () => text("hi") }));
```

The CRUD tree (`path`/`param`/`choice`/`methods`) is a small surface to learn,
with no decorator, no plugin, no class. The codegen step (`fractal watch app.ts
--out generated`) folds into the dev loop via file-watching and is comparable in
effort to Hono's `hc<AppType>` setup or Elysia's Eden install.

The nuance is at scale. Hono's `hc<AppType>` and Elysia's Eden rely on
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

_Server-side:_ param values are typed (`req.params.id: string` after `param("id", ...)`).
Body shapes are typed via `validated(schema, fn)` — `fn`'s argument type is the
schema's output, enforced at compile time. An undischarged param (`param("id", leaf)`
placed without `param("id", ...)` wrapping) is caught by `toFetch`'s `Handler<{}>`
bound. These are genuine wins over both rivals' raw string-keyed access.

_Response types:_ fractal types responses where `returns(handler, schema)` is
declared — the `returns` schema becomes the codegen-emitted client return type. This
is a gap vs Eden: **Elysia infers response types directly from return
annotations** without a separate declaration; fractal requires an explicit
`returns(...)` call to get a typed response in the generated client. Routes without
`returns` produce `unknown` response types on the client side.

_Drift guard:_ The generated `client.ts` embeds `AssertExact<RouteUnion<typeof app>,
GenUnion>`, which is a `tsc` error the moment the app's route structure diverges from
the generated artifacts. Verified: `packages/type-ir/test/drift.test.ts` — planted
drift (added route, changed body field type) is caught by both tsgo and stock tsc
with a `__drift__` error; restored app is green on both. Rivals' pure inference
cannot drift (the type IS the inference), but it also cannot survive at scale (see
criterion 5) and cannot produce a portable artifact.

_Codegen linearity:_ the drift-guard spike (`spike/drift-guard/`) measured ~243k
type instantiations at 900 routes for the linear `RouteUnion` formulation (f5) vs
5.67M for the naïve inference (f1). Stock tsc fails f1 at 900 routes; f5 (the
formulation fractal uses) survives to 900 routes on stock tsc. This is the concrete
reason codegen exists: inference doesn't scale, codegen does.

Net verdict on criterion 6: contextual win on robustness and scale over both rivals;
real gap (declared response schema required vs Eden's inferred response types).

**7 — Routing-dispatch performance (TIE / TIE).**

fractal's default router is `mapCharRouter` (compile.ts) — static routes served
from a prebuilt `Map`, dynamic routes through a compiled char-matcher function.
The plain tree-walker (`makeRouterFromRoute`, route.ts — zero build cost,
`splitPath` + recursive descent per request) and two other compilers remain
available via the `router` option (`preset.ts:116-125`):

- `radixMatcher`/`radixRouter` — a character-level radix trie, built once at
  setup; no `split`, no per-segment allocation, no codegen.
- `compiledCharMatcher`/`compiledCharRouter` — generates a JS function body
  (nested `if`/`startsWith` on `charCodeAt`) and instantiates it via
  `new Function(...)`. This is the architecture analogous to Hono's
  RegExpRouter: both compile the whole route table into one generated matcher
  instead of walking a data structure per request.
- `mapMatcher`/`mapCharRouter` — static routes served from a prebuilt
  `Map<pathname, methods>` (one hash lookup); dynamic routes fall through to
  `compiledCharMatcher`, fed only the dynamic subset so the generated function
  is smaller than compiling the full tree.

**Measured** (`packages/http-api-projector/src/route.bench.ts`, 993 routes / 30
dispatch cases, `bun run packages/http-api-projector/src/route.bench.ts`; saved
run: `packages/http-api-projector/bench-results/route-bench-2026-07-17T07-29-08-288Z.json`,
AMD Ryzen 9 9900X, Bun 1.3.9 — per-dispatch time = `totalMs * 1e6 / 500_000` iterations):

| dispatch case                    | 1. tree-walk | 5. radix trie | 7. compiled fn | 8. Map+compiled hybrid (default) |
| -------------------------------- | ------------ | ------------- | -------------- | -------------------------------- |
| static hit                       | 189ns        | 88ns          | 162ns          | 28ns                             |
| dynamic hit                      | 205ns        | 90ns          | 114ns          | 52ns                             |
| deep hit (5 segs)                | 353ns        | 130ns         | 158ns          | 29ns                             |
| miss (404)                       | 183ns        | 99ns          | 162ns          | 49ns                             |
| wide branch, late (120 siblings) | 224ns        | 166ns         | 436ns          | 28ns                             |
| static path, 8k chars            | 24.6µs       | 9.8µs         | 0.92µs         | 0.57µs                           |

The hybrid (`mapCharRouter`, now fractal's default) is fastest on every case
measured — 3-9x the tree-walker on short paths, ~40x on the 8k-char pathological
case. The radix trie is the next-best all-rounder, 1.4-2.7x the tree-walker.
`compiledCharMatcher` alone is
not uniformly the fastest: it loses to the radix trie on wide branching (436ns vs
166ns at "wide late", 120 static siblings under one node) because compiling the
whole route set into one generated function produces a long branch chain at wide
fan-out — the reason `mapCharRouter` partitions statics into a `Map` first and
only feeds the codegen path the dynamic subset (31KB generated source for the
dynamic-only hybrid vs 256KB compiling all 993 routes as one function,
per `codegenSizes` in the same results file).

Build (setup) cost scales the other way: tree-walk 623µs and radix trie 461µs to
build the 993-route structure, vs 13.3ms for `compiledCharMatcher` (codegen +
`new Function` compile of the full table) and 1.9ms for the hybrid (codegen over
the dynamic subset only) — the default's own build cost is the second-lowest
measured, ahead of both non-hybrid compilers. The compilers trade one-time build
cost for per-request dispatch cost — a build-time/request-time tradeoff, but the
default now sits at the good end of both axes rather than trading one for the
other.

**vs Hono.** Hono's default router is RegExpRouter, which Hono's own docs
(hono.dev/docs/concepts/routers) describe as "the fastest router in the
JavaScript world" and claim "works faster than methods that use tree-based
algorithms such as radix-tree in most cases," compiling the route table into one
combined regular expression plus a `staticMap` for O(1) exact-path lookups
(consistent with `docs/design/prior-art/hono.md`'s description of
`src/router/reg-exp-router/router.ts`). Hono also ships TrieRouter,
PatternRouter, and LinearRouter as explicit opt-ins for other perf/bundle-size
tradeoffs — so both frameworks offer a menu of dispatch strategies, and each now
defaults to the one it benchmarks fastest internally: Hono's default is its
fastest router; fractal's default (`mapCharRouter`) is also fractal's fastest
router, measured in this file's own benchmark. `compiledCharMatcher`, fractal's
closest analog to RegExpRouter's codegen approach, is not fractal's fastest
option (the Map+radix-shaped hybrid beats it, mirroring Hono's own claim that
pure codegen doesn't always beat a tree/hash combination) — but fractal doesn't
ship that one as default either. No head-to-head timing exists between fractal
and Hono — Hono was not run inside this repo's benchmark harness, so the two
frameworks' numbers are not directly comparable, only their architectures and
each side's own published numbers.

**vs Elysia.** Elysia's default router (via the bundled Memoirist package,
github.com/SaltyAom/memoirist) stores static routes in a plain object for O(1)
lookup and dynamic routes in a per-HTTP-method radix tree — structurally the
same Map-plus-dynamic-matcher shape as fractal's `mapCharRouter`, except
Elysia's dynamic half is a radix tree and fractal's is a compiled function.
That shape is Elysia's default, and it is now fractal's default too
(`mapCharRouter`). No published Elysia benchmark numbers were verified against
fractal's harness, so as with Hono this is an architectural comparison, not a
timed one.

Verdict: architecturally tied or ahead — fractal's benchmarked hybrid router
beats every architecture in this file's own benchmark, including the one
structurally closest to each rival's default, and as of `preset.ts:116-125` it
is fractal's shipped default, closing the default-vs-opt-in gap this criterion
previously flagged. The TIE now rests on the absence of head-to-head timing
against Hono or Elysia's own routers, not on which router each project ships by
default — all three frameworks default to the router shape their own
benchmarks (or the closest available proxy) call fastest.

---

## Where fractal loses or ties today

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
   crashes stock tsc; but at small scale it is lower-friction.

---

## Sources (current idioms, 2026)

- Hono RPC / `hc<AppType>()`: https://hono.dev/docs/guides/rpc
- Hono validation / `zValidator` + `c.req.valid`: https://hono.dev/docs/guides/validation
- Hono 405-vs-404 (open, unfixed): github.com/honojs/hono issues #4633, #2624, #4262
- Elysia Eden treaty (`treaty<App>()`, `{ data, error }`): https://elysiajs.com/eden/treaty/overview
- Elysia TypeBox (`t.Object`): https://elysiajs.com/patterns/typebox
- Elysia auth via `resolve`/macro: https://elysiajs.com/patterns/macro
- Elysia 405 (issue #682, closed not-planned → still 404): github.com/elysiajs/elysia/issues/682
- Hono router implementations (RegExpRouter/TrieRouter/PatternRouter/LinearRouter,
  "fastest router in the JavaScript world" claim): https://hono.dev/docs/concepts/routers
- Elysia default router (Memoirist radix tree + static object): github.com/SaltyAom/memoirist,
  github.com/elysiajs/elysia
- fractal sources verified:
  - `packages/api-tree/src/index.ts` — `Handler<P>`, combinators, `.meta` types
  - `packages/http-api-projector/src/index.ts` — `toFetch`, `validated`, `returns`, response builders
  - `packages/http-api-projector/src/index.test.ts` — HTTP correctness tests (30 pass)
  - `packages/type-ir/test/drift.test.ts` — drift guard pipeline (4 pass, both compilers)
  - `packages/type-ir/src/cli.ts` — `fractal watch` implementation
  - `examples/todo-api/src/app.ts` — full working example (16 pass)
  - `spike/drift-guard/logs/table.md` — linearity numbers at 99–900 routes
  - `spike/scale/logs/stock-tsc-crossval.md` — stock tsc crash at 600 routes (chained inference)
  - `packages/http-api-projector/src/compile.ts` — `radixMatcher`/`compiledCharMatcher`/`mapCharRouter`
  - `packages/http-api-projector/src/route.bench.ts` — benchmark harness, 8 architectures, 993 routes/30 cases
  - `packages/http-api-projector/bench-results/route-bench-2026-07-17T07-29-08-288Z.json` — measured run cited above
  - `packages/http-api-projector/src/preset.ts:116-125` — `router` option, default `mapCharRouter`
