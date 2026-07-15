# Typed RPC/API Clients — Cross-Ecosystem DX Pain Points

A survey of what it actually feels like to *call* an API through a typed TypeScript client —
tRPC, Eden Treaty, OpenAPI-generated clients, GraphQL clients, and the smaller RPC-adjacent
libraries (ts-rest, Zodios, feTS). Scoped to the client/consumer experience specifically:
invocation ergonomics, error handling, cache/invalidation, type narrowing, and where the
promised end-to-end type safety breaks down in practice. Server/router-authoring pain is out
of scope except where it directly produces a client-visible symptom.

Two companion documents cover their frameworks in full (server + client):
[dx-pain-trpc.md](./dx-pain-trpc.md) and [dx-pain-elysia.md](./dx-pain-elysia.md) (Eden
Treaty section). This document pulls the client-relevant threads from those, adds the
libraries not covered elsewhere (OpenAPI clients, GraphQL clients, ts-rest, Zodios, feTS),
and looks for patterns that recur across all of them. No editorializing — what people
actually said hurts, with sources.

## tRPC client

The full write-up is in [dx-pain-trpc.md](./dx-pain-trpc.md); this section extracts what's
specifically about *calling* procedures rather than defining them.

- **Errors don't reach local error handlers the way users expect.** Developers report that
  `useQuery`/`useMutation` errors from tRPC's TanStack Query integration bubble to error
  boundaries instead of being catchable at the call site, and that there's no clear
  documented pattern for "handle this one error locally, let everything else go to a global
  handler." Evidence:
  [github.com/trpc/trpc discussion #4782](https://github.com/trpc/trpc/discussions/4782)
  ("how can i handle errors when using createTRPCReact?");
  [github.com/trpc/trpc discussion #2036](https://github.com/trpc/trpc/discussions/2036)
  ("Global Client Error Handling").
- **No structured, inferable error *shape* on the client** — only a message string and a
  fixed `TRPCError` code enum, so a caller can't type-narrow "this failed because of a
  validation error" vs. "this failed because of a business rule" without parsing the message.
  Evidence: [trpc/trpc issue #3438](https://github.com/trpc/trpc/issues/3438) ("feat:
  inferable errors from procedures"); [trpc/trpc issue #5581](https://github.com/trpc/trpc/issues/5581)
  ("feat: Client side error transformation").
- **Cache invalidation is manual and stringly-keyed in spirit even though it's typed.**
  There's no structured mapping from "this mutation" to "these queries it should invalidate"
  — teams either hand-maintain per-mutation invalidation lists that drift stale, or fall back
  to invalidating everything on any mutation. Evidence:
  [Steve Kinney — React Query + tRPC course notes](https://stevekinney.com/courses/react-typescript/react-query-trpc).
- **Invalidation and component-level `onSuccess` callbacks race.** Both `mutate()`'s own
  completion and a manual `invalidateQueries()` call can fire before a component's
  `onSuccess` handler runs, producing ordering bugs that are hard to reason about from the
  call site alone. Evidence:
  [discord-questions.trpc.io/m/1100118275347714180](https://discord-questions.trpc.io/m/1100118275347714180).
- **The cache-utilities handle itself churned across versions** (`useContext` → `useUtils`),
  so client code written against one version's invalidation API silently stops working or
  becomes unclear which API is current. Evidence:
  [trpc/trpc discussion #4780](https://github.com/trpc/trpc/discussions/4780).
- **Type narrowing at the call site degrades under router size**, independent of any logic
  bug — tsserver autocomplete/hover on a call like `trpc.foo.bar.useQuery()` can take 5–10+
  seconds on real routers because the whole router tree is one type the language server
  re-evaluates on every keystroke. This is a client-authoring-time cost, not a
  runtime one, but it's the dominant complaint about "using" tRPC day to day. Evidence:
  [discord-questions.trpc.io/m/1273877872872001637](https://discord-questions.trpc.io/m/1273877872872001637);
  [trpc.io/blog/typescript-performance-lessons](https://trpc.io/blog/typescript-performance-lessons).
- **Batching (on by default) makes the Network tab useless for attributing a slow or failed
  call to its call site** — many independent `useQuery`/`useMutation` invocations collapse
  into one `?batch=1` HTTP request, and a fast call gets stuck waiting on a slow one in the
  same batch. Evidence: [trpc/trpc discussion #1874](https://github.com/trpc/trpc/discussions/1874);
  [trpc/trpc issue #4343](https://github.com/trpc/trpc/issues/4343).
- **File/binary uploads are not a first-class call shape.** Calling a procedure with a
  `File`/`FormData` argument either fails outright on older versions or requires swapping in
  a different link (`httpLink` instead of the batch link) at the call site, breaking the
  "just call the function" pitch for that one class of call. Evidence:
  [trpc/trpc discussion #658](https://github.com/trpc/trpc/discussions/658);
  [discord-questions.trpc.io/m/1354932013152342297](https://discord-questions.trpc.io/m/1354932013152342297).
- **The "just call it like a function" model still requires whole-stack TypeScript and
  usually a monorepo** for the client to see real types at all — cross-repo or polyglot
  backends fall back to the client having no more type safety than a raw REST call.
  Evidence: [trpc/trpc discussion #1860](https://github.com/trpc/trpc/discussions/1860)
  ("Monorepo mandatory?").

## Elysia Eden Treaty

The full write-up is in [dx-pain-elysia.md](./dx-pain-elysia.md#eden-treaty-rpc-client--structural-and-ergonomic-complaints);
this section extracts and extends the client-calling-experience items.

- **Errors are returned, not thrown, and this breaks integration with anything that expects
  throw-on-failure semantics** (e.g. `react-query` never sees `.error` populated — the error
  lives inside `.data.error` instead — so `onError` callbacks never fire unless the caller
  manually overrides the `fetcher`/`onResponse` hook to re-throw). Evidence:
  [elysiajs/elysia issue #651](https://github.com/elysiajs/elysia/issues/651);
  [elysiajs/elysia discussion #432](https://github.com/elysiajs/elysia/discussions/432).
- **Request `body` types resolve to `any` in Eden Treaty on routes where Eden Fetch (the
  non-proxy sibling client) gets correct types** — meaning which client flavor you use for
  the *same* route changes whether you get type safety on the call, and this is not
  documented as an expected divergence. Evidence:
  [elysiajs/elysia issue #1666](https://github.com/elysiajs/elysia/issues/1666).
- **Path segments can go missing in the generated call surface.** A server route nested under
  a group (e.g. `/deep/nested`) has shown up on the Eden client as a single flattened
  property (`client.deepnested.get()`), producing a 404 at call time unless the caller
  manually retypes the path — which then loses type safety for that call.
  Evidence: [elysiajs/elysia discussion #432](https://github.com/elysiajs/elysia/discussions/432).
- **Root-level dynamic routes (`/:id`) have not been registered at all** in some Treaty
  versions — a straight regression versus the older client implementation, meaning calls to
  those routes aren't representable through the typed client at all, forcing a raw `fetch`
  fallback. Evidence: [elysiajs/elysia issue #823](https://github.com/elysiajs/elysia/issues/823).
- **Response-stream access is a client-side dead end without an unofficial patch.** Eden
  Treaty consumes the response body itself, so a caller who needs the raw
  `Response`/stream (e.g. for a file download) had no supported way to get it until a
  community PR added an undocumented `getRaw` escape hatch.
- **Eden Treaty is identified by users and maintainers as the type-inference-perf offender**
  of the framework, to the point of commenters suggesting it be deprecated in favor of Eden
  Fetch — i.e. the ergonomic, chainable client (`client.foo.bar.get()`) is the one paying the
  IDE-latency cost, while the lower-level, less pleasant-to-call client (`edenFetch`) is
  comparatively cheap. Evidence: [elysiajs/elysia issue #1031](https://github.com/elysiajs/elysia/issues/1031).
- **Monorepo path-alias fragility**: type inference across packages silently degrades to
  `any` unless the client's TypeScript config resolves the exact same path alias as the
  server (e.g. a Better Auth plugin used inside a module loses type inference entirely when
  imported into the main app, while the identical plugin at the app root infers fine).
  Evidence: [elysiajs/eden issue #215](https://github.com/elysiajs/eden/issues/215);
  [elysiajs/eden issue #110](https://github.com/elysiajs/eden/issues/110) ("Using typescript
  path aliases, eg. @app on the server break eden treaty typing").
- **Testing a route through the typed client silently becomes an end-to-end test.** The
  framework's own docs present calling through `edenTreaty` and calling `app.handle()`
  directly as type-safety-equivalent alternatives for tests, but only the latter is actually
  unit-testable — `edenTreaty` requires a real server listening or the test fails with
  `ConnectionRefused`. Evidence: [elysiajs/elysia discussion #535](https://github.com/elysiajs/elysia/discussions/535).
- **`@types/bun` is a hard dependency of the client package even for Node consumers**, an
  unexpected coupling for a client meant to be run from arbitrary environments.
  Evidence: [elysiajs/eden issue #189](https://github.com/elysiajs/eden/issues/189).

## OpenAPI-generated clients (openapi-typescript / openapi-fetch, hey-api, openapi-generator, Stainless)

Unlike tRPC/Eden, these clients are generated from a spec document rather than inferred live
from source, which trades away "always in sync with the handler" for "works across languages
and doesn't require a monorepo" — and introduces its own class of pain around the generation
step and error-handling conventions.

- **openapi-fetch returns errors instead of throwing them, and users repeatedly ask for the
  opposite.** The library's contract is `{ data, error }` on every call (never a rejected
  promise on a non-2xx response), which a meaningful fraction of users find unidiomatic
  next to `fetch`/axios conventions and have requested a `.throwOnError()` mode or config
  flag for. Evidence:
  [openapi-ts/openapi-typescript discussion #1875](https://github.com/openapi-ts/openapi-typescript/discussions/1875)
  ("fetch: throwing errors instead of returning them");
  [openapi-ts/openapi-typescript discussion #1316](https://github.com/openapi-ts/openapi-typescript/discussions/1316).
- **Forgetting response-format configuration produces a runtime throw on an otherwise
  successful call.** If an endpoint returns non-JSON content and the caller doesn't set
  `parseAs`, the call throws even though the HTTP request itself succeeded — a footgun tied
  to a parameter most callers don't know they need until they hit it.
  Evidence: [openapi-ts/openapi-typescript issue #1883](https://github.com/openapi-ts/openapi-typescript/issues/1883).
- **No built-in request/response interception.** Middleware-shaped needs (attach an auth
  header globally, log every call, retry on 401) aren't a first-class feature; users report
  being unsure how to layer this on top of the generated client at all.
  Evidence: [openapi-ts/openapi-typescript issue #1122](https://github.com/drwpow/openapi-typescript/issues/1122)
  ("Some sort of middleware support").
- **HTTP status codes are too coarse for callers who need to discriminate multiple failure
  modes under one code.** Users ask for richer, spec-derived error typing beyond "this was a
  4xx" so a caller can `switch` on what actually went wrong without re-parsing the body by
  hand.
- **hey-api/openapi-ts generated output has shipped with compile errors and naming
  collisions the consuming project can't fix without patching the generator.** Reported
  cases: a generated client referencing a `client` property that doesn't exist on its own
  `Options` type ([issue #1746](https://github.com/hey-api/openapi-ts/issues/1746)); a spec
  with a `"Request"` tag producing a generated `client.ts` with two conflicting `Request`-named
  exports that fail to compile
  ([issue #479](https://github.com/hey-api/openapi-ts/issues/479)); services generated with
  incorrect parameter ordering ([issue #991](https://github.com/hey-api/openapi-ts/issues/991));
  missing generated types (`TResult`, `TConfig`, `TApiResponse`)
  ([issue #36](https://github.com/hey-api/openapi-ts/issues/36)). In each case the caller's
  code is correct but doesn't compile because of what the generator emitted — a class of bug
  that's specific to codegen-based clients and doesn't exist for live-inferred ones.
- **Customizing per-request headers on the generated client is not straightforward** —
  users describe needing custom header resolvers with no documented supported path.
  Evidence: [hey-api/openapi-ts issue #1020](https://github.com/hey-api/openapi-ts/issues/1020).
- **Stainless-generated SDKs are a black box the consuming team doesn't control the shape
  of** — teams "accepted their opinion about what your SDKs should look like, and paid for
  the privilege," with the trade showing up concretely as heavier dependency graphs (one
  cited example: 25+ dependencies in a generated Cloudflare SDK) and OAuth flows that still
  require the caller to hand-write token storage/refresh/retry logic rather than getting it
  generated. Evidence: [Speakeasy — Speakeasy vs Stainless](https://www.speakeasy.com/blog/speakeasy-vs-stainless);
  [WorkOS — Stainless alternatives](https://workos.com/blog/stainless-alternatives). Also
  notable as an ecosystem-stability data point: Anthropic's acquisition of Stainless is
  winding down the hosted SDK generator product entirely, meaning teams that depended on it
  for continuously-regenerated clients need a migration plan. Evidence:
  [WorkOS — Stainless alternatives](https://workos.com/blog/stainless-alternatives).
- **openapi-generator's `typescript-fetch` target has its own error-shape gaps**: consumers
  have asked for the generated client to actually surface the error *message* the server
  sent rather than a generic failure, and middleware `onError` hooks don't fire for common
  statuses like 401. Evidence:
  [OpenAPITools/openapi-generator issue #17988](https://github.com/OpenAPITools/openapi-generator/issues/17988);
  [OpenAPITools/openapi-generator issue #17979](https://github.com/OpenAPITools/openapi-generator/issues/17979).
- **feTS (The Guild) explicitly markets itself as solving the codegen-step problem** — it
  infers client types live from an OpenAPI document without a build step, positioning itself
  against exactly this class of complaint (generated-file compile errors, staleness between
  spec and generated code). Whether it introduces its own live-inference cost (in the tRPC/Eden
  style) under large specs isn't documented in available sources — flagged as an open
  question rather than a claim. Evidence:
  [the-guild.dev — Consume OpenAPI in TypeScript Without Code Generation](https://the-guild.dev/blog/announcing-fets-client).

## GraphQL clients (Apollo Client, urql)

GraphQL clients are the oldest typed-client category here and the comparison point most of
the others implicitly react against (tRPC and Eden's pitches are explicitly "GraphQL-level
type safety without the GraphQL machinery"). The client-side pain clusters around caching
semantics and the codegen step needed to get types at all.

- **Without codegen, Apollo Client queries are not type-safe at the call site** — the
  in-house pain of hand-writing and hand-maintaining TypeScript types for every query/mutation
  result is the reason `graphql-code-generator` exists as a near-mandatory companion tool
  rather than an optional add-on. Evidence:
  [dev.to — GraphQL Code Generator with TypeScript, React and Apollo Client](https://dev.to/codenamegrant/graphql-code-generator-with-typescript-react-and-apollo-client-4c7b).
- **Custom scalars are cumbersome on the client with scarce documentation.** Getting a
  non-JSON-primitive scalar (e.g. `DateTime`) to come back as a real typed/parsed value on
  the client, rather than a raw string the caller has to convert by hand, either requires an
  Apollo Link doing serialization work in the cache layer (which needs the whole schema
  shipped to the browser to work, impractical for large schemas) or hand-rolled conversion at
  every call site.
- **Normalized-cache correctness is the single largest source of "why did my UI not update"
  bugs**, and this is a genuinely hard, not incidental, problem: the cache doesn't reliably
  invalidate on mutations that create/delete an entity (the cache doesn't know whether to
  insert/remove it from a list, or which list), and types without a stable key (`id`) —
  edges, `GeoJson`, embedded value objects — require manual `keyFields`/embedded-key
  configuration to cache correctly at all. Evidence:
  [urql-graphql/urql — normalized caching docs](https://nearform.com/open-source/urql/docs/graphcache/normalized-caching/);
  general framing corroborated in
  [pkgpulse.com — Apollo Client vs urql in 2026](https://www.pkgpulse.com/guides/apollo-client-vs-urql-2026).
- **urql's simpler document cache has its own silent-staleness failure mode**: when a query
  returns `null` or an empty array, urql can't derive the `__typename` that a later mutation
  would need to invalidate, so the cache doesn't refresh even though the underlying data
  changed — an easy-to-miss bug because it only manifests on the empty-result path.
- **Migrating between urql's two cache strategies (document cache → normalized/Graphcache)
  is not a smooth incremental step** — both have distinct failure points, so switching means
  re-auditing cache behavior project-wide rather than flipping a config flag.
  Evidence: [urql-graphql/urql issue #3470](https://github.com/urql-graphql/urql/issues/3470)
  ("RFC: Consolidating document and normalised caching - safer caching").
- **Fragment colocation + data masking (`useFragment`) adds a second type-safety layer with
  its own footguns on top of what TypeScript already provides.** Callers must pass the exact
  same variables to `useFragment` that were passed to the originating `useQuery`, or the
  fragment can't be located in the cache — a runtime-only failure mode (returns `null`/wrong
  data) with no compile-time signal that the variables mismatched. The mechanism (masking a
  component from data it didn't explicitly fragment-request) is also reported as genuinely
  hard for less experienced engineers to reason about, on top of GraphQL's existing
  complexity. Evidence:
  [Apollo GraphQL blog — Optimizing Data Fetching with Apollo Client](https://www.apollographql.com/blog/optimizing-data-fetching-with-apollo-client-leveraging-usefragment-and-colocated-fragments);
  [dotansimha/graphql-code-generator discussion #8554](https://github.com/dotansimha/graphql-code-generator/discussions/8554).
- **Generated-hook bundle size is a recurring complaint at scale.** The default single-file
  codegen output for typed documents/hooks has caused bundle-size regressions large enough
  that dedicated Babel/SWC plugins were built specifically to strip/optimize it, and the
  "just split into per-document files" workaround needed manual restructuring rather than a
  supported flag. Evidence:
  [dotansimha/graphql-code-generator discussion #9993](https://github.com/dotansimha/graphql-code-generator/discussions/9993);
  [the-guild.dev — Optimize your Bundle Size with SWC and GraphQL Codegen](https://the-guild.dev/graphql/hive/blog/optimize-bundle-size-with-swc-and-graphql-codegen).
- **The `client-preset` codegen output has not reliably generated Apollo React hooks even
  when explicitly configured to.** Evidence:
  [dotansimha/graphql-code-generator discussion #9563](https://github.com/dotansimha/graphql-code-generator/discussions/9563).
- **Where Apollo's richer normalized cache wins on complex update scenarios (optimistic
  updates, paginated list management), urql's simpler cache is reported as the better fit
  only for straightforward CRUD** — i.e. neither client's caching model is a strict
  superset of the other's, so the "pick a GraphQL client" decision is itself a
  workload-dependent tradeoff with real switching cost later. Evidence:
  [pkgpulse.com — Apollo Client vs urql in 2026](https://www.pkgpulse.com/guides/apollo-client-vs-urql-2026).

## Other typed RPC/REST approaches (ts-rest, Zodios, feTS)

- **ts-rest's default client routes error responses through the same success path as a
  caller's `onSuccess` callback**, meaning error handling can't be done in the idiomatic
  "onError vs onSuccess" split that TanStack Query callers expect — all responses,
  success or failure, land in the same place and the caller has to branch on status
  manually inside what's nominally the success handler. A client that throws on non-2xx (the
  more conventional shape) was requested as a separate, opt-in client rather than the
  default. Evidence: [ts-rest/ts-rest issue #520](https://github.com/ts-rest/ts-rest/issues/520)
  ("Feature Request: Create new ts-rest client that throws exceptions for error responses").
- **Optional path parameters are silently dropped from the request URL.** A contract path
  like `/applications/:id/:version?` with `version` supplied by the caller does not actually
  interpolate it into the outgoing request — the parameter is accepted by the types but
  discarded at call time, a divergence between what compiles and what the client actually
  sends over the wire. Evidence: [ts-rest/ts-rest issue #622](https://github.com/ts-rest/ts-rest/issues/622).
- **Large contracts reproduce the same tsserver-latency cliff seen in tRPC and Eden.** Users
  report build times exceeding 40 seconds and IDE autocomplete taking 10+ seconds once a
  contract grows large, with the root cause identified as the same one as tRPC's: the whole
  contract is one type the language server re-evaluates per edit. Evidence:
  [ts-rest/ts-rest issue #764](https://github.com/ts-rest/ts-rest/issues/764) ("Deal with
  massive contract/router/client and avoid very slow build time / IDE completion").
- **Response validation silently doesn't run for non-JSON content types even when
  `validateResponse: true` is explicitly set** — the caller opts into runtime validation of
  the typed response and doesn't get it for a whole class of content type, with no error
  surfaced to indicate validation was skipped. Evidence:
  [ts-rest/ts-rest issue #789](https://github.com/ts-rest/ts-rest/issues/789).
- **Zodios (the original package) is effectively abandoned** — last substantive release
  activity dates to 2022, one maintainer, and the project's own docs now point users to a
  community fork (`@zodios/core`) as the maintained successor, meaning anyone who adopted the
  original package for its typed-client pitch inherited an unmaintained dependency. Evidence:
  [npmx.dev — zodios](https://npmx.dev/package/zodios).
- **Zodios has its own tsserver-losing-track-of-types failure mode**, where VS Code's
  TypeScript server intermittently drops the inferred Zodios client types entirely (falling
  back to `any` across the board), and the only reported fix is restarting the TS server —
  not a code change on the user's part. Evidence:
  [ecyrbe/zodios discussion #249](https://github.com/ecyrbe/zodios/discussions/249)
  ("Constantly restarting the TS Server to have the types").
- **feTS's pitch (typed OpenAPI client with zero codegen step) puts it in direct contrast
  with the openapi-typescript/hey-api generated-file failure modes above**, but available
  sources don't document its own DX pain in the same depth the more widely-adopted clients
  have accumulated — plausibly a maturity/adoption artifact (fewer users hitting fewer edge
  cases) rather than evidence the approach avoids the underlying tradeoffs. Flagged as an
  open question rather than a finding. Evidence:
  [the-guild.dev/fets](https://the-guild.dev/fets); [learnwithjason.dev — Make the Fetch API
  type-safe with feTS](https://learnwithjason.dev/make-the-fetch-api-type-safe-with-fets).

## Cross-cutting patterns

Themes that recur across three or more of the approaches above, rather than being specific
to any one library:

- **Live type inference (tRPC, Eden Treaty, ts-rest, feTS, Zodios) buys "always in sync,
  zero codegen step" at the cost of a tsserver-latency cliff that shows up independently in
  every one of them once the API surface crosses roughly dozens-to-low-hundreds of
  endpoints.** The root cause is structurally identical across all of them: the entire
  route/procedure/contract tree is one type the language server must re-evaluate on every
  keystroke, and every project's own maintainers describe this as a hard, only-partially-
  solved problem rather than a bug with a known fix.
- **Codegen-based clients (OpenAPI generators, GraphQL codegen) trade that latency problem
  for a different one: generated-file correctness bugs that are outside the calling code's
  control** — naming collisions, missing types, incorrect parameter ordering — where the
  caller's own code is right but doesn't compile because of what the generator emitted.
  Neither family is strictly better; they fail in different places (edit-time vs.
  generation-time).
- **"Should the client throw or return errors" is an unresolved, recurring design fork**,
  independently re-litigated in tRPC (React Query error propagation), Eden Treaty (`data.error`
  vs. thrown), openapi-fetch (`{data,error}` vs. `.throwOnError()`), and ts-rest (all
  responses routed through `onSuccess`) — every library picked one convention, and every
  library has an open issue thread of users asking for the other one.
- **Cache/invalidation correctness is manual and error-prone everywhere it exists as a
  concept** (tRPC + React Query, Apollo's normalized cache, urql's document and normalized
  caches) — none of the surveyed clients derive "what should this mutation invalidate" from
  the type system; it's tracked by hand in every case, and going stale silently is the
  dominant symptom across all three.
- **Monorepo/build-topology fragility is a recurring, usually undocumented failure mode**
  for the live-inference clients specifically (tRPC needs the client to import the server's
  router *type*; Eden Treaty degrades to `any` across mismatched path aliases) — the
  "zero-ceremony, just call it" pitch depends on infrastructure (shared tsconfig, monorepo or
  published types package) that isn't part of the pitch itself and isn't visible until it
  silently stops working.
