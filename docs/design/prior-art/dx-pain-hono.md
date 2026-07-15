# Hono — DX Pain Points (User Research)

Real complaints from GitHub issues, discussions, Hacker News, and blog posts. Grouped by
theme. No editorializing — what people actually said hurts.

## RPC Type Inference — Build/IDE Performance

- **Compiling the whole app just for API types.** A user reported ~8 minutes of CI compile
  time with esbuild on an app with hundreds/thousands of routes, because Hono infers the
  `Context` type per-route and extends it router by router — meaning the ORM, business
  logic, and everything else the app touches gets pulled into the type-check just to produce
  request/response types for the RPC client. Live reload dropped from ~2 minutes to ~10
  seconds only after splitting routers into separate esbuild libraries and skipping
  type-checking in dev. ([GitHub issue #3869](https://github.com/honojs/hono/issues/3869))
- **IDE slows down as routes grow.** "The more routes you have, the slower your IDE will
  become" — attributed to the volume of type instantiations needed to infer the whole app's
  type. (Referenced across [#3869](https://github.com/honojs/hono/issues/3869) and related
  discussion)
- **Monitoring type-check performance became its own issue.** The maintainers opened a
  tracking issue specifically because changes to the router/type internals could silently
  regress type-check speed, with no CI signal catching it.
  ([GitHub issue #3377](https://github.com/honojs/hono/issues/3377))
- **Regressions between versions.** RPC client type inference silently degraded to
  `unknown` after upgrading from Hono 4.10.8 to 4.11.0+ in a Turborepo-managed project,
  fixed only by downgrading. ([GitHub issue #4638](https://github.com/honojs/hono/issues/4638))
- Other reported type-inference breakages: generic types not resolving on the client
  ([#3738](https://github.com/honojs/hono/issues/3738)), nested/deeply-typed routes losing
  inference in a monorepo (Answer Overflow thread), and a separate client-side inference bug
  ([#3749](https://github.com/honojs/hono/issues/3749)).

## RPC — Structural Requirements That Aren't Obvious Upfront

- **Routes must be method-chained or RPC types break.** Writing routes as separate
  statements (`app.get(...); app.post(...)`) instead of chaining
  (`app.get(...).post(...)`) silently degrades type inference for the RPC client — nothing
  errors, the types are just wrong/missing. This is a widely repeated gotcha across Discord
  (Answer Overflow) and docs, not something intuited from normal Express-style route
  registration.
- **Same requirement leaks into testing.** `hono/testing`'s `testClient` only produces
  type-safe test clients for routes defined with the chained style directly on the `Hono`
  instance — routes registered separately lose type info in tests too.
  ([GitHub issue #4050](https://github.com/honojs/hono/issues/4050))
- **Splitting routes into separate files/modules loses RPC types** unless done carefully
  with re-exported chained sub-apps — reported as "no types for RPC with abstracted routes"
  (Answer Overflow / Discord).
- **Monorepo setup friction:** getting `AppType` to flow from server to client package
  requires TypeScript project references, matching Hono versions on both sides, and
  `"strict": true` in both tsconfigs — undocumented failure modes if any of these are off.
  ([catalins.tech writeup](https://catalins.tech/hono-rpc-in-monorepos/),
  [GitHub discussion #4643](https://github.com/orgs/honojs/discussions/4643))
- **Env types leak across the monorepo boundary.** With Nx/esbuild builds, the frontend
  build complains about missing *backend* environment/binding types, even though those
  should be irrelevant to a pure API-shape import.

## Context Variables (`c.get`/`c.set`) — Optimistic Typing

- **`c.get()` looks type-safe even when the setting middleware was never registered on that
  route.** Because `ContextVariableMap`/generic `Variables` types are declared globally,
  every handler sees the variable as present regardless of whether the middleware that sets
  it actually runs on that route — a silent trust boundary rather than a checked one.
  ([GitHub discussion #3257](https://github.com/orgs/honojs/discussions/3257),
  [issue #472](https://github.com/honojs/hono/issues/472))
- **The "fix" (marking the variable optional) pushes redundant guards into every handler**
  that legitimately does have the middleware applied, because the type system can't express
  "present here, absent there" per-route — it's global to the `Env` generic.
- Hono's own docs/maintainer framing acknowledges this is a deliberate DX-vs-safety
  trade-off: the type system is "optimistic" and assumes the developer keeps middleware
  registration and type declarations in sync by discipline, not enforcement.

## Validation — Verbose Defaults, Rewrites Required for OpenAPI

- **Default `zValidator` error responses are verbose** — a `{ success: false, error: { issues: [...] } }` shape with full Zod issue objects, when many users just want
  `{ message: "..." }`. Multiple threads show people writing custom error-callback
  overrides to normalize this rather than using it as-is.
  ([Answer Overflow thread](https://www.answeroverflow.com/m/1345669421745569842))
- **Retrofitting `@hono/zod-openapi` onto an existing app means rewriting routes**, not
  adding a layer. `createRoute()` + `.openapi()` is a different route-registration API from
  plain `app.get()`, so adopting OpenAPI generation after the fact means touching every
  route, described as "a huge turnoff" for existing codebases. This is what motivated
  alternative packages (`hono-openapi`, `@paolostyle/hono-zod-openapi`) built specifically
  to bolt OpenAPI onto unmodified route definitions via middleware instead.
  ([GitHub discussion #4621](https://github.com/orgs/honojs/discussions/4621),
  [dev.to writeup](https://dev.to/mathuraditya7/introducing-hono-openapi-simplifying-api-documentation-for-honojs-2e0e))
- Type inference specifically breaks for path parameters when combining zod-openapi with
  certain param patterns. ([GitHub issue #2525](https://github.com/honojs/hono/issues/2525))

## Routing — Trailing Slash Inconsistencies

- **Root path without trailing slash misroutes.** A POST to the bare root URL (no trailing
  slash) 404s instead of hitting the `/` handler, and the logger reports a mangled path
  (`"m"` instead of the actual path) in the failure case.
  ([GitHub issue #3251](https://github.com/honojs/hono/issues/3251))
- **Middleware doesn't run consistently based on trailing slash** on grouped/mounted routes
  — `jwtMiddleware` executes for `/foo/` but not `/foo` in the same route group.
  ([GitHub issue #4004](https://github.com/honojs/hono/issues/4004))
- **`trimTrailingSlash` doesn't apply to wildcard (`*`) routes**, requiring the separate
  `alwaysRedirect` option to redirect before handler execution instead of relying on the
  default 404-triggered redirect. ([GitHub issue #3407](https://github.com/honojs/hono/issues/3407))
- **`serveStatic` broke on URLs with trailing slashes** — requests like `/posts/hello-world/`
  stopped resolving to `index.html` as expected.
  ([GitHub issue #3238](https://github.com/honojs/hono/issues/3238))
- **`mergePath` inserts an unwanted trailing slash** when the first path segment is `/`,
  polluting generated OpenAPI paths (`/v1/` instead of `/v1`).
  ([GitHub issue #3909](https://github.com/honojs/hono/issues/3909))

## Error Handling

- **`notFound` handler doesn't fire for sub-apps mounted via `.route()`** — the parent app's
  `notFound` handler wins even when the request clearly falls inside a sub-app's namespace,
  which is not the behavior people expect from a "mounted app" mental model.
  ([GitHub issue #3465](https://github.com/honojs/hono/issues/3465))
- **Docs for `onError` were considered incomplete enough that a tracking issue was opened**
  just to ask for a complete worked example, rather than the current fragments.
  ([GitHub issue #2603](https://github.com/honojs/hono/issues/2603))
- **Errors thrown from inside custom error-handling code fall back silently** to a default
  response rather than surfacing anywhere — deliberate (to avoid `onError` re-entering
  itself), but a source of confusion when a localization/formatting callback inside an error
  handler throws and the failure is swallowed rather than logged.

## JSX / Streaming SSR

- **`ErrorBoundary` breaks under SSE streams.** SSE output isn't a normal HTML stream, and
  `ErrorBoundary` — built assuming standard HTML streaming — sends a placeholder chunk
  instead of the real SSE content when an error boundary is active.
  ([GitHub issue #3319](https://github.com/honojs/hono/issues/3319))
- **A request-isolation bug in SSR context storage**: during streaming SSR, context was
  briefly stored process-wide rather than per-request, so `useContext()`/
  `useRequestContext()` called after an `await` inside an async component could read another
  concurrent request's value — a cross-request data leak / wrong-authorization-context bug
  class, not just a cosmetic glitch.
- **Hono's JSX doesn't compose cleanly with a Vite dev-server React/SSR setup**: Vite's own
  middleware is a Connect-style handler expecting a raw `IncomingMessage`, which Hono's
  `Context` doesn't provide, so the two middleware models don't interop directly.
  ([GitHub issue #3162](https://github.com/honojs/hono/issues/3162))

## Node.js Adapter / Runtime Portability

- **Hono is noticeably slower on Node than on Bun/edge runtimes** because the Node adapter
  has to convert between Web Standard `Request`/`Response` and Node's native
  `http.IncomingMessage`/`ServerResponse` on every request — described in community
  discussion as "very slow" enough that maintainers were reluctant to publish the Node
  numbers next to Bun's. (Referenced in
  [GitHub discussion #1483](https://github.com/orgs/honojs/discussions/1483) and
  surrounding threads)
- Node support was not part of Hono's original design (edge/Worker-first); the Node adapter
  is a retrofit, requires Node 20+, and users hit friction moving an app that worked on
  Bun/Workers onto plain Node.
- **Lambda packaging friction**: a Hacker News commenter noted that despite the multi-runtime
  pitch, deploying to Lambda still runs into practical space/package constraints, and
  articulated a preference for "one package to deploy" over per-endpoint packaging,
  especially when planning provisioned concurrency.
  ([HN discussion](https://news.ycombinator.com/item?id=39314523))

## Testing

- **Testing bindings-heavy routes (D1/KV/etc.) is harder than testing plain routes** —
  basic route tests work out of the box, but anything touching Cloudflare Workers bindings
  requires extra setup that isn't well covered by the built-in testing helper.
  ([GitHub discussion #1549](https://github.com/orgs/honojs/discussions/1549))
- **`OpenAPIHono` apps don't work with the same test setup that works for plain `Hono`** —
  a user reported unit tests passing for a vanilla Hono app with esbuild-jest but failing
  once the app used `OpenAPIHono`. ([GitHub issue #284](https://github.com/honojs/middleware/issues/284))
- **Requests for handler-level testing utilities** (testing a handler built via
  `factory.createHandlers()` in isolation, without spinning up the full app/testClient) —
  filed as a feature gap rather than something already supported.
  ([GitHub issue #4116](https://github.com/honojs/hono/issues/4116))

## Version Upgrade Fragility

- **A Hono patch-level bump (4.6.16 → 4.6.17) broke `hono-openapi` integration**, producing
  widespread type errors in `.post()` calls; downgrading Hono resolved it. This was a third-
  party middleware breaking against a semver-minor/patch Hono release, not a major-version
  migration. ([GitHub issue #3884](https://github.com/honojs/hono/issues/3884))
- **JSX types stopped working in the TypeScript Playground between 4.3.11 and 4.4.0**,
  surfacing as a missing `hono/jsx/jsx-runtime` module path error — a break in an
  environment (Playground) that has no visibility into `node_modules` resolution quirks.
  ([GitHub issue #3956](https://github.com/honojs/hono/issues/3956))

## Framework Legibility (first-contact complaints)

- **"What does Hono actually do?"** — Hacker News commenters on the initial release threads
  noted the docs' snippets page was empty and several example READMEs were nearly blank,
  leaving newcomers unclear on what problem the framework solves versus Express/Fastify.
  ([HN discussion](https://news.ycombinator.com/item?id=40047212))
- **Ambiguity about what "any JS runtime" means in practice** — a commenter questioned
  whether the "runs anywhere" pitch counts if it still doesn't run directly in a browser
  main-thread context, only Worker-style runtimes.
