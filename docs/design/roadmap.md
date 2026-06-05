# fractal — roadmap & handoff

Durable design state + prioritized backlog for a fresh session. Every claim here was
verified against the code/commits at the handoff snapshot (`docs: handoff roadmap — model, decisions, and prioritized feature backlog`, 2026-06-05); where a figure could
not be verified it was dropped rather than guessed. Companion docs:
`docs/design/handler-model.md` (model rationale), `docs/design/vs-hono-elysia.md`
(competitive scorecard), `docs/design/scale.md` (scale data), `TODO.md` (task list).

A real external reference app (Hono/Bun/Valibot) was used for dogfooding; it is
referred to here only as "the external reference app" and is never named or pathed in
this repo by design.

---

## 1. The model

The ONLY framework type:

```ts
type Handler<R = {}> = (req: Request & { ctx: R }) =>
  Response | undefined | Promise<Response | undefined>;
```

It is literally `(Request) => Response` (the WHATWG standard) — NOT a custom `Ctx`/`Req`
object. `R` is the set of `req.ctx` keys a handler REQUIRES. A `ctx` FIELD on the
standard Request (itty-router pattern) is fine; a separate `Ctx` TYPE is not — that is
the point. Because `Request & { ctx: R }` is a subtype of `Request`, a plain
`(req: Request) => Response` is contravariantly assignable to any `Handler<R>` — a plain
web handler IS a Handler. `undefined` means "not mine — pass, try next".

One `req.ctx` bag carries BOTH captured path params AND middleware-injected vars. Two
discharge mechanisms fill it; the TYPE `R` reads both alike; only the projections split
them by meta source.

### Combinators (all return a Handler carrying inert `.meta`)

| Combinator | Role | Discharge |
|---|---|---|
| `path({seg: h})` | literal-segment dispatch | — |
| `methods({GET: h})` | verb dispatch (literal-verb inference) | — |
| `choice(...alts)` | first-match dispatch | — |
| `param(name, inner)` | capture a typed PATH-PARAM | discharges a path-param key via `Omit<Q, name>` |
| `mount(prefix, inner)` | alias of single-key `path` | — |
| `provide(key, produce, inner)` | inject a server-internal VAR | discharges a var key via `Omit<Q, key>` |
| `withAuth(authenticate, inner)` | `provide` specialized to `ctx.user` | discharges `user` |
| `logger` / `cors` / `errorBoundary` | observing wrappers | plain `Handler<R> → Handler<R>` |

`param` also has a 3-arg overload `param(name, codec, inner)` carrying a Standard Schema
for the segment (type-only; std does not decode). `withAuth` defaults the key to `"user"`
and also accepts an explicit `(key, authenticate, inner)` form.

### toFetch — the discharge gate + HTTP-correctness projection

`toFetch(app)` (in `@rhi-zone/fractal-http`) requires `Handler<{}>` — every param AND var
must be discharged, else a compile error. It PROJECTS HTTP correctness from `.meta` AFTER
dispatch returns `undefined`: 405 + `Allow`, auto-HEAD-from-GET, OPTIONS (204 + Allow),
and the 404-vs-405 distinction. Dispatch combinators stay meta-free; only the projections
(`toFetch`, `toOpenApi`, codegen) read `.meta`.

### Param-vs-var meta split (load-bearing)

- `ParamMeta` keys are PATH-PARAMS = API surface → client call args + OpenAPI `parameters`.
- `ProvideMeta` keys are VARS = server-internal → NOT in client signature/params.

The route-table walk (`walkMeta` in `packages/core/src/index.ts`) appends a pattern
segment for `path`/`param` but walks straight THROUGH `provide`. **Adding `withAuth` to a
route does not change its client signature.**

---

## 2. The projection pipeline (code-first)

```
handler tree (truth: typeof app, .meta)
   → toOpenApi  (packages/openapi, walks .meta)        → OpenAPI 3.x doc
   → codegen generate() (packages/codegen)             → client.ts + server.ts + DRIFT GUARD
```

- `toOpenApi` projects an OpenAPI 3.x doc from `.meta`.
- `generate()` emits a typed client (`ApiClient` interface + `createClient` factory),
  server handler aliases, and a STATIC DRIFT GUARD.
- The drift guard is one line:
  `export const _drift: Assert<AssertExact<RouteUnion<typeof app>, GenUnion>> = true;`
  — an exact union-vs-union equality (substrate in `packages/core/src/drift.ts`).
  `RouteUnion<typeof app>` re-derives the route-entry union from the source `.meta`;
  `GenUnion` is the union the generated client carries. Any drift — added / removed /
  renamed route, changed param / body / response shape — makes the two unions differ,
  `AssertExact` resolves to a `{ __drift__: … }` error, and `= true` fails to typecheck.
  It is LINEAR (a union stays one pass; merging into a keyed object would be O(N²)).
- CLI: `fractal generate` / `fractal watch` (`packages/codegen/src/cli.ts`). Generated
  files are committed and self-verifying via the drift guard. Generated depends on source
  (`import type` only — no cycle); source never imports generated.

---

## 3. Key design decisions + WHY

**Handler is literally `(Request) => Response`, not a custom Ctx/Req.** A `ctx` FIELD on
the standard Request is allowed (itty-router); a separate Ctx TYPE is not. That is the
point of the model — web-standard handler, typed only by the keys it needs.

**Codegen, not in-TS inference, for the client.** The in-TS `.meta` walk (`Client<App>`)
was O(N²) and crashed stock tsc — this is the Hono `hc` / Elysia Eden failure mode.
Verified in `docs/design/scale.md`: the coupled in-TS client (variant A) is quadratic and
**stock tsc 6.0.3 crashes with RangeError at N=600/900**; the decoupled concrete client is
~linear (≈38× fewer instantiations than A at 900, and A costs ≈40× B's instantiations at
900 — the excess is accumulation + `ClientOf`). Codegen emits plain concrete types, so the
in-TS `Client<App>` was retired.

**The trilemma (record it).** Bare `(Request) => Response` + compositional
independent-value handlers + statically-typed captured params CANNOT all hold — the only
typed input slot is a Request the handler did not build. Resolution: parameterize the
handler over its ctx (`Handler<R>` over `Request & { ctx: R }`); a plain
`(req: Request) => Response` stays assignable by contravariance; params/vars are
discharged by `param`/`provide` via `Omit`; `toFetch` requires `Handler<{}>`.

**`methods` infers LITERAL verbs.** It takes `const T` (the table) as the sole inference
site and extracts the verb set + ctx obligation from it — NOT an explicit `<P>` type-arg,
which erased the verbs. The ctx obligation `R` is extracted from the handlers via
`CtxOf<T>` (union-to-intersection of each handler's declared `ctx`).

**`AssertExact` = the canonical deferred-conditional `Equals`** (function-wrapper trick)
for exact type equality — catches add/remove/rename/shape drift in both directions.

**`mount` collapsed into `path`** (single-key `PathMeta`; no separate `PrefixMeta`), so
every projection handles one fewer case.

**405/HEAD/OPTIONS are a `.meta` projection in `toFetch`, not emitted by `methods`.** A
405 mid-dispatch would short-circuit `choice` and hide a later alt; an `Allow` from one
table cannot see sibling alts / mounts at the same path. The projection aggregates verbs
across EVERY route matching the path, so cross-`choice` / cross-`mount` `Allow` is correct
without a non-compositional in-dispatch signal.

---

## 4. Known gotchas / limitations (verified)

- **Bare inline param-reading infers `any`.** A `req => req.ctx.id` arrow has `req`
  contextually typed by the table bound, so `req.ctx` is `any` and the inferred obligation
  collapses (the contravariant-infer limit, documented at `CtxOf` in core). Param-reading
  handlers must ANNOTATE the ctx type (`(req: Request & { ctx: { id: string } }) => …`) or
  use the generated server alias.
- **Typed responses require a declared `returns(schema)`.** Without it the generated
  client response type is `unknown`. Elysia's Eden infers responses from return
  annotations — this is an honest gap (criterion 6 in vs-hono-elysia).
- **No built-in auth-cred passing in the in-process typed client.** Passing auth creds
  needs a custom transport that injects headers (`http(baseUrl, fetchImpl)` /
  `inProcess(app)` are the two stock transports). Document this for consumers.
- **Body teeing on segment-advance.** `withSegments` (and `provide`) tee the body via
  `req.clone()` so sibling `param`/`provide` alts under one `choice` don't disturb a body
  the matching leaf must read. Perf note: bodied requests tee; bodiless GET passes the
  source directly and never clones.

---

## 5. Competitive position (honest)

From `docs/design/vs-hono-elysia.md` (six criteria vs Hono 4.x and Elysia):

| # | Criterion | vs Hono | vs Elysia |
|---|---|---|---|
| 1 | Elegance / less ceremony | TIE | TIE |
| 2 | More correct HTTP semantics | **WIN** | **WIN** |
| 3 | Tighter / more uniform core | **WIN** | **WIN** |
| 4 | Surface/runtime-agnostic core | TIE (deliberate) | TIE |
| 5 | Lower barrier to entry | TIE (caveats at scale) | TIE |
| 6 | Type safety | TIE (robustness/scale edge) | TIE (declared-response caveat) |

Wins HTTP-correctness + tiny-core; ties elegance/agnosticism/barrier/type-safety, with a
scale/robustness edge from codegen + the drift guard. It is NOT yet unilaterally better
than Hono + Elysia combined — the backlog below is the path there.

---

## 6. Prioritized feature backlog (from the dogfood)

### 1. Typed `query(...)` combinator — HIGHEST VALUE
Query params have no typed story today: they are read by hand off
`new URL(req.url).searchParams` and never reach OpenAPI or the client. Plumbing is
half-present: `ParameterObject` in `packages/openapi/src/index.ts` already supports
`in: "query"`, but the projection only emits `in: "path"` (around line 302), and codegen's
`paramsType` filters to `in === "path"` (`packages/codegen/src/index.ts` line 138).
**Open design question:** query params are optional/typed/coerced — how do they ride
`req.ctx` and the discharge model? Or are they read-not-discharged, since they don't gate
routing? (Path params gate routing; query params don't.)

### 2. Error-response modeling
Let a route declare its error codes → statuses → shapes, projecting to a typed client
error union + OpenAPI non-200 responses. Today only the `returns(...)` 200 shape is typed.

### 3. Nullable / optional in the schema story
The hand-rolled schema fixture dropped `string | null` → wrong client type. The schema
projection needs nullable/optional fidelity.

### 4. OpenAPI security emission
`withAuth` already stamps an inert `ProvideMeta.security` hint (`{ scheme: key }`) that no
projection reads. Emit `securitySchemes` + per-operation `security` from it. Then build
scoped authz (beyond binary 401).

### 5. Minor — param-clone non-bleed regression test
The `param` clone-non-bleed invariant (a sibling `choice` alt must not see a leaked
`ctx` param) is structurally guaranteed by `paramRT`/`withSegments` and tested indirectly
via choice-correctness, but has no explicit committed regression test in
`packages/core/src/index.test.ts`. Commit one.

---

## 7. Project constraints (restate)

- **master-linear** — don't branch unless asked.
- **No path deps** in package manifests.
- **No `--no-verify`** — fix the issue or the hook.
- **Control surface stays self-contained / in-repo** — versioned, diffable.
- **Commit completed work the same turn it finishes.**
- **Codegen examples + committed docs stay generic** (name-scrub: never name or path the
  external reference app in committed files).

---

## 8. Current state (verified at handoff snapshot, 2026-06-05)

- Packages: `core`, `http`, `client`, `openapi`, `codegen`.
- Examples: `todo-api`, `dogfood`.
- Tests: **147 pass, 0 fail** (`bun test`, 2026-06-05) — core 24, http 40, openapi 19,
  codegen 16, client 5, todo-api 21, dogfood 22.
- `spike/` (std, iron, drift-guard, methods-fix, scale, composable, …) is reference
  history, not shipped.
- Entirely local — no remote, not pushed.
