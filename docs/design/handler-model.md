# Node\<P,Res\> — core model

## Status

Implemented in `packages/core` + `packages/http` + `packages/worker`, verified by build + typecheck + test. Supersedes the bare-`Handler` model documented previously. OpenAPI projection from `.meta` is enabled (not yet built as a package).

---

## Packages

| Package | Contents |
|---|---|
| `@rhi-zone/fractal-core` | `Pass`/`pass`, `Req<P>`, `Handler<P,Res>`, `Meta`, `Node<P,Res>`, `NodeMiddleware`, `choice`, `pipe`, `capture` (generic in V), `typed` (sync combinator, accepts `StandardSchemaV1`), `leaf`, `run`, `resolveSchema` |
| `@rhi-zone/fractal-http` | `path`, `methods` (with path-exhaustion guard), `param`/`query`/`header` (V=string, via core `capture`), `body` (lazy thunk handle), `validate` (sync combinator / async per-request handler, accepts `StandardSchemaV1`), `serve`, HTTP `Req` shape; HTTP-specific meta types (`PathMeta`, `MethodsMeta`, `ParamMeta`, `QueryMeta`, `HeaderMeta`, `BodyMeta`, `ValidateMeta`) |
| `@rhi-zone/fractal-worker` | `procedure`, `field` (generic V, eager already-typed value), `dispatch`, worker `Req` shape; worker-specific meta types (`ProcedureMeta`, `FieldMeta`) |
| `@rhi-zone/fractal-openapi` | `toOpenApi(node, info): OpenApiDocument`, `toJsonSchema(node, opts?): JsonSchemaFragment` — walk `.meta` to produce OpenAPI 3.0 or JSON-Schema |

---

## The composition unit

```ts
type Handler<P extends Record<string, unknown> = Record<string, never>, Res = unknown> =
  (req: Req<P>) => Promise<Res | Pass>

type Node<P extends Record<string, unknown> = Record<string, never>, Res = unknown> = {
  meta: Meta    // reflection descriptor — walkable, serialisable
  handler: Handler<P, Res>  // the executable
}
```

`Node` is the composition unit. Every combinator produces a `Node` and every kit combinator consumes `Node` children. `Handler` remains the underlying executable type — `node.handler` is the callable.

- `meta` carries the descriptor tree: `{ kind: "leaf" }`, `{ kind: "choice", children: Meta[] }`, `{ kind: "param", name, in: "path", schema, child }`, etc. The tree is walkable for reflection, code generation, or documentation (e.g. OpenAPI).
- `handler` is the side-effecting function. Swapping out a `handler` (e.g. replacing an in-process leaf with a network call) does not require changing the tree structure.

`P` is the set of params the handler **requires** from above. Default `Record<string,never>` = needs nothing. `Pass` means "not me — try the next handler." Every combinator is `Node`:

- A leaf node: `Node<P, Res>`
- A middleware: `NodeMiddleware = (n: Node<P, Res>) => Node<P, Res>` — can contribute meta (e.g. auth → security descriptor)
- A mounting combinator: takes `Node` children, returns `Node`

There is no second composition shape. Nesting is value placement.

---

## Core combinators (`@rhi-zone/fractal-core`)

### `leaf`

```ts
function leaf<P extends Record<string, unknown>, Res>(
  fn: (req: Req<P>) => Promise<Res>,
): Node<P, Res>
```

Wraps a plain async function into a `Node`. The only place application logic lives.
meta: `{ kind: "leaf" }`

### `choice`

```ts
function choice<P extends Record<string, unknown>, Res>(
  ...ns: Node<P, Res>[]
): Node<P, Res>
```

Tries nodes in order. Returns the first result that is not `Pass`. `choice()` with no arguments is the zero (always passes).
meta: `{ kind: "choice", children: ns.map(n => n.meta) }`

### `capture`

```ts
function capture<K extends string, V, C extends Record<K, V>, Res>(
  name: K,
  read: (req: Req<Omit<C, K>>) => V | Pass,
  child: Node<C, Res>,
): Node<Omit<C, K>, Res>
```

The generic capture primitive. `V` is **free** — each kit pins it to whatever the transport delivers. HTTP kits pin `V=string`; Worker kits use `V=number`, `V=object`, etc.
meta: `{ kind: "capture", name, child: child.meta }`

Kit-specific combinators (`param`, `query`, `header`, `field`) are thin wrappers that supply the `read` function, pin `V`, and attach a richer meta descriptor.

### `typed`

```ts
function typed<Out extends Record<string, unknown>, P extends Record<string, unknown>, Res>(
  parse: (raw: Record<string, unknown>) => Out,
): (inner: Node<P & Out, Res>) => Node<P, Res>
```

**Sync, eager** refinement of values already in the params bag. Discharges `Out` from inner's requirements.
meta: `{ kind: "typed", schema: { parsed: true }, child: inner.meta }`

Contrast with `validate()` in the HTTP kit which is **async, lazy** over the body facet.

### `pipe`

```ts
function pipe<P extends Record<string, unknown>, Res>(
  ...mws: NodeMiddleware<P, Res>[]
): NodeMiddleware<P, Res>
```

Compose `NodeMiddleware` via `reduceRight`. `pipe(mw1, mw2)(n) = mw1(mw2(n))` — `mw1` is outermost and runs first. Middleware is `Node → Node` and can contribute meta (e.g. an auth middleware adds a security descriptor to the wrapped node's meta).

### `run`

```ts
function run<Res>(
  n: Node<Record<string, never>, Res>,
  req: Req<Record<string, never>>,
): Promise<Res | null>
```

Accepts only a fully-discharged Node (P = {}). A Node with any remaining param requirement is a compile error at `run`. Calls `n.handler(req)`. Maps `Pass` → `null`.

---

## HTTP kit combinators (`@rhi-zone/fractal-http`)

### `path`

Dispatches on the first segment of `req.path`, consumes it, passes the tail to the matched child. Returns `Pass` if no segment or no match.
meta: `{ kind: "path", children: { [seg]: child.meta } }`

### `methods`

```ts
function methods<P, Res>(table: Record<string, Node<P, Res>>): Node<P, Res>
```

Dispatches on `req.method`. **Path-exhaustion guard**: returns `Pass` if `req.path` is non-empty — `methods` only fires when all path segments have been consumed by enclosing `path` and `param` combinators.
meta: `{ kind: "methods", verbs: { [VERB]: child.meta } }`

### `param`

```ts
function param<K extends string, C extends Record<K, string>, Res>(
  name: K,
  child: Node<C, Res>,
): Node<Omit<C, K>, Res>
```

Captures the next path segment as the string-typed param `name`. V is pinned to `string` via `C extends Record<K, string>`. A child wanting `{ x: number }` cannot be `param`-captured directly — G1 safety: `param('x', leaf<{x:number}>(...))` is a compile error, verified by `@ts-expect-error` in `packages/http/src/index.ts`.
meta: `{ kind: "param", name, in: "path", schema: { type: "string" }, child: child.meta }`

### `query` / `header`

Same `Omit<C,K>` algebra as `param`. V pinned to `string`. Returns `Pass` if the key is absent.
meta: `{ kind: "query"/"header", name, in: "query"/"header", schema: { type: "string" }, child: child.meta }`

### `body`

Pulls the lazy body thunk exactly once, makes the resolved value available to the child as `req.body: unknown`. A route that does not include `body()` never triggers the thunk.
meta: `{ kind: "body", child: { kind: "leaf" } }`

### `validate`

**Sync combinator** that returns an async per-request handler (`HandlerWithBody`). Takes `parse: (unknown) => T | Promise<T>`, wraps a `HandlerWithBody<P,T,Res>`, returns a `HandlerWithBody<P,unknown,Res>` — synchronously. No await at composition time; async work happens per-request. Composes into `body(validate(parse, inner))`. A Standard Schema validator slots in here: `validate(v => schema.parse(v), inner)`.

### `serve`

```ts
function serve<Res>(
  n: Node<Record<string, never>, Res>,
  req: HttpRequest,
): Promise<HttpResponse<Res>>
```

Splits path, parses query string, wraps the body in a lazy thunk, calls `n.handler(httpReq)`, maps `Pass` → `{ status: 404, body: null }`.

---

## Worker kit combinators (`@rhi-zone/fractal-worker`)

### `procedure`

Dispatches by the `procedure` field on the request. Returns `Pass` if no match. Unlike `path`, does not consume a segment — the full procedure name is matched as-is.
meta: `{ kind: "procedure", procedures: { [name]: child.meta } }`

### `field`

```ts
function field<K extends string, V, C extends Record<K, V>, Res>(
  name: K,
  read: (req: Req<Omit<C, K>>) => V | Pass,
  child: Node<C, Res>,
): Node<Omit<C, K>, Res>
```

V is **free** — pinned by the child's type requirement. The Worker transport delivers already-typed values (number, object, …) from IPC/shared memory. No `string→T` parse step; no `typed()` needed.
meta: `{ kind: "field", name, child: child.meta }`

### `dispatch`

Runs a worker call through a fully-discharged Node. Calls `n.handler(workerReq)`. Maps `Pass` → `{ ok: false, result: null, error: "procedure not found" }`.

---

## Required-params discipline

`P` flows structurally through composition. Key properties verified by tests A–I:

**Discharge.** `param('id', child<{id:string}>)` → `Node<{}>`. The `id` need is satisfied. `run` compiles.

**Partial discharge.** `param('id', child<{tenantId:string, id:string}>)` → `Node<{tenantId:string}>`. `id` is discharged; `tenantId` remains required. `run` on the partial result errors; a second `param('tenantId', …)` discharges fully.

**Guard.** A leaf with `{id:number}` and no `param` above it is correctly rejected by `run`. The `handler` field is still a function type (`Handler<P,Res>`), so contravariance in `P` is preserved through the Node wrapper.

**G1 safety.** `param('x', leaf<{x:number}>(...))` is a compile error — `{x:number}` does not satisfy `C extends Record<'x',string>`.

**Realistic full chain.** `leaf<{id:number}>` → `typed(parse)(leaf)` = `Node<{id:string}>` → `param('id', …)` = `Node<{}>` → `run` compiles.

---

## Reflection — built in

Every `Node` carries a `meta: Meta` descriptor. The tree is built during route construction (synchronous, pure data). It can be walked after construction:

```ts
function walk(meta: Meta): OpenApiPaths { /* ... */ }
const spec = walk(app.meta)  // app.meta is PathMeta at the root
```

Meta variants produced by each combinator:

| Combinator | meta.kind | extra fields |
|---|---|---|
| `leaf` | `"leaf"` | — |
| `choice` | `"choice"` | `children: Meta[]` |
| `capture` | `"capture"` | `name, child` |
| `typed` | `"typed"` | `schema, child` |
| `path` | `"path"` | `children: Record<seg, Meta>` |
| `methods` | `"methods"` | `verbs: Record<verb, Meta>` |
| `param` | `"param"` | `name, in: "path", schema, child` |
| `query` | `"query"` | `name, in: "query", schema, child` |
| `header` | `"header"` | `name, in: "header", schema, child` |
| `body` | `"body"` | `child` |
| `procedure` | `"procedure"` | `procedures: Record<name, Meta>` |
| `field` | `"field"` | `name, child` |

**OpenAPI projection** from `Meta` is implemented in `@rhi-zone/fractal-openapi`. The `toOpenApi(node, info)` function walks `node.meta` to produce a full OpenAPI 3.0 document. `toJsonSchema(node, opts?)` produces a JSON-Schema fragment. Standard Schema (`@standard-schema/spec`) feeds both validation and the emitted schemas — `TypedMeta.schema` and `ValidateMeta.schema` carry JSON-Schema objects derived from `schema['~standard'].jsonSchema?.output?.({ target: 'openapi-3.0' })`; if the trait is absent or throws, `{}` is stored (graceful degradation). The proof of concept `walk()` function lives in `spike/node-reflect.ts`.

---

## Protocol agnosticism (tree × kit)

The core — `Node`/`Handler`/`Req<P>`/`Pass`/`choice`/`typed`/`capture` — is abstract over transport. Protocol-specific combinators live in per-protocol **kits**:

- **HTTP kit** (`fractal-http`): `methods`, `path`, `param`, `query`, `header`, `body`, `validate`, `serve`.
- **Worker kit** (`fractal-worker`): `procedure`, `field`, `dispatch`.
- Future: MCP kit (dispatch by tool name), CLI kit (dispatch by subcommand).

What transfers across protocols: `Node` + `NodeMiddleware` + business logic. The tree carries no HTTP-specific keys at the core level; each kit renders the transport-relevant shape.

**Server = client.** A client is also a `Node` — the network call is the bottom handler. Swapping an in-process `Node` for the network handler is how testing works; no mock infrastructure required.

---

## Known caveat

`param('id', leaf<{}>(...))` compiles silently. TypeScript's structural subtyping lets `{}` satisfy `C extends Record<'id',string>` — an empty object has no contradictions. Runtime-harmless, ergonomically permissive.

---

---

## Projection

`@rhi-zone/fractal-openapi` walks the `.meta` tree to produce OpenAPI 3.0 or JSON-Schema:

```ts
import { toOpenApi, toJsonSchema } from '@rhi-zone/fractal-openapi'

const doc = toOpenApi(app, { title: 'My API', version: '1.0.0' })
// doc.paths: { "/todos": { get: {...}, post: {...} }, "/todos/{id}": { get: {...} } }

const frag = toJsonSchema(app)
```

Standard Schema (`@standard-schema/spec@^1.1.0`) feeds both validation and projection:

- `typed(schema)(inner)` — calls `schema['~standard'].validate` per request; stores `schema['~standard'].jsonSchema?.output?.({ target: 'openapi-3.0' })` in `TypedMeta.schema`.
- `validate(schema, inner)` — same validate/jsonSchema pattern; stores schema in `ValidateMeta.schema`; `body(validate(...))` picks up the schema into `BodyMeta.child`.
- Both accept either a `StandardSchemaV1` or a raw parse function for backward compatibility.
- If the `jsonSchema` trait is absent or throws, `{}` is stored — graceful degradation. The leaf node and path/methods/param walker nodes are unaffected.

---

## Future items

- **MCP/CLI kits**: procedure/subcommand dispatch analogous to worker kit.
- **Reactive capabilities**: live queries, invalidation, binding to reactive client library.
