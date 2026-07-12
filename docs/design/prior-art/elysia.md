# Prior art: Elysia (elysiajs/elysia)

Research notes on architecture and type-level patterns. Sourced from DeepWiki
(deepwiki.com/elysiajs/elysia), elysiajs.com docs, and the `elysiajs/eden`
source (cloned to inspect `src/treaty2/index.ts` directly — that part is a
direct read, not a secondhand summary). Everything else below is secondhand
(web search / DeepWiki summaries), not verified against Elysia's own source.

## 1. Route definition / plugin composition model

- Routes are defined via method chaining on an `Elysia` instance:
  `.get()`, `.post()`, etc. Each call returns a new (type-widened) instance.
- **Plugins are just Elysia instances.** Composition is `.use(plugin)` —
  there's no separate plugin type; a plugin IS an `Elysia` object, and `.use`
  merges its routes, state, decorators, and hooks into the parent.
- Three-tier scoping controls how state/hooks propagate through composition:
  - **Singleton** — global, accessible everywhere.
  - **Ephemeral** — scoped to a plugin and its children, not visible to parents.
  - **Volatile** — local to a single route, doesn't propagate at all.
- Merge semantics on composition: primitive state values overwrite; object
  state deep-merges (`mergeDeep`). Validators follow local > scoped > global
  precedence. Hooks concatenate across the composition chain but are
  deduplicated via checksums so re-`.use()`-ing the same plugin doesn't
  double-register hooks.

## 2. Type system / end-to-end type safety

- Single source of truth: a schema (TypeBox `t.Object(...)`, or any Standard
  Schema-compatible validator) produces both the runtime validator and the
  TypeScript type, via a type utility called `UnwrapRoute`.
  - TypeBox schemas: static type extracted via `TImport<Definitions,
    '__elysia'>['static']`.
  - Standard Schema: extracted via `Schema['~standard']['types']['output']`.
  - Named model references: resolved recursively against a `Definitions`
    registry (Elysia's `.model()` store).
- `Context<...>` is generic over three type parameters and assembles:
  `body`, `query`, `params`, `headers`, `cookie` (from schema), plus
  `request`, `set`, `server`, `path`, `route` (runtime metadata).
- Path params are extracted at the type level: `ResolvePath` /
  `GetPathParameter` parse the route string, splitting on `:name` and
  `*wildcard` segments, marking `name?` as optional — so
  `/user/:id/posts/:postId?` types `params` as `{ id: string; postId?:
  string }` purely from the string literal type of the path.
- Context has different shapes at different lifecycle stages:
  - `PreContext` (onRequest/onStart) — minimal, pre-validation.
  - `Context` (handlers, most hooks) — fully merged/validated types.
  - `ErrorContext` (error handlers) — partial/defensive types (e.g. `query`
    falls back to `Record<string, string | undefined>` since validation may
    not have succeeded).
- Four "singleton" type layers accumulate across plugin/`.use()` boundaries
  and merge via `Reconcile` / `MergeSchema` utilities:

  | Layer | Method | Access | Available from |
  |---|---|---|---|
  | Decorator | `.decorate()` | spread into context | all hooks |
  | Store | `.state()` | `c.store.x` | all hooks |
  | Derive | `.derive()` | direct context prop | after `onTransform` |
  | Resolve | `.resolve()` | direct context prop | after `beforeHandle` |

- Because each `.derive()`/`.resolve()`/`.decorate()`/`.state()` call returns
  a *new* Elysia instance typed with the widened context, type accumulation
  is purely structural — no code generation, just chained generic inference.
- Heavy use of newer TS features (const type parameters, template literal
  types) to keep inference fast/precise for route-path literal parsing.

## 3. Lifecycle / middleware

Request handling is divided into four phases, each with hooks:

1. **Pre-processing** — `onRequest` (can short-circuit by returning a
   response), `onParse` (body parsing, falls back to default per
   content-type), `onTransform` (post-parse, pre-validation context edits).
2. **Validation** — automatic, against the route's schema.
3. **Handler execution** — `resolve` (post-validation, can be async),
   `beforeHandle` (can short-circuit by returning non-`undefined`), the
   route handler itself, `afterHandle` (can transform the handler's return
   value).
4. **Response processing** — `mapResponse` (final transform before
   serialization), `onAfterResponse` (async, post-send cleanup/telemetry).
   `onError` catches thrown errors/specific error codes at any stage.

- Hooks declare a scope (`local` / `scoped` / `global`) controlling whether
  they apply to just the current route, the current plugin + its children,
  or the whole app — same three-tier idea as state scoping.
- **AOT (ahead-of-time) compilation**: when enabled, Elysia statically
  compiles the whole hook pipeline + handler into a single optimized
  function per route, rather than looping over hook arrays at request time.
- **Sucrose** is the static-analysis pass that makes this worthwhile: it
  inspects each handler/hook body to see which `Context` properties (body,
  query, headers, etc.) are actually referenced. If a hook type has no
  registrations, its execution branch is dead-code-eliminated from the
  compiled function; if a handler never touches `body`, body parsing can be
  skipped entirely at runtime. This ties type-level context modeling
  directly to a runtime performance optimization.

## 4. Derive / resolve (context-building DI)

- `.derive(fn)` — runs synchronously, early (right after `onTransform`, so
  before validation is even guaranteed complete in some framings, but after
  transform). Returns an object whose keys get merged directly onto
  `Context` (not nested under a namespace).
- `.resolve(fn)` — same shape/contract but runs later, after `beforeHandle`,
  and can be async — meant for things that depend on validated
  input/guards (e.g. auth lookups gated by a `beforeHandle` guard).
- Both are essentially typed middleware-as-context-mutation: instead of
  attaching arbitrary values to a request object, the return type of the
  derive/resolve function widens the generic `Context` type for every
  handler declared after that point in the chain — this is the core DI
  mechanism, entirely at the type level with zero runtime reflection.

## 5. OpenAPI / Swagger generation

- Provided by a separate plugin (`@elysiajs/swagger`, being superseded by
  `elysia-openapi`), mounted like any other plugin; exposes a docs UI
  (Scalar) at a route like `/openapi`.
- Generation is schema-first by default: each route's `t.Object(...)` etc.
  schemas for params/query/body/response are walked and converted straight
  to OpenAPI schema objects — the same schema that drives runtime validation
  and TS type inference is the third leg of the stool (docs).
- Newer "OpenAPI Type Gen" feature extends this to *unannotated* handlers:
  it infers OpenAPI schema from the handler's inferred TypeScript return
  type (e.g. a Drizzle query result) without requiring an explicit `t.*`
  schema. Explicit schemas still take priority; type-gen is the fallback.
- Net effect: routes are "inspectable" because schema/type metadata is
  attached to the route object itself (not just closures), so a plugin can
  walk the route table and read each route's schema without executing it.

## 6. Eden Treaty (typed client SDK)

Verified by reading `elysiajs/eden`'s `src/treaty2/index.ts` directly.

- No code generation. The server exports its own type: `export type App =
  typeof app`. The client calls `treaty<App>(url)`, and `App` is purely a
  generic type parameter — TypeScript inference reconstructs the whole
  route tree's argument/response types from it at the call site.
- Runtime side is a **recursive ES `Proxy`** (`createProxy` in
  `treaty2/index.ts`):
  - The target is a no-op function `() => {}`.
  - `get(_, param)` — for any property access, returns
    `createProxy(domain, config, [...paths, param])`, i.e. every `.foo`
    access just accumulates `param` onto a `paths` array and returns
    another proxy. This is how `client.users({ id }).posts.get()` style
    chains build up a path without any of it existing as real methods —
    dots become path segments (mirroring the special-cased `~path`
    property used internally, and short-circuiting `then/catch/finally` at
    the root so the proxy isn't mistaken for a thenable).
  - `apply(_, __, [body, options])` — invoked when the chain is finally
    *called* as a function (e.g. `.get()`, `.post(body)`). At this point the
    last path segment is popped off as the HTTP method, the rest joined
    with `/` as the URL path, query/body/headers are assembled from the
    call arguments, and an actual `fetch` (or user-supplied `fetcher`) is
    issued. GET/HEAD/subscribe requests move `query`/`headers` into the
    first argument rather than a second `options` argument; `subscribe`
    rewrites the URL scheme to `ws://`/`wss://` and returns an `EdenWS`
    wrapper instead of doing a fetch.
- So the entire "SDK" is: one lazy Proxy that defers all real work to the
  terminal `apply` trap, plus a type-only generic parameter (`App`) that
  gives that untyped runtime object its typed call signatures. Types and
  runtime are fully decoupled — the proxy has no knowledge of the schema at
  runtime; only `tsc` connects `App`'s route shape to what's a legal
  `.foo.bar.post(...)` chain and what its return type is.

## Sources

- https://deepwiki.com/elysiajs/elysia
- https://deepwiki.com/elysiajs/elysia/3.3-context-and-type-inference
- https://deepwiki.com/elysiajs/elysia/2.2-lifecycle-hooks
- https://deepwiki.com/elysiajs/elysia/4-plugin-system (page title only
  partially matched; content came back as a plugin-system summary)
- https://elysiajs.com/eden/overview
- https://elysiajs.com/eden/treaty/overview
- https://elysiajs.com/patterns/openapi
- https://elysiajs.com/blog/openapi-type-gen
- https://github.com/elysiajs/elysia-openapi
- `elysiajs/eden` repo, `src/treaty2/index.ts` and `src/treaty2/types.ts`
  (cloned locally and read directly, not summarized secondhand)
