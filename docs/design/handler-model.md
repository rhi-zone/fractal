# Handler\<P\> — core model

## Status

Implemented in `packages/core` + `packages/http` + `packages/worker`, verified by build + typecheck + test. Supersedes the dispatch/verb-binding exploration in [optics-direction.md](./optics-direction.md).

---

## Packages

| Package | Contents |
|---|---|
| `@rhi-zone/fractal-core` | `Pass`/`pass`, `Req<P>`, `Handler<P,Res>`, `Middleware`, `choice`, `pipe`, `capture` (generic in V), `typed` (sync combinator), `leaf`, `run` |
| `@rhi-zone/fractal-http` | `path`, `methods` (with path-exhaustion guard), `param`/`query`/`header` (V=string, via core `capture`), `body` (lazy thunk handle), `validate` (sync combinator / async per-request handler), `serve`, HTTP `Req` shape |
| `@rhi-zone/fractal-worker` | `procedure`, `field` (generic V, eager already-typed value), `dispatch`, worker `Req` shape |

---

## The one type

```ts
type Pass = typeof PASS                                           // unique symbol sentinel
type Req<P extends Record<string, unknown> = Record<string, never>> = { params: P } & Record<string, unknown>
type Handler<P extends Record<string, unknown> = Record<string, never>, Res = unknown> =
  (req: Req<P>) => Promise<Res | Pass>
```

`P` is the set of params the handler **requires** from above. Default `Record<string,never>` = needs nothing. `Pass` means "not me — try the next handler." Every combinator and every middleware is this same type:

- A leaf handler: `Handler<P, Res>`
- A middleware: `(inner: Handler<P, Res>) => Handler<P, Res>`
- A mounting combinator: takes `Handler` children, returns `Handler`

There is no second handler shape, no route-object wrapper, no middleware interface distinct from handler. Nesting is value placement.

---

## Core combinators (`@rhi-zone/fractal-core`)

### `leaf`

```ts
function leaf<P extends Record<string, unknown>, Res>(
  fn: (req: Req<P>) => Promise<Res>,
): Handler<P, Res>
```

Wraps a plain async function into a `Handler`. The only place application logic lives.

### `choice`

```ts
function choice<P extends Record<string, unknown>, Res>(
  ...hs: Handler<P, Res>[]
): Handler<P, Res>
```

Tries handlers in order. Returns the first result that is not `Pass`. `choice()` with no arguments is the zero (always passes).

### `capture`

```ts
function capture<K extends string, V, C extends Record<K, V>, Res>(
  name: K,
  read: (req: Req<Omit<C, K>>) => V | Pass,
  child: Handler<C, Res>,
): Handler<Omit<C, K>, Res>
```

The generic capture primitive. `V` is **free** — each kit pins it to whatever the transport delivers. HTTP kits pin `V=string`; Worker kits use `V=number`, `V=object`, etc. Kit-specific combinators (`param`, `query`, `header`, `field`) are thin wrappers that supply the `read` function and pin `V`.

### `typed`

```ts
function typed<Out extends Record<string, unknown>, P extends Record<string, unknown>, Res>(
  parse: (raw: Record<string, unknown>) => Out,
): (inner: Handler<P & Out, Res>) => Handler<P, Res>
```

**Sync, eager** refinement of values already in the params bag. Takes a parser that produces `Out` from raw params, enriches `req.params`, and calls `inner`. Discharges `Out` from inner's requirements. Used to bridge string→number in the HTTP kit (where `param` delivers strings and a typed leaf wants numbers).

Contrast with `validate()` in the HTTP kit which is **async, lazy** over the body facet.

### `pipe`

```ts
function pipe<P extends Record<string, unknown>, Res>(
  ...mws: Middleware<P, Res>[]
): Middleware<P, Res>
```

Compose middleware via `reduceRight`. `pipe(mw1, mw2)(h) = mw1(mw2(h))` — `mw1` is outermost and runs first.

### `run`

```ts
function run<Res>(
  h: Handler<Record<string, never>, Res>,
  req: Req<Record<string, never>>,
): Promise<Res | null>
```

Accepts only a fully-discharged handler. A handler with any remaining param requirement is a compile error at `run`. Maps `Pass` → `null`.

---

## HTTP kit combinators (`@rhi-zone/fractal-http`)

### `path`

Dispatches on the first segment of `req.path`, consumes it, passes the tail to the matched child. Returns `Pass` if no segment or no match.

### `methods`

```ts
function methods<P, Res>(table: Record<string, Handler<P, Res>>): Handler<P, Res>
```

Dispatches on `req.method`. **Path-exhaustion guard**: returns `Pass` if `req.path` is non-empty — `methods` only fires when all path segments have been consumed by enclosing `path` and `param` combinators.

### `param`

```ts
function param<K extends string, C extends Record<K, string>, Res>(
  name: K,
  child: Handler<C, Res>,
): Handler<Omit<C, K>, Res>
```

Captures the next path segment as the string-typed param `name`. V is pinned to `string` via `C extends Record<K, string>`. A child wanting `{ x: number }` cannot be `param`-captured directly — G1 safety: `param('x', leaf<{x:number}>)` is a compile error, verified by `@ts-expect-error` in `packages/http/src/index.ts`.

### `query` / `header`

Same `Omit<C,K>` algebra as `param`. V pinned to `string`. Returns `Pass` if the key is absent.

### `body`

Pulls the lazy body thunk exactly once, makes the resolved value available to the child as `req.body: unknown`. A route that does not include `body()` never triggers the thunk.

### `validate`

**Sync combinator** that returns an async per-request handler. Takes `parse: (unknown) => T | Promise<T>`, wraps a `HandlerWithBody<P,T,Res>`, returns a `HandlerWithBody<P,unknown,Res>` — synchronously. No await at composition time; async work happens per-request. A Standard Schema validator slots in here: `validate(v => schema.parse(v), inner)`.

### `serve`

```ts
function serve<Res>(
  h: Handler<Record<string, never>, Res>,
  req: HttpRequest,
): Promise<HttpResponse<Res>>
```

Splits path, parses query string, wraps the body in a lazy thunk, maps `Pass` → `{ status: 404, body: null }`.

---

## Worker kit combinators (`@rhi-zone/fractal-worker`)

### `procedure`

Dispatches by the `procedure` field on the request. Returns `Pass` if no match. Unlike `path`, does not consume a segment — the full procedure name is matched as-is.

### `field`

```ts
function field<K extends string, V, C extends Record<K, V>, Res>(
  name: K,
  read: (req: Req<Omit<C, K>>) => V | Pass,
  child: Handler<C, Res>,
): Handler<Omit<C, K>, Res>
```

V is **free** — pinned by the child's type requirement. The Worker transport delivers already-typed values (number, object, …) from IPC/shared memory. No `string→T` parse step; no `typed()` needed. This proves that the params bag is generic in value type: non-text transports inject their own types directly.

### `dispatch`

Runs a worker call through a fully-discharged handler. Maps `Pass` → `{ ok: false, result: null, error: "procedure not found" }`.

---

## Required-params discipline

`P` flows structurally through composition. Key properties verified by tests A–I:

**Discharge.** `param('id', child<{id:string}>)` → `Handler<{}>`. The `id` need is satisfied. `run` compiles.

**Partial discharge.** `param('id', child<{tenantId:string, id:string}>)` → `Handler<{tenantId:string}>`. `id` is discharged; `tenantId` remains required and propagates upward. `run` on the partial result errors; a second `param('tenantId', …)` discharges fully.

**Guard.** A leaf with `{id:number}` and no `param` above it is correctly rejected by `run`.

**G1 safety.** `param('x', leaf<{x:number}>)` is a compile error — `{x:number}` does not satisfy `C extends Record<'x',string>`.

**Realistic full chain.** `leaf<{id:number}>` → `typed(parse)(leaf)` = `Handler<{id:string}>` → `param('id', …)` = `Handler<{}>` → `run` compiles.

---

## Protocol agnosticism (tree × kit)

The core — `Handler`/`Req<P>`/`Pass`/`choice`/`typed`/`capture` — is abstract over transport. Protocol-specific combinators live in per-protocol **kits**:

- **HTTP kit** (`fractal-http`): `methods`, `path`, `param`, `query`, `header`, `body`, `validate`, `serve`.
- **Worker kit** (`fractal-worker`): `procedure`, `field`, `dispatch`.
- Future: MCP kit (dispatch by tool name), CLI kit (dispatch by subcommand).

`methods` is HTTP-only by nature. What transfers across protocols: `Handler` + `Middleware` + business logic. The tree never carries HTTP verbs as structural keys; the HTTP kit renders them.

**Server = client.** A client is also a `Handler` — the network call is the bottom handler. Swapping an in-process `Handler` for the network handler is how testing works; no mock infrastructure required.

---

## Known caveat

`param('id', leaf<{}>)` compiles silently. TypeScript's structural subtyping lets `{}` satisfy `C extends Record<'id',string>` — an empty object has no contradictions. Accepted: runtime-harmless, ergonomically permissive.

---

## Future items

- **OpenAPI projection** for the new `Route` structure: the `path`/`methods`/`param` tree is walkable data — a future `toOpenApi(handler, info)` projection is structurally possible. Not yet built.
- **Standard Schema validator integration** into `validate`: slots in via `validate(schema['~standard'].validate, inner)`. Not yet built as a package; the integration point is documented.
