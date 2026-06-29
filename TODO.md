# fractal — TODO

> **Handoff & roadmap:** `docs/design/roadmap.md` is the authoritative durable
> handoff — the model, the projection pipeline, design decisions + WHY, gotchas, the
> competitive position, and the prioritized feature backlog with specifics. This file
> is the task list; the roadmap is the context. **Next thing to build: the typed
> `query(...)` combinator (backlog item 1).**

## Migrate to function-core model (post-spine)

The function-core rewrite (`docs/design/function-core-and-projection.md`) landed
as a vertical slice: `packages/core` + `packages/http` are rewritten to the new
model (function category + Result + Kleisli/applicative combinators; the
protocol-neutral D-tree `path`/`param`/`group`/`methods`/`route` + `app`; HTTP
dispatch + `Result`→`Response` encoding), proven by `examples/spine-demo`.

The packages below import the RETIRED `Handler<R>` / `req.ctx` / `.meta` model and
were **fenced out of the active workspace** (removed from root `package.json`
`workspaces`; not deleted) so the new slice builds green. They must be migrated to
the function-core model (or retired) before being re-added:

- `packages/openapi` — OpenAPI projection from `.meta`. Must become an OUTPUT
  projection from inferred types (compiler-API walk), not a `.meta` reader.
- `packages/codegen` — typed client + drift guard from `.meta`. Migrate to the
  types→client / types→OpenAPI build-time projection; drift guard is retired (no
  second source of truth once types are the only truth).
- `packages/client` — typed HTTP client factory. Re-mirror the new handler
  signature exactly.
- `examples/todo-api` — re-author on the D-tree.
- `examples/dogfood` — re-author on the D-tree.

When migrating, also re-point each package's `package.json` `exports`/`main` and
`tsconfig` to match the slice's convention (currently `exports` → `src` directly +
`tsconfig` `paths` to sibling `src`, no build step) or restore a real `dist` build.


## State (verified against repo, 2026-06-05, at handoff snapshot)

Bun-workspaces monorepo, `@rhi-zone` scope. **Entirely local — no remote, not pushed.**

### Package inventory (`packages/` + `examples/`)

| Package | Status |
|---|---|
| `core` (`@rhi-zone/fractal-core`) | Handler model + drift substrate — built & green. 24 tests pass. |
| `http` (`@rhi-zone/fractal-http`) | WHATWG adapter kit + `toFetch`/`validated`/`returns`/observing wrappers — built & green. 40 tests pass. |
| `openapi` (`@rhi-zone/fractal-openapi`) | OpenAPI 3.x projection from `.meta` — built & green. 19 tests pass. |
| `codegen` (`@rhi-zone/fractal-codegen`) | typed client.ts + server.ts + static drift guard + `fractal watch` — built & green. 16 tests pass. |
| `client` (`@rhi-zone/fractal-client`) | Typed HTTP client factory — built & green. 5 tests pass. |
| `examples/todo-api` (`@rhi-zone/fractal-example-todo-api`) | Private example — green. 21 tests pass. |
| `examples/dogfood` (`@rhi-zone/fractal-example-dogfood`) | Generic auth+validation feature slice from the external reference app — green. 22 tests pass. |

Total: **147 tests pass, 0 fail** (`bun test`, 2026-06-05) — core 24, http 40, openapi 19, codegen 16, client 5, todo-api 21, dogfood 22.

**Retired (deleted):** the builder-Router model (`httpRouter`/`RoutingCtx`/`Node<T,U,M>`,
`bearerAuth`, `withValidation`, `respond`/`Outcome`/`ErrorPolicy`); the transport ×
codec × channel architecture (`transport`, `codec-json`, `codec-structured-clone`,
`protocol-correlation`, `channel-*`, `preset-websocket`, `transport-conformance`);
the worker kit (`fractal-worker`); the node-IR–based OpenAPI projection.
These packages implemented the old architecture. All superseded by the Handler model.

**No `worker` package exists.** Any reference to a `worker` package or kit is stale.

---

## Feature backlog (from the dogfood — see roadmap §6 for full specifics)

### 1. Typed `query(...)` combinator — HIGHEST VALUE

Query params have no typed story: read by hand off `new URL(req.url).searchParams`,
never reach OpenAPI/client. Plumbing half-present — `ParameterObject` in
`packages/openapi/src/index.ts` already supports `in: "query"`, but the projection only
emits `in: "path"` (~line 302) and codegen's `paramsType` filters `in === "path"`
(`packages/codegen/src/index.ts` line 138). Open design question: do query params ride
`req.ctx` + the discharge model, or are they read-not-discharged (they don't gate
routing)?

### 2. Error-response modeling

Declare a route's error codes → statuses → shapes → typed client error union + OpenAPI
non-200 responses. Today only the `returns(...)` 200 shape is typed (the response-schema
gap from criterion 6 of `docs/design/vs-hono-elysia.md`).

### 3. Nullable / optional in the schema story

The hand-rolled schema fixture dropped `string | null` → wrong client type. The schema
projection needs nullable/optional fidelity.

### 4. OpenAPI security emission

`withAuth` already stamps an inert `ProvideMeta.security` hint (`{ scheme: key }`) that no
projection reads. Emit `securitySchemes` + per-operation `security`. Then scoped authz
(beyond binary 401).

### 5. Minor — param-clone non-bleed regression test

`param("id", inner)` binds the captured value onto a CLONE of the request (via
`withSegments`/`paramRT` in `packages/core/src/index.ts`), so a sibling `choice` alt
sees no leaked `ctx` param. Structurally guaranteed and tested indirectly via
choice-correctness (`packages/http/src/index.test.ts`), but no test EXPLICITLY asserts
the clone mechanism. Add one to `packages/core/src/index.test.ts`.

---

## Done since the original handoff (no longer open)

- **Dogfood slice** — a generic auth+validation feature slice from the external reference
  app is ported in `examples/dogfood` (`example(dogfood): port a real auth+validation feature slice to validate the framework`).
- **Middleware / auth in the new model** — `provide`/`withAuth` (ctx-discharge) and the
  observing wrappers `logger`/`cors`/`errorBoundary` ship in core/http (`feat(core,http): unify req.ctx bag; middleware/auth as ctx-discharge (provide/withAuth); observing wrappers (logger/cors)`).

---

## PUBLISH (after backlog matures)

- Create `github.com/rhi-zone/fractal`, push, set pages/topics/homepage.
- Ecosystem docs-sync in `~/git/rhizone/github-io` — 7 touchpoints:
  1. `docs/about.md`
  2. `README.md`
  3. `docs/.vitepress/config.ts`
  4. `docs/index.md`
  5. `docs/projects/index.md`
  6. NEW `docs/projects/fractal.md`
  7. `~/git/rhizone/profile/profile/README.md`

## Deferred (build when needed)

### WebSocket / MCP / CLI surface kits

The `Handler<R>` model is surface-agnostic at the core level. Additional transport
kits (WS, MCP, CLI) would follow the same pattern: a kit package that wraps core
combinators with a surface-specific entry point. No design work started.

### Reactivity / streaming substrate

SSE is already supported (`sse()` in `@rhi-zone/fractal-http`). Live queries and
reactive client bindings require a reactive client library to exist first.

---

## Pointers

- Commit history: `git log --oneline` in this repo
- **Roadmap / handoff: `docs/design/roadmap.md`** (model, decisions, backlog)
- Handler model design: `docs/design/handler-model.md`
- Scorecard vs Hono/Elysia: `docs/design/vs-hono-elysia.md`
- Ecosystem design principles: `~/git/rhizone/github-io/docs/decisions/throughlines.md`
- Scale data: `spike/scale/logs/`, `spike/drift-guard/logs/`
- Optics direction (superseded): `docs/design/optics-direction.md`
