# Node\<P,Res\> — core model

## Status

Implemented in `packages/core` + `packages/http` + `packages/worker` + `packages/client`, verified by build + typecheck + test. Supersedes the bare-`Handler` model documented previously. OpenAPI projection and typed client derivation from `.meta` are both implemented.

---

## Packages

| Package | Contents |
|---|---|
| `@rhi-zone/fractal-core` | `Pass`/`pass`, `Req<P>`, `Handler<P,Res>`, `Meta`, `Node<P,Res,M>` (3rd param M = precise meta), `NodeMiddleware`, `choice` (general alternation, opaque to typed client), `pipe`, `capture` (generic in V), `typed` (sync combinator, accepts `StandardSchemaV1`), `leaf`, `run`, `resolveSchema` |
| `@rhi-zone/fractal-http` | `path<T>`, `methods<T>` (path-exhaustion guard; both generic over literal table type), `param`/`query`/`header` (V=string, via core `capture`), `body` (lazy thunk handle), `validate` (sync combinator / async per-request handler, accepts `StandardSchemaV1`), `route(collection?, {children?,param?})` (both-and; type-precise for client derivation), `serve`, HTTP `Req` shape; HTTP-specific meta types (`PathMeta<T>`, `MethodsMeta<T>`, `ParamMeta<K,M>`, `BodyMeta`, `ValidateMeta`, `RouteMeta`) |
| `@rhi-zone/fractal-worker` | `procedure`, `field` (generic V, eager already-typed value), `dispatch`, worker `Req` shape; worker-specific meta types (`ProcedureMeta`, `FieldMeta`) |
| `@rhi-zone/fractal-openapi` | `toOpenApi(node, info): OpenApiDocument`, `toJsonSchema(node, opts?): JsonSchemaFragment` — walk `.meta` to produce OpenAPI 3.0 or JSON-Schema; handles `route` kind |
| `@rhi-zone/fractal-client` | `client(node, transport?)` → typed `ClientOf<typeof node>` proxy; `inProcess(node)` transport (Hyper unification: invokes `node.handler` directly, no network); `http(baseUrl)` transport (serializes to `fetch`). `Transport` interface for custom transports. |

---

## The composition unit

```ts
type Handler<P extends Record<string, unknown> = Record<string, never>, Res = unknown> =
  (req: Req<P>) => Promise<Res | Pass>

type Node<
  P extends Record<string, unknown> = Record<string, never>,
  Res = unknown,
  M extends Meta = Meta,   // ← 3rd param: the precise meta type (default: wide Meta)
> = {
  meta: M                  // precise meta type, not just Meta
  handler: Handler<P, Res>
}
```

`Node` is the composition unit. Every combinator produces a `Node` and every kit combinator consumes `Node` children. `Handler` remains the underlying executable type — `node.handler` is the callable.

- `meta` carries the descriptor tree: `{ kind: "leaf" }`, `{ kind: "choice", children: Meta[] }`, `{ kind: "param", name, in: "path", schema, child }`, etc. The tree is walkable for reflection, code generation, or documentation (e.g. OpenAPI).
- `handler` is the side-effecting function. Swapping out a `handler` (e.g. replacing an in-process leaf with a network call) does not require changing the tree structure.

**The 3rd type parameter `M`** preserves the precise meta type of a node. It defaults to the wide `Meta` union so existing `Node<P,Res>` usages compile unchanged. When combinators are generic over their table type `T`, `M` carries literal key names and child meta types — enabling typed-client derivation from the tree structure at the type level. Example: `path({todos: methods({GET: leaf(...)})})` returns `Node<{}, unknown, PathMeta<{todos: Node<{}, unknown, MethodsMeta<{GET: Node<{}, Todo[], LeafMeta>}>>}>>` — the full route structure is reified in the type.

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
meta: `{ kind: "typed", schema: <JSON-Schema from StandardJSONSchemaV1 trait or {}>, child: inner.meta }`

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

```ts
function path<T extends Record<string, NodeShape>>(table: T): Node<{}, unknown, PathMeta<T>>
```

Dispatches on the first segment of `req.path`, consumes it, passes the tail to the matched child. Returns `Pass` if no segment or no match. `T` is inferred from the table so literal segment keys and child meta types are preserved — enabling typed-client derivation.
meta: `{ kind: "path", children: T }` (full child nodes stored, not just metas; walker extracts `.meta`)

### `methods`

```ts
function methods<T extends Record<string, NodeShape>>(table: T): Node<{}, unknown, MethodsMeta<T>>
```

Dispatches on `req.method`. **Path-exhaustion guard**: returns `Pass` if `req.path` is non-empty — `methods` only fires when all path segments have been consumed by enclosing `path`, `param`, or `route` combinators. `T` is inferred so literal verb keys and child meta types survive.
meta: `{ kind: "methods", verbs: T }` (full child nodes stored)

### `route` — both-and combinator

```ts
function route<Collection, Children, ParamK, ParamChild>(
  collection: Collection,           // a methods(...) node, handles path-exhausted case
  options?: {
    children?: Children             // exact-segment child map
    param?: { name: ParamK; child: ParamChild }  // named param fallthrough
  }
): Node<{}, unknown, RouteMeta<Collection, Children, ParamK, ParamChild>>
```

The structured routing combinator. A single node that handles collection + exact children + param fallthrough **without `choice()`**, so the typed client can derive a callable-object hybrid surface.

**Dispatch order** (first match wins):
1. Path exhausted (`req.path.length === 0`) → delegate to `collection`
2. Exact segment match (`req.path[0]` in `children`) → delegate to matching child
3. No exact match, param slot present → inject segment as `params[name]`, delegate to `param.child`
4. None of the above → `Pass`

`RouteMeta<Collection, Children, ParamK, ParamChild>` preserves:
- `collection`: the collection node (carries collection verb types)
- `children`: literal exact-child map (carries child meta types)
- `param`: `{ name: ParamK; child: ParamChild }` (carries param key name + child meta)

The typed client (forthcoming) derives a callable-object hybrid: `client.todos(id)` (param callable) intersected with `{ GET(), POST(body) }` (collection verbs) intersected with exact children.

`choice()` stays the **general alternation primitive** — its branches collapse into `ChoiceMeta<children: Meta[]>` and literal keys are NOT preserved. Use `choice()` when composing branches that don't need typed-client traversal (e.g., query/header variants inside a collection). Use `route()` for the structural collection+param routing that the typed client must traverse.

### `param`

```ts
function param<K extends string, C extends Record<K, string>, Res, M extends Meta>(
  name: K,
  child: Node<C, Res, M>,
): Node<Omit<C, K>, Res, ParamMeta<K, M>>
```

Captures the next path segment as the string-typed param `name`. V is pinned to `string` via `C extends Record<K, string>`. Generic over `M` (child meta) so `ParamMeta<K, M>` preserves the child's precise meta type for typed-client derivation. A child wanting `{ x: number }` cannot be `param`-captured directly — G1 safety: `param('x', leaf<{x:number}>(...))` is a compile error, verified by `@ts-expect-error` in `packages/http/src/index.ts`.
meta: `{ kind: "param", name, in: "path", schema: { type: "string" }, child: child.meta }` (`child` is a raw Meta, not a full node)

### `query` / `header`

Same `Omit<C,K>` algebra as `param`. V pinned to `string`. Returns `Pass` if the key is absent.
meta: `{ kind: "query"/"header", name, in: "query"/"header", schema: { type: "string" }, child: child.meta }`

### `body`

Pulls the lazy body thunk exactly once, makes the resolved value available to the child as `req.body: unknown`. A route that does not include `body()` never triggers the thunk.
meta: `{ kind: "body", child: { kind: "leaf" } }`

### `validate`

**Sync combinator** that returns an async per-request handler (`HandlerWithBody`). Accepts either a `StandardSchemaV1` or a raw parse function `(unknown) => T | Promise<T>`. Wraps a `HandlerWithBody<P,T,Res>` and returns a `HandlerWithBody<P,unknown,Res>` — synchronously. No await at composition time; async work happens per-request. Composes into `body(validate(schema, inner))`. When a `StandardSchemaV1` with the `jsonSchema` trait is passed, the input schema flows into `ValidateMeta.schema` and is emitted as the OpenAPI `requestBody` schema by `toOpenApi`.

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
| `choice` | `"choice"` | `children: Meta[]` (opaque to typed client) |
| `capture` | `"capture"` | `name, child` |
| `typed` | `"typed"` | `schema, child` |
| `path` | `"path"` | `children: Record<seg, NodeShape>` (full nodes; literal keys preserved) |
| `methods` | `"methods"` | `verbs: Record<verb, NodeShape>` (full nodes; literal keys preserved) |
| `param` | `"param"` | `name, in: "path", schema, child: Meta` |
| `query` | `"query"` | `name, in: "query", schema, child: Meta` |
| `header` | `"header"` | `name, in: "header", schema, child: Meta` |
| `body` | `"body"` | `child: Meta` |
| `route` | `"route"` | `collection: NodeShape\|undefined, children: Record<seg, NodeShape>, param: {name,child:NodeShape}\|undefined` |
| `procedure` | `"procedure"` | `procedures: Record<name, Meta>` |
| `field` | `"field"` | `name, child: Meta` |
| `withSecurity` (NodeMiddleware) | `"security"` | `schemes: Array<Record<string,string[]>>, child: Meta` |

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

`NodeMiddleware` (the `Node → Node` pattern) feeds operation-level metadata:

- A `withSecurity(schemes, enforce)` middleware emits `{ kind: "security", schemes, child: inner.meta }` and enforces at request time. The walker accumulates `schemes` into `ctx.security` and emits them on the operation's `security` field.

---

## Typed client (`@rhi-zone/fractal-client`)

The typed client is derived structurally from a `Node` tree — the same value that serves is the source of truth for both the server surface and the client surface.

```ts
import { client, http } from '@rhi-zone/fractal-client'

// In-process transport (Hyper unification: client IS the server handler)
const c = client(app)
const todos = await c.todos.GET()                // → Promise<Todo[]>
const todo  = await c.todos.POST({ title: 'x' }) // → Promise<Todo>
const byId  = await c.todos('1').GET()           // → Promise<Todo | null>

// HTTP transport — same type, real network call
const remote = client(app, http('https://api.example.com'))
const todos2 = await remote.todos.GET()          // same type, over the wire
```

### How `ClientOf<N>` is derived

`ClientOf<typeof node>` walks the `M` type parameter of each `Node<P,Res,M>`:

| Meta kind | Client surface |
|---|---|
| `LeafMeta` | `() => Promise<Res>` |
| `BodyMeta<T>` | `(body: T) => Promise<Res>` |
| `MethodsMeta<Verbs>` | `{ [verb]: ClientOfVerbNode<Verbs[verb]> }` |
| `PathMeta<Children>` | `{ [seg]: ClientOf<Children[seg]> }` |
| `ParamMeta<K,ChildMeta>` | `(value: string) => ClientOfMeta<ChildMeta>` |
| `RouteMeta<Collection,Children,ParamK,ParamChild>` | callable-object hybrid: `((value: string) => ClientOf<ParamChild>) & CollectionPart & ChildrenPart` |

The `RouteMeta` case produces the callable-object hybrid for `route()` nodes: `client.todos` is simultaneously callable (`client.todos('1')` → item sub-client) AND has collection verb props (`.GET()`, `.POST(body)`) AND exact-child props.

### Transports

The `Transport` interface decouples type derivation from invocation:

```ts
interface Transport {
  call(desc: { method: string; path: string[]; params: Record<string,string>; body?: unknown }): Promise<unknown>
}
```

- **`inProcess(node)`** — assembles a `Req` and calls `node.handler(req)` directly. No network. The default when `transport` is omitted from `client(node)`. This is Hyper unification: the client and server are one value.
- **`http(baseUrl)`** — serializes `{method, path, body}` into a `fetch` call. Same derived type; different runtime.

### Structural constraint

`ClientOf<N>` requires the tree to use `path`, `methods`, `param`, and `route` combinators. `choice()` is opaque to the typed client (branches collapse into `ChoiceMeta` with no literal keys). Use `route()` for collection+param routing; `choice()` is still appropriate inside a `collection` node for query/header variants.

**One definition → HTTP server + OpenAPI + typed client.** The same `Node` tree, walked three ways:
- `serve(node, req)` → HTTP response
- `toOpenApi(node, info)` → OpenAPI 3.0 document
- `client(node)` → typed callable proxy

---

## Future items

- **MCP/CLI kits**: procedure/subcommand dispatch analogous to worker kit.
- **Reactive capabilities**: live queries, invalidation, binding to reactive client library.
