# fractal — TODO

## State (verified against repo, 2026-06-02)

Bun-workspaces monorepo, `@rhi-zone` scope, vite + tsgo + vitest/bun-test, normalize,
VitePress docs. **Entirely local — no remote, not pushed.**

### Package inventory (`packages/` + `examples/`)

4 published packages + 1 private example:

| Package | Status |
|---|---|
| `core` (`@rhi-zone/fractal-core`) | Handler model — Built & green. `typed` accepts `StandardSchemaV1`. |
| `http` (`@rhi-zone/fractal-http`) | HTTP kit — Built & green. `validate` accepts `StandardSchemaV1`. |
| `worker` (`@rhi-zone/fractal-worker`) | Worker/in-process kit — Built & green |
| `openapi` (`@rhi-zone/fractal-openapi`) | OpenAPI/JSON-Schema projection — Built & green. Multi-surface projection re-earned. |
| `examples/todo-api` (`@rhi-zone/fractal-example-todo-api`) | Private example — green. Has `generate-openapi` script. |

**Retired (deleted):** `transport`, `codec-json`, `codec-structured-clone`,
`protocol-correlation`, `channel-http`, `channel-websocket`, `channel-worker`,
`channel-stdio`, `preset-websocket`, `transport-conformance`, `standard-schema`.
These packages implemented the transport × codec × channel architecture and
the node-IR-based OpenAPI/JSON-Schema projection. All superseded by the Handler model.

### Build ordering

Root `build` script: `core` first (downstream dep), then `http` + `worker` + `openapi` in parallel.

### What is built

**Handler core (`fractal-core`):**
- `Pass`/`pass` sentinel (unique symbol)
- `Req<P>`, `Handler<P,Res>`, `Middleware<P,Res>`
- `choice`, `pipe`, `capture` (generic in V), `typed` (sync, eager params refinement), `leaf`, `run`
- Full compile-time param-discharge algebra (tests A–I from spike/routing.ts)

**HTTP kit (`fractal-http`):**
- `path` (segment dispatch, consumes segment)
- `methods` (verb dispatch, path-exhaustion guard)
- `param`, `query`, `header` (V=string captures, Omit<C,K> discharge)
- `body` (lazy thunk handle), `validate` (sync combinator / async per-request handler)
- `serve` (HttpRequest → HttpResponse, Pass → 404)
- G1 safety: `param('x', leaf<{x:number}>)` is a compile error (verified)

**Worker kit (`fractal-worker`):**
- `procedure` (dispatch by procedure name)
- `field` (generic V, eager already-typed value — no parse step)
- `dispatch` (WorkerCall → WorkerCallResult, Pass → not-found)

**Intentional test-runner split.** `fractal-http`, `fractal-worker`, and `todo-api`
run `bun test` (via `bun:test` imports). `fractal-core` runs `vitest run`.

---

## Decisions (record to avoid losing context)

- **The Handler model is the architecture.** Protocol-specific combinators (path,
  methods, param, procedure, field) live in per-transport kits over the abstract
  core. The core knows nothing about HTTP verbs, URL paths, or procedure names.

- **V is free in core captures; kits pin it.** HTTP kit pins V=string (text protocol).
  Worker kit delivers pre-typed values directly (V=number, V=object, …).

- **Body is lazy in HTTP.** The body is a consume-once thunk. `body()` pulls it;
  routes without `body()` never trigger a read.

- **`validate` is a sync combinator / async handler.** Building the route tree is
  synchronous; validate() returns immediately and does async work per-request.

- **`typed` is sync and eager over params.** Distinct from `validate` (which is
  async and operates on the body facet). Both are opt-in; neither lives in core.

- **`methods` has the path-exhaustion guard.** Only fires when `path` is empty —
  prevents false matches at non-leaf positions.

- **Runtime floor: Node 20** (nixpkgs non-EOL).

---

## Remaining

### 1. DOGFOOD — usable-before-publish gate (highest priority)

Port one small, representative slice of **the reference consumer app (private)**
to fractal end-to-end: a few real endpoints with auth + input validation + a
real use-case call. Compare against its current imperative HTTP route/middleware
framework backend. Surface gaps (missing capabilities, ergonomic friction, type holes).

**NON-INVASIVE** — build a parallel proof; do NOT modify the app's working backend.

### 2. OpenAPI projection for the Handler model — DONE

`@rhi-zone/fractal-openapi` ships `toOpenApi(node, info)` and `toJsonSchema(node)`.
`typed` and `validate` accept `StandardSchemaV1`; schemas flow into both validation
and the emitted OpenAPI/JSON-Schema via the `jsonSchema` trait. Graceful degradation
to `{}` when the trait is absent or throws.

### 3. Reactivity-as-a-capability (deferred)

Design and build on the streaming substrate: live queries, invalidation, binding
to the reactive client library. Requires a reactive client lib to exist first.

### 4. Node WebSocket and additional transport kits

A WebSocket kit (analogous to the HTTP kit but over WS frames) and/or MCP/CLI kits.
Build when actually needed.

### 5. Build ordering

If the dep graph grows significantly, replace the manual tier script with a
full topological build. Holding fine now.

### 6. PUBLISH (after dogfood passes)

- Create `github.com/rhi-zone/fractal`, push, set pages/topics/homepage.
- Ecosystem docs-sync in `~/git/rhizone/github-io` — 7 touchpoints:
  1. `docs/about.md`
  2. `README.md`
  3. `docs/.vitepress/config.ts`
  4. `docs/index.md`
  5. `docs/projects/index.md`
  6. NEW `docs/projects/fractal.md`
  7. `~/git/rhizone/profile/profile/README.md`
  Reflect the multi-package structure; suggested badges: Semantics + Code
  (matching the nearest sibling in the ecosystem).

---

## Pointers

- Commit history: `git log --oneline` in this repo
- Handler model design: `docs/design/handler-model.md`
- Ecosystem design principles: `~/git/rhizone/github-io/docs/decisions/throughlines.md`
- Node algebra / optics direction (superseded): `docs/design/optics-direction.md`
