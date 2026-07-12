# Hono — Architecture Notes

Prior-art research into composition patterns, runtime model, and OpenAPI integration.

## Route and Middleware Composition

Each `Hono` app holds a pluggable `router` and a `routes` array. `.get/.post/.use` etc.
call `#addRoute()` which normalizes the method, merges the base path, and registers into
the router.

On `fetch()`, `#dispatch()` extracts the path, calls `router.match(method, path)` to get a
`matchResult` (array of matched handlers in registration order + extracted params), builds a
`Context`, and runs them through `compose()` — a Koa-style onion middleware chain where each
handler receives `(c, next)` and calls `next()` to proceed. If only one handler matched,
Hono skips the compose machinery entirely (perf fast-path).

Sub-apps (`.route()`) are mounted by merging their compiled routes into the parent under a
base path — they are flattened, not opaque middleware.

## Context Object

`Context<E extends Env, P extends string, I extends Input>` wraps:

- `req` — `HonoRequest` (typed path/query params)
- `res` — outgoing Response
- `env` — runtime bindings (Cloudflare KV/D1/vars, Deno env, etc.)
- variables store — `c.set(key, value)` / `c.get(key)` / `c.var`

Typing flows from the generic `E` (`{ Bindings, Variables }`) declared at
`new Hono<Env>()`. Middleware that add typed variables use `createMiddleware<Env>()` or
chained generics; `.use()`'s return type accumulates variable types across the chain
(type-level composition, not runtime magic) so `c.get('key')` is inferred downstream.

## Multi-Runtime Support

Hono core operates purely on the standard `Request`/`Response` (Fetch API). Each runtime
gets a thin adapter (`@hono/node-server`, etc.) that:

1. Translates the platform's native request (e.g. Node `http.IncomingMessage`) into a
   standard `Request`.
2. Calls `app.fetch(request, env, executionCtx)`.
3. Writes the returned `Response` back out.

The core architectural bet: build against the Fetch API standard, isolate platform glue at
the edges.

## OpenAPI Integration (zod-openapi-hono)

`createRoute()` builds a `RouteConfig` object (method, path, param/query/body/response Zod
schemas) plus a `getRoutingPath()` helper that converts OpenAPI `{id}` syntax to Hono's
`:id`.

`OpenAPIHono.openapi(route, handler)` does two things:
1. Registers the handler normally (so it is a real, runnable Hono route).
2. Records the `RouteConfig` into an `OpenAPIRegistry`.

Calling `.getOpenAPIDocument()` later runs `OpenApiGeneratorV3/V31.generateDocument()` over
everything the registry accumulated, producing the spec. Route definition and doc generation
are fully decoupled — the schema object is inspectable data, not inferred from runtime
behavior.

## Router Implementations

Hono ships multiple interchangeable routers behind one interface:

- **RegExpRouter** (default, fastest) — builds a `Trie` from all registered paths, compiles
  it into a single combined regular expression for one-shot matching, plus a `staticMap` for
  O(1) exact-path lookups.
- **TrieRouter** (simpler, more flexible for edge cases like inline regex patterns) — a
  straightforward Node-based trie traversed per-request.
- **PatternRouter / LinearRouter** — for smaller / simpler deployments (bundle size over
  perf).

Users select a router explicitly; the choice is a perf/bundle-size tradeoff per deployment
target.

---

Sources: `src/hono-base.ts`, `src/context.ts`, `src/router/reg-exp-router/router.ts`,
`src/router/trie-router/router.ts` (honojs/hono, main); `@hono/zod-openapi` `src/index.ts`
(honojs/middleware, main).
