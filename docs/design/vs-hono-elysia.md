# fractal vs Hono vs Elysia — scorecard

Evidence-first comparison across seven criteria. Hono/Elysia snippets are reference
snippets, idiomatic per current (2026) docs — not run, but API-accurate (sources at
the end). The fractal snippet below is assembled from verified current primitives
(each piece traced to real, passing tests, cited inline) rather than copied verbatim
from one file — it was not itself executed as a single combined test.

Frameworks compared:

- **Hono 4.x** — `zValidator`, `c.req.valid()`, `hc<App>()`.
- **Elysia (current)** — `t.Object`, `.resolve`/`.derive`, Eden `treaty<App>()`.
- **fractal** — `Handler<I, O>` (protocol-agnostic — see criterion 3/4), `op`/`api`/
  `fallback`, `http.get`/`http.post`/`http.moveTo`/`httpErrors`, `restCrud`/
  `httpProjection`/`createFetch` (all `@rhi-zone/fractal-http-api-projector`).

> **Note on scope.** `packages/` now has thirteen packages, not two — besides
> `api-tree` and `http-api-projector` there's `cli-api-projector`,
> `graphql-api-projector`, `json-rpc-api-projector`, `mcp-api-projector`,
> `http-framework-projector`, `auth-oidc`, `type-ir`, `ffi-ir`, `api-explorer`,
> `playground`, and the `fractal` meta-package. All of the HTTP/CLI/GraphQL/JSON-RPC/
> MCP projectors consume the exact same `Node`/`Handler` type from
> `packages/api-tree/src/node.ts` (verified: each imports `Node`/`Handler`/`isLeaf`
> from `@rhi-zone/fractal-api-tree` or `@rhi-zone/fractal-api-tree/node`) — one tree,
> several projections. This doc stays scoped to the HTTP projection specifically,
> since that's the axis Hono/Elysia are comparable on; the rest of the surface is out
> of scope here by design, not by oversight.

---

## The three endpoints

(a) `GET /todos/:id` → one item or 404.
(b) `POST /todos` with body `{title: string}`, returns 201.
(c) A watched dev loop where the client's TypeScript types track the server.

### fractal (current API — `packages/api-tree` + `packages/http-api-projector`)

`examples/todo-api` no longer exists — `examples/` currently has only
`doc-site-verification` and `library-api`. `library-api` (255 lines,
`examples/library-api/src/tree.ts`) is the closest real current example, but it's a
larger multi-resource domain (books CRUD + catalog search + checkout actions) that
also exercises MCP/CLI projection and staged wire validation from the same tree, not
a minimal todo app. The snippet below is real, shipped, tested code trimmed to the
three-endpoint shape — `restCrud`'s own end-to-end test
(`packages/http-api-projector/src/dx.test.ts`, "GET / lists, POST / creates, GET/PUT/
DELETE /:id co-locate onto the id fallback") exercises this exact pattern:

```ts
// app.ts
import { api, err, ok } from "@rhi-zone/fractal-api-tree";
import { createFetch, httpErrors } from "@rhi-zone/fractal-http-api-projector";
import { restCrud } from "@rhi-zone/fractal-http-api-projector/dx";

type Todo = { id: string; title: string; done: boolean };
const todos = new Map<string, Todo>();
let seq = 0;

export const app = api({
  todos: restCrud({
    list: (_: unknown) => [...todos.values()],
    create: (input: { title: string }) => {
      const t: Todo = { id: `todo-${++seq}`, title: input.title, done: false };
      todos.set(t.id, t);
      return t;
    },
    get: (input: { id: string }) => {
      const t = todos.get(input.id);
      return t !== undefined ? ok(t) : err({ kind: "notFound", id: input.id });
    },
  }),
});

export const handle = createFetch(app, { errorEncoder: httpErrors({ notFound: 404 }) });
```

`restCrud` (`packages/http-api-projector/src/dx.ts`) wires `list`/`create` onto the
resource's own path via `op(handler, http.get, http.moveTo(".."))` /
`op(handler, http.post, http.moveTo(".."))`, and `get`/`update`/`delete` onto an
`id`-named `fallback()` subtree the same way, one level deeper — the identical
"child moves up onto its own parent" mechanic `library-api`'s `readBook` uses.
`createFetch` compiles it with the default router (`mapCharRouter`, criterion 7) and
wires 405/Allow/auto-HEAD/OPTIONS unconditionally (criterion 2).

Two things worth being precise about, both confirmed against `restCrud`'s own
end-to-end test:

- **`POST /todos` returns 200 by default, not 201.** Getting 201 needs an explicit
  `{ http: { response: { status: 201 } } }` meta contribution on the `create` op
  (verified pattern: `packages/http-api-projector/src/route.test.ts`, "`applyResponse`
  — wraps the handler so the router produces the directive's status").
- **A thrown `Error` with no `errorEncoder`/`thrownErrorEncoder` configured becomes a
  500, not a 404.** Getting 404 for "not found" needs the handler to return
  `err({ kind: "notFound", ... })` and `createFetch` to be given
  `httpErrors({ notFound: 404 })` — exactly what the snippet above does (verified:
  `packages/http-api-projector/src/error-encoder.test.ts`).

Dev loop: there are now **two separate, unrelated codegen paths**, and neither
matches the old `fractal watch src/app.ts --out src/generated` story:

- `packages/api-tree/src/cli.ts`'s `build`/`watch`/`check` subcommands (renamed from
  `build-wire`/`watch-wire`/`check-wire` — see TODO.md's phase-D entry) regenerate the
  `applyValidation` wire-validator module (`src/generated/apply-validation.ts` in
  `library-api`), not a typed client.
- The standalone typed client (`client.generated.ts`) is generated by a one-shot
  script (`examples/library-api/scripts/generate-client.ts`, run via
  `bun run codegen:client`) calling `generateClientFromSource` — `Bun.write`, no CLI
  bin, **no watch mode**. TODO.md tracks this explicitly as an open, undecided item
  ("someone noticed there's no `fractal watch`-equivalent for regenerating the
  standalone typed client... still not decided") with a measured ~550-600ms per
  manual rerun (2026-08-16, 5 runs).

The old drift-guard claim (`AssertExact<RouteUnion<typeof app>, GenUnion>` embedded in
the generated client, `tsc`-erroring on any app/generated mismatch) does not describe
current behavior — see criterion 6.

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

Verification (2026-08, `bun run test` per-package): `@rhi-zone/fractal-api-tree`
**436 pass, 0 fail** (23 files), `@rhi-zone/fractal-http-api-projector` **672 pass, 0
fail** (39 files), `examples/library-api` **43 pass, 0 fail** (2 files) — the three
packages this comparison actually concerns. (The full workspace `bun run test` also
runs eight more packages — `type-ir`, `mcp-api-projector`, `cli-api-projector`,
`graphql-api-projector`, `json-rpc-api-projector`, `auth-oidc`, `ffi-ir`,
`api-explorer`, `playground`, `http-framework-projector` — thousands more tests, all
passing, but out of scope for an HTTP-vs-Hono-vs-Elysia comparison.)

| #   | Criterion                     | vs Hono                                      | vs Elysia                                             |
| --- | ----------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| 1   | More elegant / less ceremony  | **TIE**                                      | **TIE**                                               |
| 2   | More correct HTTP semantics   | **WIN**                                      | **WIN**                                               |
| 3   | Tighter / more uniform core   | **WIN**                                      | **WIN**                                               |
| 4   | Surface/runtime-agnostic core | **TIE** (now genuinely protocol-agnostic — see below) | **TIE**                                       |
| 5   | Lower barrier to entry        | **TIE** (with caveats at scale — see below)  | **TIE**                                               |
| 6   | Types equally/more safe       | **TIE** (drift guard retired — see below)    | **TIE** (declared-response-schema caveat narrowed — see below) |
| 7   | Routing-dispatch performance  | **TIE** (no head-to-head timing — see below) | **TIE** (no head-to-head timing — see below)          |

---

### Criterion-by-criterion evidence

**1 — Elegance / ceremony (TIE / TIE).** Per-endpoint handler body is comparable
across all three. Hono's verb-chained `.get/.post` and Elysia's destructuring
(`({ params: { id } })`) are terse one-liners. fractal's handlers are plain
`(input) => output` functions — no context object, no `req`/`c`/`ctx` to thread
through, and no `paramValue()`/`req.params.x` indirection either: path params, query,
and body all arrive pre-merged into the handler's single typed `input` argument
(verified: `restCrud`'s `get: (input: { id: string }) => ...` in
`packages/http-api-projector/src/dx.test.ts`). What replaced the old
`param("id", methods({...}))` combinator chain is placement ceremony instead of
access ceremony: co-locating multiple verbs on one path (`GET`+`POST /todos`, or
`GET`+`PUT`+`DELETE /todos/:id`) needs each op wrapped with `http.moveTo("..")` to
collapse it onto its parent's position — `restCrud`/`crud` (`dx.ts`) hide this for the
standard 5-op resource shape, but a bespoke tree still needs to know the mechanic.
Ceremony moved from "reading a param" to "placing a leaf"; net effect on volume is a
wash. Net: tie.

**2 — HTTP correctness (WIN / WIN).** HTTP correctness is still a projection, not
baked into raw dispatch — now split more explicitly into a layer:
`packages/http-api-projector/src/layers.ts`'s `autoMethodLayer` synthesizes HEAD from
GET and OPTIONS/405+`Allow` by walking the route table, wrapping the raw compiled
router. `createFetch` (`preset.ts`) applies this layer unconditionally
(`const withMethods = autoMethodLayer(withMiddleware, routes)`) — every consumer of
the documented entry point gets it, matching the old `toFetch`'s behavior even though
the mechanism moved to a named, separately-testable layer. The raw/uncompiled router
(`makeRouterFromRoute` without the layer) genuinely does return plain 404 on a method
miss — verified by `packages/http-api-projector/src/layers.test.ts`'s explicitly
labeled `[core]` tests ("HEAD on a GET route → 404 (no HEAD-from-GET in core)",
"OPTIONS on a known path → 404 (no auto-OPTIONS in core)", "wrong method on a known
path → 404, no Allow header") right next to the `[layer]` tests proving the wrapped
behavior ("HEAD → derives from GET, body stripped, status 200", "OPTIONS → 204 + Allow
header contains GET and OPTIONS", "wrong method → 405 + Allow header") — 16 pass, 0
fail in that file alone. General 405+`Allow`-aggregation coverage also exists in
`packages/http-api-projector/src/project.test.ts` ("wrong method on a known path →
405 with Allow listing the registered methods") and `preset.test.ts` ("wrong method
on known path → 405 + Allow").

<!-- FLAG: the old doc's specific cross-`choice`/cross-mount Allow-union regression
     test (its "C-F1", proving a POST reaching a second `choice` alt doesn't get
     short-circuited by the first alt's 405) has no verified current equivalent —
     `choice` itself no longer exists as a combinator (confirmed absent from
     api-tree's exports), so the exact old scenario can't be re-created the same way.
     Whether the underlying invariant (multiple co-located ops at one path correctly
     aggregate Allow rather than 405-ing on the first miss) still holds wasn't
     re-verified by a matching test in this pass — the general 405+Allow tests above
     cover a single resource, not an explicit multi-branch aggregation case. -->

Both Hono and Elysia return 404 on method mismatch at a known path (Hono issues
#4633, #2624, #4262; Elysia issue #682 closed not-planned). Neither auto-synthesizes
HEAD from GET or emits OPTIONS. Decisive win — still compositional, now via an
explicit named layer rather than folded into a single `toFetch` call.

One nuance the old doc didn't have to address: 405/Allow/HEAD/OPTIONS correctness is
automatic, but *resource-level* semantic status codes (404 for a missing item, 201 for
a created one) are not — see the main example above. That's a separate axis
(protocol-mechanics correctness vs. application-level status modeling), not a
regression on this criterion.

**3 — Tighter / more uniform core (WIN / WIN).** The core `Handler` type in
`@rhi-zone/fractal-api-tree` changed shape entirely since this doc was last accurate,
and is now *more* uniform, not less:

```ts
// packages/api-tree/src/node.ts
type Handler<I = any, O = any> = (input: I) => O | Promise<O>;
```

No `Request`, no `Response`, no HTTP anywhere in the type — verified: zero
`Request`/`Response` references anywhere in `node.ts`. Combinators (`op`, `api`,
`fallback`, `mergeMeta`) are plain functions returning a `Node<Handler>` with an inert
`.meta` sidecar — still never a class, never a lifecycle hook registration.
Validation, response building, and HTTP-specific status/Allow/HEAD/OPTIONS
correctness all live in `@rhi-zone/fractal-http-api-projector` as plain functions
(`op(fn, http.get, ...)`, `httpProjection`, `createFetch`, `httpErrors`) — the same
separation as before, just with `Response`/`Request` now absent from the core type
entirely rather than baked into `Handler` itself (contrast criterion 4).

Hono's core is a class with imperative `.get/.post/.use` registration, a trie
router, and a `Context` object with many surfaces (`c.req`, `c.json`, `c.set`,
`c.header`, `c.var`, …). Elysia's core is larger still: lifecycle hooks
(`onRequest`/`onParse`/`onTransform`/`beforeHandle`/`afterHandle`/`mapResponse`/
`onError`), plugins, macros, the Sucrose static analyzer. fractal's "everything is a
`(input) => output`" surface is materially smaller and more uniform than either.

**4 — Surface/runtime-agnostic (TIE / TIE).**

This criterion's old verdict rested on a claim this doc explicitly retired ("core is
not HTTP-specific" — retired because the then-current `Handler<P>` had `Request`/
`Response` baked into its type). That retirement no longer describes current source:
the current `Handler<I, O> = (input: I) => O` (criterion 3) has zero HTTP coupling,
and it's not just an architectural nicety — it's exercised by five separate
projectors sharing one tree. `packages/cli-api-projector`, `graphql-api-projector`,
`json-rpc-api-projector`, and `mcp-api-projector` all import `Node`/`Handler`/
`isLeaf` directly from `@rhi-zone/fractal-api-tree`/`.../node`, the identical types
`http-api-projector` consumes — verified by grep across each package's `src/`.
`examples/library-api` demonstrates this concretely: the same `api` tree
(`src/tree.ts`) is dispatched over HTTP (`createFetch`) and schema-walked for MCP
(`toTools`) in the same test file.

`@rhi-zone/fractal-api-tree`'s `index.ts` still imports nothing external (verified:
zero `import` statements). `@rhi-zone/fractal-http-api-projector`'s `index.ts`
likewise has no direct `import` statements of its own (it's a pure re-export
surface); `packages/http-api-projector/src/adapter.ts`, the one file with real
runtime touches, is confirmed still excluded from `index.ts`'s re-exports.

**Adapter coverage.** `adapter.ts` ships seven adapters, verified present with these
exact names and shapes today: `serveBun`, `serveNode`, `serveDeno`,
`serveFastlyCompute`, `toCloudflareWorker`, `toVercelEdge`, `toAwsLambdaHandler` —
matching Hono's seven-target list (Node, Deno, Bun, Cloudflare Workers, Fastly
Compute, Vercel Edge, AWS Lambda) one-for-one. Same caveat as before: breadth is
matched, maturity is not — these are verified only by unit tests against each
platform's documented event/response contract, not a live Workers isolate, a real
Lambda invocation, or a Fastly Compute sandbox.

Verdict: tie with Hono, now on a stronger footing than the old "retired" framing
suggested — the core is protocol-agnostic in practice (five live projectors off one
tree type), not just decoupled from HTTP by construction. Adapter breadth still ties
Hono's list; Hono still leads on production mileage per adapter. Slight win over
Elysia's Bun-first stance.

**5 — Barrier to entry (TIE with caveats / TIE with caveats).** A one-endpoint
hello-world:

```ts
import { api, op } from "@rhi-zone/fractal-api-tree";
import { createFetch, http } from "@rhi-zone/fractal-http-api-projector";
const handle = createFetch(api({ hi: op((_: unknown) => "hi", http.get) }));
```

`restCrud`/`crud` give the standard resource shape without hand-writing
`http.moveTo`/`fallback` wiring — a small surface, no decorator, no plugin, no class.

The nuance is at scale, and this part of the evidence is unchanged: Hono's
`hc<AppType>` and Elysia's Eden rely on recursive structural type inference over the
whole app tree, and stock `tsc` still crashes with a stack overflow on Hono's chained
builder variant at 600 routes (verified current: `spike/scale/logs/
stock-tsc-crossval.md` still reports "CRASH: RangeError: Maximum call stack size
exceeded" at 600 and 900 routes, file unchanged). What's changed is which mechanism on
fractal's side is the actual current answer to this: the `AssertExact<RouteUnion>`
linear-type formulation this doc previously cited as the shipping fix is a **retired,
unintegrated research spike** (`spike/drift-guard/`), not current codegen — see
criterion 6. The spike's own instantiation-count numbers (below) still measure a real
formulation and still support the general architectural point (a build-time artifact
beats live structural inference at scale), but they are not a description of what
`generateClientFromSource` (the codegen that's actually shipped, `codegen-source.ts`)
does today, and this doc did not re-measure `generateClientFromSource`'s own
type-instantiation behavior at 900 routes — that specific number is unverified for
current codegen, not assumed equivalent to the spike's f5 formulation.

<!-- FLAG: whether today's generateClientFromSource-produced client.generated.ts
     exhibits the same "stays linear, survives stock tsc at 900 routes" property the
     retired drift-guard spike measured is unverified — nobody has re-run the
     stock-tsc-crossval-style measurement against current codegen output. Treat the
     scale argument as "the architectural principle still holds, the specific number
     needs re-measuring" rather than a settled current fact. -->

**6 — Type safety (TIE — with two updates to the underlying evidence).**

_Server-side:_ input values are typed end-to-end — a handler's `(input: { id: string
})` argument type is exactly what the tree's placement/validation declares, enforced
at compile time. These remain genuine wins over both rivals' raw string-keyed access.

_Response types — the "declared response schema" story has changed._ There is no
`returns(handler, schema)` API anymore (it doesn't exist in current source). Instead,
`packages/api-tree/src/extract.ts`'s `schemaFromReturnType`/`typeRefFromReturnType`
statically infers a handler's output schema from its TypeScript return type via the
compiler API — using an explicit `: ReturnType` annotation when present, falling back
to `checker.getReturnTypeOfSignature` otherwise. This is much closer to Eden's
"infer from the return type" model than the old explicit-declaration requirement was.
It is not a full close of the gap, though:
`packages/http-api-projector/src/codegen.ts` (lines ~610, ~657) still falls back to
`unknown` for the generated client's return type whenever `responseSchema` comes back
`undefined` — this doc did not enumerate every case where inference fails to resolve
a schema, so "narrowed, not eliminated" is the accurate framing, not "closed."

_Drift guard — retired, not current._ The previous doc's evidence here
(`AssertExact<RouteUnion<typeof app>, GenUnion>` embedded in the generated client,
verified via `packages/type-ir/test/drift.test.ts`) describes a **retired prior
design**. Neither `packages/type-ir/test/drift.test.ts` nor `packages/type-ir/src/
cli.ts` exist in current source (verified: both paths return no match). This isn't a
guess — `docs/design/framework-router-codegen.md` documents the correction explicitly:
"the drift-guard mechanism this doc cited doesn't exist in the current codegen...
there is no `AssertExact`/drift-guard code anywhere under
`packages/http-api-projector/src`; the only place `AssertExact` exists is
`spike/drift-guard/` (an un-integrated research spike... not wired into any shipped
codegen path)." Today's generated client carries a `// @generated ... do not edit`
header comment and nothing else self-verifying — no drift check, no watch loop tied
to it.

_Codegen linearity (spike data, still numerically accurate, scope caveat above)._ The
drift-guard spike measured ~243,845 type instantiations at 900 routes for the linear
`RouteUnion` formulation (f5) vs 5,671,272 for the naïve inference (f1) — both numbers
reproduced from `spike/drift-guard/logs/table.md`, unchanged. Stock tsc 6.0.3 fails
f1 at 900 routes and survives on f5, per the same file's "Stock tsc 6.0.3 survival"
table. This remains solid evidence that *a* linear-artifact approach beats *pure
inference* at scale — it is evidence for the general shape of the argument, not proof
about what today's shipped codegen produces (see the FLAG under criterion 5).

Net verdict: still a tie overall — the response-schema gap narrowed (favors fractal
relative to the old doc), but the drift-guard asset the old doc credited fractal with
is retired (favors Elysia/Eden relative to the old doc, since neither side has a
compile-time drift check now). No solid basis to move the criterion off TIE in either
direction from where it was.

**7 — Routing-dispatch performance (TIE / TIE).**

fractal's default router is `mapCharRouter` (compile.ts) — static routes served
from a prebuilt `Map`, dynamic routes through a compiled char-matcher function.
The plain tree-walker (`makeRouterFromRoute`, route.ts — zero build cost,
recursive descent per request) and two other compilers remain available via the
`router` option (`PresetOptions.router`, preset.ts) — all four still present under
the same names, verified against current `compile.ts`:

- `radixMatcher`/`radixRouter` — a character-level radix trie, built once at
  setup; no per-segment allocation, no codegen.
- `compiledCharMatcher`/`compiledCharRouter` — generates a JS function body
  (nested `if`/`startsWith` on `charCodeAt`) and instantiates it via
  `new Function(...)`. Architecturally analogous to Hono's RegExpRouter: both
  compile the whole route table into one generated matcher instead of walking a
  data structure per request.
- `mapMatcher`/`mapCharRouter` — static routes served from a prebuilt
  `Map<pathname, methods>` (one hash lookup); dynamic routes fall through to
  `compiledCharMatcher`, fed only the dynamic subset so the generated function
  is smaller than compiling the full tree.

**Measured** (`packages/http-api-projector/src/route.bench.ts`, 993 routes / 30
dispatch cases; saved run: `packages/http-api-projector/bench-results/
route-bench-2026-07-17T07-29-08-288Z.json`, AMD Ryzen 9 9900X, Bun 1.3.9 —
per-dispatch time = `totalMs * 1e6 / 500_000` iterations). This is the latest of the
three saved runs in `bench-results/` and its numbers were spot-checked against the
raw JSON for this pass (static-hit per-dispatch times, codegen sizes, and per-build
times all reproduce exactly from the raw `dispatch`/`codegenSizes`/`build` fields) —
no newer run exists, so the table is unchanged:

| dispatch case                    | 1. tree-walk | 5. radix trie | 7. compiled fn | 8. Map+compiled hybrid (default) |
| -------------------------------- | ------------ | ------------- | -------------- | -------------------------------- |
| static hit                       | 189ns        | 88ns          | 162ns          | 28ns                             |
| dynamic hit                      | 205ns        | 90ns          | 114ns          | 52ns                             |
| deep hit (5 segs)                | 353ns        | 130ns         | 158ns          | 29ns                             |
| miss (404)                       | 183ns        | 99ns          | 162ns          | 49ns                             |
| wide branch, late (120 siblings) | 224ns        | 166ns         | 436ns          | 28ns                             |
| static path, 8k chars            | 24.6µs       | 9.8µs         | 0.92µs         | 0.57µs                           |

The hybrid (`mapCharRouter`, fractal's default) is fastest on every case
measured — 3-9x the tree-walker on short paths, ~40x on the 8k-char pathological
case. The radix trie is the next-best all-rounder, 1.4-2.7x the tree-walker.
`compiledCharMatcher` alone is not uniformly the fastest: it loses to the radix trie
on wide branching (436ns vs 166ns at "wide late", 120 static siblings under one node)
because compiling the whole route set into one generated function produces a long
branch chain at wide fan-out — the reason `mapCharRouter` partitions statics into a
`Map` first and only feeds the codegen path the dynamic subset (31,476 bytes
generated source for the dynamic-only hybrid vs 256,306 bytes compiling all 993
routes as one function, per `codegenSizes` in the same results file — reproduced
exactly).

Build (setup) cost scales the other way: tree-walk 623µs and radix trie 461µs to
build the 993-route structure, vs 13.3ms for `compiledCharMatcher` (codegen +
`new Function` compile of the full table) and 1.9ms for the hybrid (codegen over
the dynamic subset only) — all four reproduced exactly from the raw `build` field.
The default's own build cost is the second-lowest measured, ahead of both
non-hybrid compilers.

**vs Hono.** Hono's default router is RegExpRouter, which Hono's own docs
(hono.dev/docs/concepts/routers) describe as "the fastest router in the
JavaScript world," compiling the route table into one combined regular expression
plus a `staticMap` for O(1) exact-path lookups. Hono also ships TrieRouter,
PatternRouter, and LinearRouter as explicit opt-ins. No head-to-head timing exists
between fractal and Hono — Hono was not run inside this repo's benchmark harness.

**vs Elysia.** Elysia's default router (Memoirist) stores static routes in a plain
object and dynamic routes in a per-HTTP-method radix tree — structurally the same
Map-plus-dynamic-matcher shape as fractal's `mapCharRouter`, except Elysia's dynamic
half is a radix tree and fractal's is a compiled function. No published Elysia
benchmark numbers were verified against fractal's harness.

Verdict: unchanged from before — architecturally tied or ahead (fractal's benchmarked
hybrid router beats every architecture in its own benchmark, and it's the shipped
default per `PresetOptions.router`, `preset.ts`), but the TIE rests on the absence of
head-to-head timing against either rival's own router.

---

## Where fractal loses or ties today

1. **Response schema still isn't fully automatic.** `codegen.ts` falls back to
   `unknown` for the generated client's response type whenever static return-type
   inference (`extract.ts`) can't resolve a schema. Narrower than the old "must call
   `returns()`" framing (there's no such API anymore, and ordinary cases infer
   automatically), but not a clean parity claim against Eden either — see criterion 6.

2. **No verb sugar at the tree level for a bespoke shape.** `restCrud`/`crud` cover
   the standard 5-op resource; anything else still means hand-composing
   `op(fn, http.get, http.moveTo(".."))` per leaf, which is more verbose than Hono's
   `.get("/path", ...)` or Elysia's chaining. Different shape of ceremony, not zero.

3. **Resource-level status codes are opt-in, not inferred.** A handler that returns a
   value gets 200; getting 201/404/409/etc. means an explicit
   `{ http: { response: { status } } }` meta contribution and/or an `err({kind})`
   return value plus `httpErrors({...})` wired into `createFetch`. Rivals infer some
   of this from context (Elysia's `set.status`, both frameworks' explicit
   `status(...)` helpers) with comparable explicitness — not a clear loss, but not
   automatic either.

4. **No watch mode for the typed client.** `packages/api-tree/src/cli.ts`'s
   `build`/`watch`/`check` regenerate wire-validator modules, not the client;
   `generateClientFromSource` is a one-shot script (~550-600ms per rerun, measured
   2026-08-16). TODO.md tracks this as an open, undecided item, not a planned
   near-term fix.

5. **The drift guard this doc used to credit fractal with doesn't exist in shipped
   code.** `docs/design/framework-router-codegen.md`'s own correction (see criterion
   6) — worth restating here since it directly reverses a claimed advantage the old
   scorecard leaned on.

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
- fractal sources verified this pass:
  - `packages/api-tree/src/node.ts` — `Handler<I, O>`, `op`/`api`/`fallback`/
    `mergeMeta`, `.meta` types (zero `Request`/`Response` references)
  - `packages/api-tree/src/index.ts` — zero `import` statements, confirmed
  - `packages/api-tree/src/extract.ts` — `schemaFromReturnType`/`typeRefFromReturnType`
    (static response-type inference)
  - `packages/http-api-projector/src/index.ts` — current export surface (`http`,
    `httpProjection`, `crud`, `createFetch`, `httpErrors`, `client.ts` exports,
    extensions); no `toFetch`/`validated`/`returns`/`json`/`text`/`status` (confirmed
    absent). `restCrud` is exported from `dx.ts` but **not** re-exported from
    `index.ts` — it needs the `@rhi-zone/fractal-http-api-projector/dx` subpath
    (verified against `package.json`'s `exports` map), which the main example above
    uses accordingly.
  - `packages/http-api-projector/src/dx.ts` — `crud`/`restCrud`/`httpProjection`
  - `packages/http-api-projector/src/dx.test.ts` — `restCrud` end-to-end HTTP test
    (source of the main example's verified behavior)
  - `packages/http-api-projector/src/verbs.ts` — `http.get`/`.post`/`.put`/`.delete`/
    `.moveTo`/`.validate`, `httpVerbBundle`
  - `packages/http-api-projector/src/layers.ts` + `layers.test.ts` — `autoMethodLayer`,
    `[core]` vs `[layer]` 405/HEAD/OPTIONS tests (16 pass)
  - `packages/http-api-projector/src/error-encoder.test.ts` — `httpErrors`/`err`/`ok`/
    `ThrownErrorEncoder` (404/409 mapping, thrown-error 500 default)
  - `packages/http-api-projector/src/route.test.ts` — `applyResponse` custom-status
    test (201 via meta)
  - `packages/http-api-projector/src/preset.ts` — `createFetch` (wires
    `autoMethodLayer` unconditionally), `httpErrors`, `PresetOptions.router` default
    `mapCharRouter`
  - `packages/http-api-projector/src/compile.ts` — `radixMatcher`/`compiledCharMatcher`/
    `mapCharRouter`, all confirmed present
  - `packages/http-api-projector/src/adapter.ts` — 7 adapters confirmed by name:
    `serveBun`/`serveNode`/`serveDeno`/`serveFastlyCompute`/`toCloudflareWorker`/
    `toVercelEdge`/`toAwsLambdaHandler`
  - `packages/http-api-projector/src/codegen.ts` — `generateClient`/
    `generateClientFromNode`, `unknown`-fallback on missing `responseSchema`
  - `packages/http-api-projector/src/route.bench.ts` — benchmark harness, 8
    architectures, 993 routes/30 cases
  - `packages/http-api-projector/bench-results/route-bench-2026-07-17T07-29-08-288Z.json`
    — measured run cited above, spot-checked field-by-field this pass, still current
  - `packages/cli-api-projector/src/*.ts`, `graphql-api-projector/src/project.ts`,
    `json-rpc-api-projector/src/client.ts`, `mcp-api-projector/src/server.ts` — each
    confirmed to import `Node`/`Handler` directly from `@rhi-zone/fractal-api-tree`
    (basis for criterion 4's "shared core" claim)
  - `examples/library-api/src/tree.ts` — current real example (`op`/`api`/`fallback`/
    `http.*`/`applyValidation`/`httpProjection`)
  - `examples/library-api/scripts/generate-client.ts` +
    `examples/library-api/package.json` — one-shot `codegen:client` script, no watch
  - `spike/drift-guard/logs/table.md` — linearity numbers at 99–900 routes
    (reproduced exactly, still an un-integrated spike per below)
  - `spike/scale/logs/stock-tsc-crossval.md` — stock tsc crash at 600/900 routes
    (chained inference), file unchanged
  - `docs/design/framework-router-codegen.md` — explicit correction: drift-guard
    mechanism retired, not present in current codegen
  - `TODO.md` — phase-D CLI rename (`build-wire`/`watch-wire`/`check-wire` →
    `build`/`watch`/`check`); typed-client watch-mode open item and its 2026-08-16
    measurement
  - Confirmed absent (paths checked, no match): `examples/todo-api/`,
    `packages/type-ir/test/drift.test.ts`, `packages/type-ir/src/cli.ts`,
    `packages/http-api-projector/src/index.test.ts`
