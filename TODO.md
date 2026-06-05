# fractal — TODO

## State (verified against repo, 2026-06-05)

Bun-workspaces monorepo, `@rhi-zone` scope. **Entirely local — no remote, not pushed.**

### Package inventory (`packages/` + `examples/`)

| Package | Status |
|---|---|
| `core` (`@rhi-zone/fractal-core`) | Handler model — built & green. 18 tests pass. |
| `http` (`@rhi-zone/fractal-http`) | WHATWG adapter kit — built & green. 30 tests pass. |
| `openapi` (`@rhi-zone/fractal-openapi`) | OpenAPI 3.x projection from `.meta` — built & green. 16 tests pass. |
| `codegen` (`@rhi-zone/fractal-codegen`) | typed client.ts + server.ts generation + `fractal watch` — built & green. 15 tests pass. |
| `client` (`@rhi-zone/fractal-client`) | Typed HTTP client factory — built & green. 5 tests pass. |
| `examples/todo-api` (`@rhi-zone/fractal-example-todo-api`) | Private example — green. 16 tests pass. |

Total: **100 tests pass, 0 fail** (`bun run test`, 2026-06-05).

**Retired (deleted):** the builder-Router model (`httpRouter`/`RoutingCtx`/`Node<T,U,M>`,
`bearerAuth`, `withValidation`, `respond`/`Outcome`/`ErrorPolicy`); the transport ×
codec × channel architecture (`transport`, `codec-json`, `codec-structured-clone`,
`protocol-correlation`, `channel-*`, `preset-websocket`, `transport-conformance`);
the worker kit (`fractal-worker`); the node-IR–based OpenAPI projection.
These packages implemented the old architecture. All superseded by the Handler model.

**No `worker` package exists.** Any reference to a `worker` package or kit is stale.

---

## Remaining work

### 1. DOGFOOD — usable-before-publish gate (highest priority)

Port one small, representative slice of **the reference consumer app (private)**
to fractal end-to-end: a few real endpoints, an auth check, input validation, a
domain call. Compare against its current backend. Surface gaps (missing capabilities,
ergonomic friction, type holes).

**NON-INVASIVE** — build a parallel proof; do NOT modify the app's working backend.

### 2. Response schema gap — declared `returns(...)` required for typed client responses

Routes without `returns(handler, schema)` produce `unknown` response types in the
generated client. Elysia's Eden infers response types from return annotations
automatically (no separate declaration). This is a real ergonomic gap exposed in
criterion 6 of `docs/design/vs-hono-elysia.md`. No fix designed yet.

### 3. Param-clone non-bleed invariant — not explicitly committed as a test

`spike/adversarial/C/probes.test.ts` tests 1a/1b/1c assert that `param("id", inner)`
binds the captured value onto a CLONE of the request (new Request via `withSegments`),
so a sibling `choice` alt receives the original request with no leaked `params.id`.
This invariant is structurally guaranteed by `paramRT` in `packages/core/src/index.ts`
(uses `withSegments` → `new Request(url, req)`) and the dispatch consequence
(choice correctness) is tested in `packages/http/src/index.test.ts` (C-F1 suite),
but there is no committed test that EXPLICITLY asserts the param-clone mechanism.
Worth adding to `packages/core/src/index.test.ts` if the invariant ever needs
direct regression coverage.

### 4. Middleware / auth helpers — retired with no replacement

The builder model's `bearerAuth`, `cors`, `logger`, `etag` helpers are deleted.
No replacement middleware stdlib exists in the current model. Handlers that need
auth or CORS must implement it inline or as a plain wrapper function. This is a real
barrier for production use; no design exists yet.

### 4. PUBLISH (after dogfood passes)

- Create `github.com/rhi-zone/fractal`, push, set pages/topics/homepage.
- Ecosystem docs-sync in `~/git/rhizone/github-io` — 7 touchpoints:
  1. `docs/about.md`
  2. `README.md`
  3. `docs/.vitepress/config.ts`
  4. `docs/index.md`
  5. `docs/projects/index.md`
  6. NEW `docs/projects/fractal.md`
  7. `~/git/rhizone/profile/profile/README.md`

### 5. WebSocket / MCP / CLI surface kits (deferred — build when needed)

The `Handler<P>` model is surface-agnostic at the core level. Additional transport
kits (WS, MCP, CLI) would follow the same pattern: a kit package that wraps core
combinators with a surface-specific entry point. No design work started.

### 6. Reactivity / streaming substrate (deferred)

SSE is already supported (`sse()` in `@rhi-zone/fractal-http`). Live queries and
reactive client bindings require a reactive client library to exist first.

---

## Pointers

- Commit history: `git log --oneline` in this repo
- Handler model design: `docs/design/handler-model.md`
- Scorecard vs Hono/Elysia: `docs/design/vs-hono-elysia.md`
- Ecosystem design principles: `~/git/rhizone/github-io/docs/decisions/throughlines.md`
- Scale data: `spike/scale/logs/`, `spike/drift-guard/logs/`
- Optics direction (superseded): `docs/design/optics-direction.md`
