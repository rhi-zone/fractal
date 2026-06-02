# Handler\<P\> — core model

## Status

Core type model compiler-verified in tsgo (see `spike/routing.ts`, tests A–I). Runtime not yet implemented. Supersedes the dispatch/verb-binding exploration in [optics-direction.md](./optics-direction.md).

---

## The one type

```ts
type Pass = typeof PASS                                       // unique sentinel
type Req<P> = { path: string[]; method: string; params: P }
type Handler<P = {}, Res = unknown> = (req: Req<P>) => Promise<Res | Pass>
```

`P` is the set of params the handler **requires** from above. Default `{}` = needs nothing. `Pass` means "not me — try the next handler." Every combinator and every middleware is this same type:

- A leaf handler: `Handler<P, Res>`
- A middleware: `(inner: Handler<P, Res>) => Handler<P, Res>`
- A mounting combinator: takes `Handler` children, returns `Handler`

There is no second handler shape, no route-object wrapper, no middleware interface distinct from handler. Nesting is value placement.

---

## Combinators

Exact signatures from `spike/routing.ts` (compiler-verified):

### `leaf`

```ts
function leaf<P = {}, Res = unknown>(
  fn: (req: Req<P>) => Promise<Res>,
): Handler<P, Res>
```

Wraps a plain async function into a `Handler`. The only place application logic lives.

### `methods`

```ts
function methods<P, Res>(
  table: Record<string, Handler<P, Res>>,
): Handler<P, Res>
```

Dispatches on `req.method`. HTTP verbs — including custom ones — are plain string keys. Lives in the HTTP kit, not the core (see [Protocol agnosticism](#protocol-agnosticism-tree--kit) below).

### `path`

```ts
function path<P, Res>(
  table: Record<string, Handler<P, Res>>,
): Handler<P, Res>
```

Dispatches on the first segment of `req.path`, consumes it, and passes the tail to the matched child. One segment at a time: this is what enables splitting a route tree at arbitrary boundaries. Multi-segment matching and a `rest` wildcard are sugar over this primitive.

### `choice`

```ts
function choice<P, Res>(...hs: Handler<P, Res>[]): Handler<P, Res>
```

Tries handlers in order. Returns the first result that is not `Pass`. `choice()` with no arguments is the zero (always passes). This is the fallback spine — `path` and `methods` return `Pass` on no match; `choice` composes their outputs.

### `param`

```ts
function param<K extends string, C extends Record<K, string>, Res>(
  name: K,
  child: Handler<C, Res>,
): Handler<Omit<C, K>, Res>
```

Captures the next path segment as the string-typed param `name`, injects it into `req.params`, and calls `child` with the enriched request.

The encoding warrants explanation. An earlier attempt used `Handler<P & Record<K,string>>` → `Handler<P>` — TypeScript cannot perform intersection-subtraction during inference, so `K` never discharged (confirmed fail in the spike's first run). The correct form infers the child's **full** param requirement `C` (constrained to include `K` as `string`), then returns `Omit<C, K>` — exactly discharging what `param` injects. Tests A, C, E, E-PROPAGATION, F all verify this.

`param` produces only `string`. There is no schema or codec surface in the routing core. A child wanting `{ x: number }` cannot be `param`-captured directly — `number` does not satisfy `C extends Record<K, string>` — so it must go through `typed`. Test G1 verifies this safety property is closed.

### `typed`

```ts
function typed<Out, P = {}, Res = unknown>(
  parse: (raw: Record<string, string>) => Out,
): (inner: Handler<P & Out, Res>) => Handler<P, Res>
```

A typing middleware. Takes a parser that produces `Out` from the raw string params, enriches `req.params`, and calls `inner` with the result. Discharges `Out` from the inner handler's requirements, leaving `P`. This is the intended home for `@rhi-zone/fractal-standard-schema` — the optional typing layer's validator interface, never the core.

### `run`

```ts
function run(h: Handler<{}, any>): void
```

Accepts only a fully-discharged handler. A handler with any remaining param requirement is a compile error at `run`. This is the safety spine: imaginary params — declared in a leaf, never captured by a `param` — cannot reach `run`.

---

## Required-params discipline

`P` flows structurally through composition. Key properties verified by the spike:

**Discharge.** `param('id', child<{id:string}>)` → `Handler<{}>`. The `id` need is satisfied. `run` compiles (test A).

**Partial discharge.** `param('id', child<{tenantId:string, id:string}>)` → `Handler<{tenantId:string}>`. `id` is discharged; `tenantId` remains required and propagates upward. `run` on the partial result errors; a second `param('tenantId', …)` discharges fully (test E-PROPAGATION).

**Guard.** A leaf with `{id:number}` and no `param` above it is correctly rejected by `run` (test D).

**Contravariance.** `Handler<{}>` is assignable where `Handler<{id:string}>` is expected — a handler needing nothing can serve anywhere. `choice` over branches with different needs infers the union: the most-demanding sibling sets the floor (test F).

**Realistic full chain.** `leaf<{id:number}>` → `typed(parse)(leaf)` = `Handler<{id:string}>` → `param('id', …)` = `Handler<{}>` → `run` compiles (test I).

---

## Orthogonal typing

Structure and types are independent axes that compose:

```
leaf<{id:number}>
  → typed(numericId)(leaf)       : Handler<{id:string}>
  → param('id', …)               : Handler<{}>
  → run                          ✓
```

`param` is always string-to-string. `typed` refines a facet of the request from string to a richer type and discharges the refined requirement. The routing core has zero schema or codec surface. Validation is an optional middleware layer.

The type safety property that `param`'s string-only constraint closes: a child wanting `{x:number}` cannot be directly captured (test G1); it must go through `typed`, which is the correct and only bridge.

---

## Known caveat

`param('id', leaf<{}>)` compiles silently (test H). TypeScript's structural subtyping lets `{}` satisfy `C extends Record<'id',string>` — an empty object has no contradictions against any `Record<K,V>` constraint. The result is `Handler<Omit<{}, 'id'>, void>` = `Handler<{}, void>`; `run` compiles. The captured segment is injected into params at runtime and ignored by the child. Forbidding unused captures would require machinery TypeScript cannot cleanly express. Accepted: runtime-harmless, ergonomically permissive.

---

## Protocol agnosticism (tree × kit)

The core — `Handler`/`Req<P>`/`Pass`/`choice`/`param`/`typed` — is abstract over `Req` and `Res`. It knows nothing about HTTP. Protocol-specific matchers live in per-protocol **kits** over that abstract core:

- HTTP kit: `methods` (verb-keyed dispatch), `path` (segment dispatch), HTTP-specific request/response shaping.
- Worker/RPC kit: dispatch by procedure name.
- MCP kit: dispatch by tool name.
- CLI kit: dispatch by subcommand.

`methods` is HTTP-only by nature — verb-dispatch is meaningless on MCP or stdio. What transfers across protocols is `Handler` + `Middleware` + business logic. The tree never carries HTTP verbs as structural keys; the HTTP kit renders them.

**Server = client.** A client is also a `Handler` — the network call is the bottom handler. Swapping an in-process `Handler` for the network handler is how testing works; no mock infrastructure required.

---

## Scale-to-zero / modularity

- A bare `leaf` is a complete app.
- `choice()` with no arguments is the zero.
- Middleware identity is `(h) => h`.
- One composition mechanism throughout.

Adding or removing a concern (auth, logging, validation) is a middleware. Conditional inclusion: `cond ? mw : id`.

---

## Next

Runtime implementation: the `Pass`/`choice` evaluator, the HTTP kit (`path` + `methods` + request/response adapter), and a worker/in-process kit demonstrating the same handler tree serving both surfaces. Additional request-facet extractors (`body`, `query`, `header`) reuse the `param`/`typed` pattern and are additive — no core changes required.
