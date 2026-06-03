# Handler model — the library-first framework

## Status

Implemented in `packages/core` (`@rhi-zone/fractal-core`) and `packages/http`
(`@rhi-zone/fractal-http`), verified by typecheck + test + build. This document
describes the CURRENT model.

It **supersedes** the earlier dispatch-`Node` / projection design (the
`Pass`/`choice`/`path`/`methods`/`route` combinator algebra, `toOpenApi`,
`ClientOf<N>`, the in-process/HTTP `Transport` proxy). That model — and any
`optics-direction.md` / dispatch-Node content referencing it — is **retired**.
The `worker` / `openapi` / `client` packages are not part of this model; they
are **deferred** as possible future adapters / meta-walkers (see Retired &
deferred), not forbidden.

---

## Shape

Two packages. The split is the load-bearing invariant: **core is surface- and
runtime-agnostic**, http is the WHATWG surface.

| Package | Contents |
|---|---|
| `@rhi-zone/fractal-core` | `Handler<T,U>`, `compose`, `Node<T,U,M>` + `node`, `StandardSchema` / `InferOutput` (types only), `NoVars`, `RoutingCtx`, `Middleware` / `WithVars`, the `Router` interface + `createRouter` factory. **No `Request`/`Response`, no `URL`, no Bun/Node.** |
| `@rhi-zone/fractal-http` | `HttpCtx`, `httpRouter`, `toHandler` (Router → WHATWG `(Request)=>Response`), `withValidation`, the `Result→Response` rendering layer (`render`/`respond`/`Outcome`/`ErrorPolicy`/`Renderer`), the `json`/`text`/`binary`/`sse`/`notFound` helpers, and `./adapter` (`serveBun`/`serveNode`). |

---

## `Handler` — the fundamental arrow

```ts
type Handler<T, U> = (t: T) => U | Promise<U>
```

A handler is a plain (possibly async) function `T => U`. `compose(a, b)` runs
`a`, feeds its result to `b`. There is no embedded DSL and no closure-hidden
control structure — the handler is just a function; the *structure* lives in the
`Node` meta and the `Router`.

## `Node` — `{ meta, handler }`

```ts
interface Node<T, U, M = unknown> { readonly meta: M; readonly handler: Handler<T, U> }
```

A `Node` pairs reflectable `meta` with an executable `handler`. `meta` is inert
data describing the node (for reflection / future meta-walkers); `handler` is
the callable. `withValidation` produces a `Node` carrying its validator + the
underlying library function in `meta`.

---

## The router — interface + factory (NOT a class)

`createRouter()` returns a value implementing the `Router` interface. It exposes
`route` / `routeNode` / `use` / `mount` / `mountPlain`, a `meta` reflection
array, and `dispatch`.

### Why an interface + factory, not a class — the class-invariance trap

A class with a private field (e.g. `#routes`) makes the class generic
**invariant** in its type parameters. Invariance means `Router<A>` is not
assignable to `Router<B>` even when `A`/`B` would otherwise be compatible —
which forces casts at every `mount`, defeating the typed-context threading. A
plain `interface` + factory keeps the type **structural**: `Router<Ctx, In, Cur,
Result>` threads enriched context through `mount` with **zero casts** at the
call site. (Proven in `spike/linchpins.ts`; this is LINCHPIN 1.)

### Typed context threading — `NoVars` and the `In`/`Cur` two-slot encoding

```ts
interface Router<Ctx extends RoutingCtx, In, Cur, Result> { … }
```

- **`In`** — the vars a caller must supply at `dispatch` (the router's *input*).
- **`Cur`** — the vars currently visible to handlers registered via `route`,
  *widened* by each `use()`. Starts equal to `In`.

`use(mw)` widens `Cur` → `Cur & Extra` (handlers registered after the call see
the enriched vars, **no cast**) but leaves `In` unchanged — the middleware fills
the gap at runtime. `mount(prefix, mw, sub)` requires `sub`'s input vars to be
`Cur & Extra` *statically*; because `Router` is structural, the sub-router slots
in with zero casts.

`NoVars = Record<never, never>` is the base "no required vars" context.
`Record<never, never>` (≡ `{}`), **not** `Record<string, never>`: the latter
requires every key to be `never`, which breaks intersection with any concrete
vars extension; `Record<never, never>` intersects cleanly with any
`Record<string, unknown>`.

`Middleware<Ctx, Vars, Extra, Result>` receives the current ctx and a `next`
that expects the ctx enriched with `Extra`; `WithVars<Ctx, Vars>` re-parameterises
the `vars` slot. The core router reads only `method` / `segments` / `params` and
threads `vars`; a surface supplies the concrete `Ctx` at the `toHandler` boundary.

---

## `withValidation` — library function → node

```ts
function withValidation<Args, Result, V extends StandardSchema<unknown, Args>>(
  fn: (args: Args) => Result | Promise<Result>,
  validator: V & (InferOutput<V> extends Args ? unknown : never),
): ValidatedNode<Args, Result>
```

`Args` is inferred from `fn`; the validator's **output is statically constrained
to equal `Args`** via `& (InferOutput<V> extends Args ? unknown : never)`. A
validator producing the wrong shape is a **compile error** — no manual
annotation, no cast. (LINCHPIN 2, `spike/linchpins.ts`.)

At request time it pulls the lazy body, validates, and on failure returns a
**framework-level 400** (`{ error: "Validation failed", issues }`). This 400 is a
malformed-*request* signal and is **deliberately separate** from the domain error
policy below — validation failure never consults `ErrorPolicy`.

---

## `Result → Response` rendering (general mechanism, user-supplied policy)

A handler may return one of three things; the http layer turns each into a
`Response`. The framework supplies the **mechanism only** — it hardcodes no
error-code→status table.

1. **`Response` passthrough** — a returned `Response` (incl. `sse()` / `binary()`)
   is used as-is.
2. **Plain value → JSON** — any non-Response, non-Outcome value is rendered to
   `200 application/json` by a **swappable `Renderer`** (`(value) => Response`;
   default `jsonRenderer`). Swap it to change the default content-type/serializer.
3. **`Outcome<Ok, Err>` → Response** — a tagged result
   `{ ok: true; value } | { ok: false; error }`. `ok` renders the value via the
   renderer (200); `error` is mapped by a **user-supplied** `ErrorPolicy<Err>`
   `(err) => Response | { status; body? }`.

```ts
type Outcome<Ok, Err> = { ok: true; value: Ok } | { ok: false; error: Err }
type Renderer = (value: unknown) => Response
type ErrorPolicy<Err> = (error: Err) => Response | { status: number; body?: unknown }

function render<Err>(value: unknown, policy: ErrorPolicy<Err>, renderer?: Renderer): Response
function respond<Ctx, Ok, Err, Value>(
  handler: (ctx: Ctx) => Response | Outcome<Ok, Err> | Value | Promise<…>,
  policy: ErrorPolicy<Err>,
  renderer?: Renderer,
): (ctx: Ctx) => Promise<Response>
function withPolicy<Err>(policy: ErrorPolicy<Err>, renderer?: Renderer): /* respond bound to policy */
```

`ok(value)` / `err(error)` construct outcomes. The policy's `Err` is **linked to
the handler's `Outcome` error type** through `respond`'s generics — no cast at
the call site.

**Where the policy is supplied.** Per route: `respond(handler, policy)`.
App/router-level default: `withPolicy(policy)` binds a policy (and optional
renderer) once and returns a `respond`-shaped wrapper to reuse; an individual
route can still call `respond` with a different policy to override. The framework
ships no codes and no `crud()`/config registry — the `switch (error.code)` map
that real consumers (e.g. sample: `APPLICATION_NOT_FOUND`→404,
`INVALID_TRANSITION`→409) hand-write is expressed **user-side** as an
`ErrorPolicy`, proven in `examples/todo-api` and the http tests.

**Validation-400 vs domain policy.** They are separate layers.
`withValidation`'s 400 is a framework malformed-request response and never
invokes `ErrorPolicy`. Domain failures flow through `Outcome.error` → the user's
policy. A route can use both: validate the body (400 on malformed input), then
the validated `fn` returns an `Outcome` whose errors map through the policy.

---

## The http layer — WHATWG `Request => Response`, thin runtime adapters

`toHandler(router)` returns `(req: Request) => Promise<Response>`: it splits the
path into segments, builds an `HttpCtx` (raw `query: URLSearchParams`, raw
`headers: Headers`, a lazy `body()` thunk pulled at most once, the underlying
`request` escape hatch), dispatches, and maps a top-level no-match to `notFound()`.
Query and headers are **raw by default** — no capture combinator.

Streaming (`sse`) and binary (`binary`) are ordinary `Response` bodies — no
special framework support. The **only** runtime touch lives in `./adapter`:
`serveBun` (Bun) and `serveNode` (a thin `node:http` shim adapting req/res to
WHATWG). The core http module imports neither, staying runtime-agnostic.

### Surface / runtime agnosticism

- **Core** has no HTTP and no runtime. A non-HTTP surface (CLI, IPC, …) supplies
  its own `RoutingCtx` extension and its own `Result` type.
- **http** is one surface: it pins `Ctx = HttpCtx`, `Result = Response`, and owns
  the `Result→Response` rendering. Rendering lives here precisely because it
  produces `Response`; core never sees a `Response`.
- **Adapters** bind a WHATWG fetch handler to a concrete runtime; they are the
  only Bun/Node touch.

---

## Retired & deferred

- **Retired (this model replaces it):** the dispatch-`Node` algebra — `Pass`,
  `choice`, `path`, `methods`, `route`, `param`/`query`/`header`/`body` combinators,
  `typed`, `run`/`serve`/`listen`, `NodeMiddleware`/`pipe`, the required-params
  `P`-discharge discipline. Any `optics-direction.md` content describing it is
  **superseded**.
- **Deferred (future, not forbidden):** the `worker` / `openapi` / `client`
  packages. They are candidate future **adapters** (additional surfaces) and
  **meta-walkers** (reflecting `Node.meta` into OpenAPI / a typed client) layered
  on top of the current core — not part of the model as it stands.
