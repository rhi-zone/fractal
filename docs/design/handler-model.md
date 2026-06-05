# Handler model — the library-first framework

## Status

Implemented across five packages: `@rhi-zone/fractal-core`, `@rhi-zone/fractal-http`,
`@rhi-zone/fractal-openapi`, `@rhi-zone/fractal-client`, and `@rhi-zone/fractal-codegen`.
Verified by typecheck + test + build (100 tests pass). This document describes the
CURRENT model.

It **supersedes** the earlier builder-Router / dispatch-Node design (the
`httpRouter`/`RoutingCtx`/`Node<T,U,M>`/`bearerAuth`/`withValidation`/`respond`/
`Outcome`/`ErrorPolicy` model, and any content in this file referencing it). That
model is **retired** — all packages that implemented it are deleted.

---

## Shape

```
@rhi-zone/fractal-core       Handler<P>, combinators, .meta types, drift-guard substrate
@rhi-zone/fractal-http       toFetch, response builders, validated, returns, ./adapter
@rhi-zone/fractal-openapi    toOpenApi — projects an OpenAPI 3.x doc from .meta
@rhi-zone/fractal-codegen    generate — emits typed client.ts + server.ts from the doc
                             fractal watch — dev-loop file watcher (regenerate on save)
@rhi-zone/fractal-client     typed HTTP client factory (consumes generated client.ts)
```

The load-bearing split: **core is surface-agnostic**; http is the WHATWG surface.
Core imports nothing — no `Request`/`Response`, no Bun, no Node (verified:
`packages/core/src/index.ts` has no external imports). `Request`/`Response` enter at
`@rhi-zone/fractal-http`, which also imports nothing from Bun or Node (`./adapter`
is the sole runtime touch and is not imported by `index.ts`).

Note: `Handler<P>` takes a `Request & { params: P }` argument — WHATWG `Request` is
in the type. The framework is **runtime-agnostic** (runs on Bun, Node, any WHATWG
environment) but is HTTP/fetch-surface-specific by design.

---

## `Handler<P>` — the one framework type

```ts
type Handler<P = {}> = (req: Request & { params: P }) =>
  Response | undefined | Promise<Response | undefined>
```

A handler is a plain function from a typed request to an optional Response.
`undefined` means "not mine — pass to the next handler". A plain
`(req: Request) => Response` is contravariantly assignable to `Handler<P>` for any
`P` — a vanilla web handler IS a `Handler`.

`P` captures the dynamic path params the handler requires. `param("id", inner)`
discharges the `id` key from `P`, advancing the URL past the segment and binding the
value into `req.params.id`. `toFetch` requires `Handler<{}>` (all params discharged)
as the root — an undischarged param is a compile error at the `toFetch` call site.

---

## Combinators — plain functions returning `Handler`

All combinators live in `@rhi-zone/fractal-core` and return a `Reflected<M, P>` (a
`Handler<P>` with an inert `.meta` sidecar). The runtime behavior is pure
`(req) => Response | undefined`; `.meta` is never read on the dispatch path.

| Combinator | Runtime behavior | Meta tag |
|---|---|---|
| `methods(table)` | Dispatch by verb when path is fully consumed; pass on verb miss | `"methods"` |
| `path(record)` | Dispatch on next literal path segment; pass if absent | `"path"` |
| `mount(prefix, inner)` | Alias for single-key `path` | `"path"` (desugars) |
| `param(name, inner)` | Read next segment, bind into `req.params[name]`, advance URL | `"param"` |
| `choice(...alts)` | Try each alt in order; first non-undefined wins | `"choice"` |

`methods` PASSES on a verb miss (returns `undefined`) — it never emits 405.
HTTP correctness (405 + Allow, auto-HEAD, OPTIONS, 404 vs 405) is a **projection**
computed by `toFetch` from `.meta` after dispatch returns `undefined`. This makes
correctness compositional: `Allow` is the union of verbs across every branch
matching the request path, including cross-`choice` and cross-`mount` cases.

---

## HTTP correctness projection — `toFetch`

`toFetch(app: Handler<{}>): (req: Request) => Promise<Response>` is the WHATWG
entry point. It wraps the handler to:

1. Dispatch the request through the combinator tree.
2. If dispatch returns `undefined`, walk `.meta` via `routeTable` to check whether
   any route matches the path but not the verb.
   - Path matched, verb not in Allow set → **405** + `Allow` header (union of all
     matching routes' verbs, plus HEAD if GET present, plus OPTIONS).
   - No path match → **404**.
3. If dispatch returns a Response, pass it through.
4. HEAD: re-run as GET, strip the body.
5. OPTIONS: 204 + Allow (without dispatching).

---

## Body validation — `validated` and `returns`

```ts
// @rhi-zone/fractal-http
validated(schema: StandardSchemaV1, fn: (value, req) => Response | undefined): ValidatedHandler<I>
returns(handler: Handler, outSchema): ReturnsHandler<O>
```

`validated(schema, fn)` parses the request body as JSON, validates it against
`schema`, and calls `fn` with the typed value. On failure: `400 VALIDATION`. On
malformed JSON: `400 INVALID_JSON`. The schema's output type is the `fn` argument
type — a schema producing the wrong shape is a compile error.

`returns(handler, outSchema)` stamps an inert `__schema.output` onto the handler.
The OpenAPI projection and codegen read this as the response schema; it does NOT
affect runtime dispatch. `validated` + `returns` can be composed in either order;
the second call merges into `__schema` rather than overwriting (verified:
`packages/http/src/index.test.ts`, "validated + returns __schema merge" suite).

---

## OpenAPI + codegen pipeline

```
app (Reflected<M>)
  → toOpenApi(app, info)        @rhi-zone/fractal-openapi
  → generate(doc, opts)         @rhi-zone/fractal-codegen
  → client.ts + server.ts
```

`toOpenApi` walks `.meta` to project an OpenAPI 3.x document. `generate` emits:
- `client.ts` — typed API client factory + `GenUnion` + `AssertExact` drift guard.
- `server.ts` — per-route `Handler<P>` type aliases (e.g. `GetTodosId = Handler<{id: string}>`).

The drift guard embedded in `client.ts` is `AssertExact<RouteUnion<typeof app>, GenUnion>`,
which is a `tsc` error if the app's route structure diverges from the generated union.
Verified: `packages/codegen/test/drift.test.ts` — planted drift (added route, changed
body shape) fails on both tsgo and stock tsc with a `__drift__` identifier in the error.

`fractal watch <app-module> --out <dir>` (implemented in `packages/codegen/src/cli.ts`)
watches the source directory for changes, debounces them, and regenerates
`client.ts`/`server.ts` on every save — folding the codegen step into the dev loop.

---

## Example

The canonical working example is `examples/todo-api/src/app.ts` — a CRUD-ish
`/todos` resource with GET list, POST validated create (201), GET one (404 if
unknown), POST `/{id}/done`, SSE, and binary endpoints. 16 tests pass. The generated
`client.ts` and `server.ts` are committed next to it; the drift guard keeps them
in sync.

---

## Retired

The following are **retired** — removed from the codebase, not deferred:

- Builder-Router model: `httpRouter`, `RoutingCtx`, `Node<T,U,M>`, `bearerAuth`,
  `withValidation` (the builder variant), `respond`, `Outcome`, `ErrorPolicy`.
- Transport × codec × channel architecture: `transport`, `codec-json`,
  `codec-structured-clone`, `protocol-correlation`, `channel-*`, `preset-websocket`,
  `transport-conformance`.
- Worker kit: `fractal-worker`, `procedure`, `field`, `dispatch`.
- Node IR–based OpenAPI projection (superseded by the `.meta`-walk approach).
- "Runtime client walker" (superseded by static codegen from the OpenAPI doc).
