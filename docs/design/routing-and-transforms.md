# Routing and tree transforms — settled design

## API tree ≠ route tree

The skeleton (API tree) is organized by domain — children are operations, not
path segments. The HTTP route tree is a separate tree organized by protocol
(paths, methods). The projector produces the route tree from the API tree.

Two operations that share an HTTP path (e.g. `GET /users` and `POST /users`)
are different nodes in the API tree (`list` and `create` under `users`). The
"same path, different methods" problem only exists in the route tree, never
in the skeleton.

## Tree transforms are functions

Not every transform is the same shape. Convention transforms are endofunctors
(`Node => Node`); the projection itself crosses a type boundary
(`Node => ProtocolType`) and so is not an endofunctor. No special status, no
pipeline, no framework beyond that distinction.

Three roles:

1. **Inline metadata** — one mechanism for explicit control. The user sets
   `meta.http.*` (or any projection-specific metadata) directly on operations.
2. **Convention transforms** — optional `Node => Node` endofunctors that fill
   in metadata based on naming conventions (REST/CRUD, RPC-style, etc.). These
   are subjective — multiple can exist, none is privileged. They respect
   already-set inline metadata (don't overwrite). Multiple can be chained.
3. **The projection transform** — the builtin `Node => HttpRoute` transform
   that reads `meta.http.*` and reshapes the API tree into the HTTP route
   tree. This crosses the type boundary, so it is not an endofunctor — it's
   the HTTP projector's own transform, not a convention.

## Structural transform primitive: relative node placement

The structural transformation from API tree to route tree is: each node
specifies where it goes in the output tree relative to where it is now.

Encoding: a relative path string. This is stringly-typed, which is acceptable
because it's input to a transform function, not part of the skeleton's
structure.

- `.` — stay (identity)
- `./*` — down under a new wildcard segment
- `..` — up to parent
- `../../admin` — up two, under `admin`

`*` is the wildcard segment marker — universally "wildcard," not a valid
path segment or identifier in any ambiguous context. The parameter name comes
from the node's own metadata or the operation's input type, not from the path
encoding.

Default placement: identity (same position). Metadata (verb, status, parameter
binding) is separate from structural transforms — just properties on nodes.

(2026-08-05: this used to be aspirational for parameter binding specifically —
`moveTo` could change which slug a leaf implicitly bound to, by relocating it
onto a same-named wildcard it never authored under. That gap is closed: a
leaf's field↔store binding is now a pure function of its own authored
declarations (local pre-moveTo path-slug ancestry, or an explicit
`sourceMap`/`http.source()` entry) — `moveTo` is purely an address transform,
exactly as this line already claimed. See `http-api-projector/src/route.ts`'s
`Sources.authoredPathParams`.)

### Motivating example

```
API tree:                    HTTP route tree:
users/                       /users
  list   (stay)                GET  → listUsers
  create (stay)                POST → createUsers
  get    (down under *)      /users/*
  update (down under *)        GET  → getUser
  delete (down under *)        PUT  → updateUser
                               DELETE → deleteUser
```

Operations that land at the same position group naturally. Method assignment
is metadata, not a tree operation.

## Route tree type

The HTTP route tree is a separate type from `Node`. The API tree uses `Node`;
the route tree uses `HttpRoute` with explicit method dispatch:

```typescript
type HttpRoute = {
  methods?: Record<string, { handler: Handler; meta: Meta }>
  children?: Record<string, HttpRoute>
  fallback?: { name: string; subtree: HttpRoute }
  meta: Meta
}
```

Each projection can have its own output type. CLI would have its own, MCP its
own. The user never writes these types directly — transforms produce them.

## Transform pipeline

### 1. Naive transform: `Node => HttpRoute`

Every child in `children` becomes a path-segment child. Every handler becomes
a single `POST` entry in `methods`. No inference, no convention — just a
mechanical shape change. This is the baseline the rewriters start from.

### 2. Rewriters: `HttpRoute => HttpRoute`

DU-based rewriters, configured by the user at construction time, reshape the
route tree. Each rewriter reads DU directives from `meta.http` and modifies
the route tree accordingly:

- **Method rewriter**: reads `{ kind: "method", value: "GET" }` directives,
  changes the method key in `methods`
- **MoveTo rewriter**: reads `{ kind: "moveTo", path: "../*" }` directives,
  moves nodes in the route tree
- **Response rewriter**: reads `{ kind: "response", status: 201 }` directives,
  wraps the handler to produce the correct HTTP response (function composition,
  not metadata — the override is materialized into the handler itself)

### 3. Composition everywhere

Response overrides are handler wrapping. Method assignment is tree rewriting.
Placement is tree rewriting. No special-casing — everything is either an
endofunctor (`Node => Node` convention transform, `HttpRoute => HttpRoute`
rewriter) or function composition on the handler.

## `meta.http` shape

On API tree nodes, `meta.http` is an object with:

- **Named properties** (property bag): HTTP-specific metadata that isn't a
  transform instruction — description, deprecation, docs URL, rate limit config.
  Open via declaration merging.
- **`directives` array** (DU): transform instructions for the rewriters.
  Each directive is a DU variant (`{ kind: "method", value: "GET" }`,
  `{ kind: "moveTo", path: "../*" }`, `{ kind: "response", status: 201 }`, etc.).
  Extensible via declaration merging on the DU.

Convention transforms (`Node => Node`) and rewriters (`HttpRoute => HttpRoute`) fill in
directives where they're not set. Inline directives take precedence (convention
transforms skip already-set directives).

Declaration merging by the user happens next to the API tree definition so
that `meta.http` type-checks at the authoring site.

## Open items — both resolved

### ~~Constructor sugar (DX)~~ — resolved, see "DX — constructor sugar" below

`api()`/`op()`, the `http.*` verb bundles, and `crud()` are the settled
answer — see the "DX — constructor sugar" section further down this doc.

### ~~Input sources, validation, transformation~~ — resolved

Input sourcing is the stores model (`docs/guide/decode.md`); validation is
`applyValidation` (see "Dispatch is not an interceptable multi-stage
pipeline" below, and `docs/guide/codegen-cli.md`).

## Dispatch is not an interceptable multi-stage pipeline

> **Superseded, in two stages:**
> 1. **(2026-07)** an earlier revision of this design decomposed the
>    request/response lifecycle into typed, interceptable stages
>    (`reqTransforms`/`decode`/`inputTransforms`/`validate`/`handler`/
>    `outputTransforms`/`encode`/`resTransforms`, each an array of
>    `meta`-driven functions) plus a `createApplyValidation` rewriter that
>    injected generated validators into a per-method `pipeline.validate`
>    array. `packages/http-api-projector/src/route.ts`'s module doc states
>    the reasoning directly: "nothing in this codebase used those hooks
>    outside of tests exercising the mechanism itself." What replaced it:
>    `wrapValidators` (`packages/api-tree/src/build.ts`) — a single,
>    Node-level mechanism shared by HTTP/MCP/CLI, wiring generated validators
>    directly onto a leaf's handler BEFORE any protocol-specific projection
>    ran.
> 2. **(2026-08, phase 1–3)** `wrapValidators` itself is superseded by the
>    keyed, call-site-anchored `applyValidation(key, projectedTree)`
>    (`packages/api-tree/src/apply-validation.ts`) — phase 1 added it
>    alongside `wrapValidators`; phase 2 migrated HTTP; phase 3 migrated
>    MCP/CLI/GraphQL and deleted `wrapValidators`/`isValidatorWrapped`/
>    `UnvalidatedLeafError` (`build.ts`) entirely. **None of the above —
>    the stage-array pipeline, `createApplyValidation`'s old
>    `pipeline.validate` injection, OR `wrapValidators` — exists in the
>    current code.** The section below describes the settled mechanism.

What's left is `runRoute` (`route.ts`): decode the request via `sources`
(genuinely per-route — each route has its own parameter names and source
overrides, see `docs/guide/decode.md`), call the handler, encode the
response. Simple and linear, no loop over stage arrays. The one
interceptable hook left in the request/response cycle is `handlerMiddleware`
(`HttpHandlerMiddleware`, an around-hook wrapping the handler call itself —
see `docs/design/middleware-and-caller-context.md`) plus the
`PresetOptions.middleware` `Fetch => Fetch` layers `createFetch` composes
around the whole router.

**Validation (settled, phase 3, 2026-08)** happens via
`applyValidation(key, projectedTree)`
(`packages/api-tree/src/apply-validation.ts`) — the same mechanism across
HTTP, MCP, CLI, and GraphQL. None of the four presets has a dedicated
validation option: `applyValidation`'s call site must live in the CONSUMER's
own entry file for codegen to anchor on it (see that module's doc comment),
so no preset can ever own the call itself. The leaf-handler wrap is a fixed
contract regardless of where it's applied: `parse()` first, success narrowing
into the original handler, failure short-circuiting with `Result.err(...)`.

For **HTTP**, the integration point is `PresetOptions.rewriters`
(`preset.ts`) — a plain `HttpRoute => HttpRoute` pass, applied right after
`createFetch`'s internal `Node => HttpRoute` projection (`applyValidation`
has to run on the PROJECTED shape here because `createFetch` never exposes
the intermediate `Node`):
```ts
import { applyValidation } from "./generated/apply-validation.ts"
const fetch = createFetch(node, {
  rewriters: [(routes) => applyValidation("books", routes, "http")],
})
```
A rejected leaf's `err(...)` Result lands on the exact same Result-unwrap path
as any handler-returned `err` — a dedicated 400 with the structured errors,
not the catch block's 500 (see 670e0dd/577659f's history: an earlier
regression to 500, already fixed for the Node-level mechanism before phase 2,
and never reintroduced since `applyValidation`'s wrap uses the identical
Result-returning contract).

For **MCP** (`createMcpServer`), **CLI** (`runCli`), and **GraphQL**
(`createGraphQLServer`), each of which dispatches directly off the SAME
`Node` shape it's given (no separate projected type the way HTTP has
`HttpRoute`), the equivalent hook is each preset's own `rewriters` option —
a `Node => Node` pass, applied to the tree BEFORE that preset's own
projection/dispatch-table walk:
```ts
import { applyValidation } from "./generated/apply-validation.ts"
await runCli(node, argv, io, { rewriters: [(t) => applyValidation("books", t, "cli")] })
```
A tree validated for MORE than one protocol that resolve to the SAME wire
profile (mcp/graphql/jsonrpc, all uniformly typed JSON) can apply
`applyValidation` ONCE with one shared `protocol` tag, before any
protocol-specific projection — the wrap travels with the handler reference
regardless of where a later projection (e.g. HTTP's `moveTo` directive)
relocates it in the tree. `examples/library-api/src/tree.ts`'s `validatedApi`
applies it once for its one live dispatch protocol
(`applyValidation("books", api, "http")`, shared by `httpRoutes`). A key may
be used at most once per generated `applyValidation` function (regardless of
`protocol`), so a tree validated separately per DIVERGENT protocol (e.g. HTTP
vs. CLI, whose wire profiles differ) needs one call site — and one key — per
protocol instead.

CLI's and MCP's fallback coercion/validation steps (CLI's
`coerceInput`/`applyDefaults`/`validateRequired`; MCP's
`validateAgainstSchema`) have both been RETIRED (phase C of the wire-profiles
arc, per `docs/design/wire-profiles-and-staged-validation.md`'s "What goes
away" items 2–4): `isApplyValidationWrapped` and its backing
`appliedHandlerBrand` `WeakSet` are deleted from `apply-validation.ts`, and
neither `cli.ts`'s `runCli` nor `server.ts`'s `createMcpServer` sniffs it any
longer — decode+validation now run unconditionally on every leaf
`applyValidation` wraps, so the exclusivity sniff (generated validator XOR
fallback) has nothing left to be exclusive with. CLI's validation posture is
`applyValidation(key, tree, "cli")`; MCP's is `applyValidation(key, tree,
"mcp")` (identity + JSON-date coercion, no coercion of stringified
numbers/booleans). A leaf with no matching generated validator gets no
validation at all, for either protocol.

## DX — constructor sugar

### `api(children, opts?)`

Positional children, options object for the rare stuff (meta, fallback):

```typescript
const app = api({
  users: crud({ list: listUsers, create: createUser, get: getUser }),
  products: api({ list: op(listProducts, http.get) }),
})
```

`api()` is the primary constructor. `node()` stays as the low-level form.

### `http.*` meta bundles

Shorthand for common HTTP directives:

```typescript
export const http = {
  get:    { http: { directives: [{ kind: "method", value: "GET" }] } },
  post:   { http: { directives: [{ kind: "method", value: "POST" }] } },
  put:    { http: { directives: [{ kind: "method", value: "PUT" }] } },
  patch:  { http: { directives: [{ kind: "method", value: "PATCH" }] } },
  delete: { http: { directives: [{ kind: "method", value: "DELETE" }] } },
}
```

### `crud(handlers)`

Convention constructor — returns a node with standard CRUD operations and
HTTP method metadata. Accepts partial handlers (not all operations required):

```typescript
function crud(handlers: {
  list?:   Handler,
  create?: Handler,
  get?:    Handler,
  update?: Handler,
  delete?: Handler,
}) { ... }
```

Users can define their own `crud()` trivially — it's ~7 lines over `api()`
+ `op()` + `http.*`.

### `HttpMethods` interface — extensible method union

```typescript
interface HttpMethods {
  GET: "GET"; POST: "POST"; PUT: "PUT"; PATCH: "PATCH"; DELETE: "DELETE"
}
type Method = keyof HttpMethods
```

Users extend via declaration merging for custom methods (WebDAV, etc.):

```typescript
interface HttpMethods { PROPFIND: "PROPFIND"; MKCOL: "MKCOL" }
```

### Pre-composed HTTP projection preset

One-call projection with standard transforms applied:

```typescript
const routes = httpProjection(apiTree)
// Equivalent to:
const routes = pipe(
  naiveTransform(apiTree),
  applyMethods,
  applyMoveTo,
  applyResponse,
)
```

Configurable — user can swap individual transforms:

```typescript
const routes = httpProjection(apiTree, {
  transforms: [applyMethods, myCustomPlacement, applyResponse],
})
```

## DX comparison summary

| Scenario | Hono | Fractal |
|----------|------|---------|
| Single route | `app.get('/users', fn)` | `api({ users: op(fn, http.get) })` |
| CRUD entity | 5× `app.verb(path, fn)` | `crud({ list, create, get, update, delete })` |
| Using CRUD | imperative, path strings | `api({ users: crud({...}) })` — composes as data |
| Audit logging | middleware sees raw request | handler wrapper sees typed input + meta |
| JSON-RPC | rewrite everything | same tree, new projector |
| CLI | can't | same tree, new projector |
| Custom methods | not supported | declaration merging, free |

## Build-time optimizations (2026-07-17)

> **Superseded:** this section originally described two `HttpRoute => HttpRoute`
> visitors, `fusePipeline` and `skipEmptyInput`, that fused/skipped stages of
> the interceptable transform-array pipeline retired above. Neither function
> exists in the current code — they applied to machinery that no longer
> exists. The build-time optimization surface that remains is router
> compilation (below): swapping `makeRouterFromRoute`'s zero-build-cost
> tree-walk for a compiled matcher.

## Composable route compilers (2026-07-17)

`packages/http-api-projector/src/compile.ts` provides independent `HttpRoute => (req) =>
Promise<Response>` compilers:

- `radixRouter` — radix-trie-based path matching
- `compiledCharRouter` — compiled character-function matching
- `mapCharRouter` — Map + compiled character hybrid (best broad performance)

Their underlying matchers compose via `chainMatchers` (first-wins).
`mapCharRouter` is `createFetch`'s default (best build cost among the compiled
routers, near-best dispatch — see bench-results/); `makeRouterFromRoute`
remains available as the zero-build-cost alternative via the `router` option.

## AsyncLocalStorage integration (2026-07-17)

`withALS(router, storage, init)` wraps any `CompiledRouter` so every request
runs inside its own `AsyncLocalStorage.run()` context. Opt-in via
`createFetch`'s `als` option.

**Side channel note**: ALS is a side channel and strongly discouraged as the primary data-flow mechanism. It exists as an opt-in escape hatch for cases where explicit data passing is impractical, but explicit arguments and return values are preferred.
