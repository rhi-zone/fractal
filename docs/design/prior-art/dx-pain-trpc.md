# tRPC — Real-World DX Pain Points

A survey of complaints actually voiced by tRPC users — GitHub issues/discussions, the
tRPC Discord (mirrored at discord-questions.trpc.io), Reddit, and blog posts. Grouped by
theme. Each entry: what hurts, and where the complaint was found. No commentary on
whether/how these should inform Fractal — just the raw pain.

## TypeScript compiler / editor performance

- **"Type instantiation is excessively deep" past a certain router size.** Under tRPC v9,
  routers above a certain number of endpoints became literally unusable because
  TypeScript refused to fully evaluate the accumulated types.
  Evidence: [trpc/trpc discussion #3939](https://github.com/trpc/trpc/discussions/3939)
  ("trpc causes typescript to 'suck in' the entire backend, causing very slow build times
  and lots of compilation errors"); [trpc/v10-playground issue #5](https://github.com/trpc/v10-playground/issues/5).

- **VS Code / tsserver becomes unusably slow on real-world routers.** Reports of 5–10+
  second delays for autocomplete or hover-type info after edits, scaling badly with
  router count and procedure count. One report: "with a root router made up of 6 routers
  with about 10-15 procedures each, intellisense takes ~5s for every change made to a tsx
  file." Another: teams with ~30 routers merged via `mergeRouters` see 10s+ Intellisense
  opens.
  Evidence: [discord-questions.trpc.io/m/1273877872872001637](https://discord-questions.trpc.io/m/1273877872872001637);
  [discord-questions.trpc.io/m/1194093565819760772](https://discord-questions.trpc.io/m/1194093565819760772)
  ("We're having some serious Intellisense performance issues with v10").

- **Root cause is structural, not incidental.** All procedures from all routers get
  loaded into memory on every autocomplete access in the TS language server — the whole
  router tree is one giant type that tsserver has to keep re-evaluating. The tRPC team's
  own postmortem describes chasing this for the v10 rewrite and only getting a 59%
  reduction, not a fix.
  Evidence: [trpc.io/blog/typescript-performance-lessons](https://trpc.io/blog/typescript-performance-lessons);
  [trpc/trpc discussion #5508](https://github.com/trpc/trpc/discussions/5508) (repro
  case: "diagnostics-big-router").

- **Zod itself compounds the problem.** Chained Zod schema construction
  (`.extend()`/`.pick()`/`.omit()`) has its own type-checking performance cliff, and
  since tRPC infers input/output types directly from Zod schemas, that cost lands
  directly in the tRPC user's edit-save-typecheck loop.
  Evidence: [dev.to — "TypeScript Runtime Validators and DX"](https://dev.to/nicklucas/typescript-runtime-validators-and-dx-a-type-checking-performance-analysis-of-zodsuperstructyuptypebox-5416);
  [trpc/trpc discussion #2448](https://github.com/trpc/trpc/discussions/2448).

- **Workarounds are folk knowledge, not supported features.** Common advice circulating:
  set `skipLibCheck`/`incremental` in tsconfig, set
  `disableSourceOfProjectReferenceRedirect: true`, split the app router into many
  independently-typed sub-hooks so each call site only "sees" one router, or reach for a
  third-party codegen tool (e.g. xTRPC) that pre-flattens types — explicitly trading away
  tRPC's live-inference convenience to get the editor back.
  Evidence: [trpc/trpc discussion #2448](https://github.com/trpc/trpc/discussions/2448);
  [trpc/trpc issue #4129](https://github.com/trpc/trpc/issues/4129) ("feat: Lazy load
  routers", requested specifically to blunt this).

## Error handling / HTTP semantics

- **No first-class way to return arbitrary HTTP status codes.** Success responses are
  hardcoded to 200; `TRPCError` only maps to a fixed, small enum of codes. Users
  repeatedly ask for 201/204/418/502/503/504 and are told to hack it via
  `errorFormatter` or a response-transform middleware.
  Evidence: [trpc/trpc discussion #4833](https://github.com/trpc/trpc/discussions/4833);
  [trpc/trpc issue #5784](https://github.com/trpc/trpc/issues/5784) (502/503/504
  requested, 500 called out as insufficient); [trpc/trpc issue #4154](https://github.com/trpc/trpc/issues/4154).

- **This is a deliberate design constraint, not an oversight, and it's felt as a
  limitation anyway.** The maintainer's stated rationale is to preserve JSON-RPC-style
  transport independence, but even the maintainer calls the restriction "too
  restrictive" in the same breath.
  Evidence: [trpc/trpc discussion #809](https://github.com/trpc/trpc/discussions/809)
  ("Recommended way to send custom error codes").

- **Thrown errors sometimes don't propagate the intended status code at all.** Bug
  reports of `TRPCError` always coming back as 500 regardless of the code set, and
  errors thrown from procedures called via Next.js App Router route handlers still
  returning HTTP 200 to the browser.
  Evidence: [trpc/trpc issue #5935](https://github.com/trpc/trpc/issues/5935) ("Thrown
  TRPCError always returning a httpStatus code of 500"); [trpc/trpc discussion #6006](https://github.com/trpc/trpc/discussions/6006).

- **No structured way to make error *shapes* (not just messages) inferable on the
  client**, e.g. discriminating "this mutation can fail with a validation error vs. a
  business-rule error" in a typed way.
  Evidence: [trpc/trpc issue #3438](https://github.com/trpc/trpc/issues/3438) ("feat:
  inferable errors from procedures").

## File / binary uploads

- **No native support for `FormData` / `multipart/form-data`.** tRPC's request/response
  model is JSON-RPC-shaped end to end, so uploading a file is not a first-class case.
  Users describe getting "Input not instance of File" errors and missing-field errors
  when trying to just POST a file through a procedure.
  Evidence: [trpc/trpc discussion #658](https://github.com/trpc/trpc/discussions/658);
  [discord-questions.trpc.io/m/1354932013152342297](https://discord-questions.trpc.io/m/1354932013152342297)
  ("Sending FormData does not work at all").

- **The "official" fix is experimental and adds real setup cost.** FormData handling
  landed as an experimental feature in v10.23 but requires wiring a dedicated client
  link, a server-side middleware, and handler config — described by users as
  disproportionately complex for "upload a file."
  Evidence: [trpc/trpc discussion #4277](https://github.com/trpc/trpc/discussions/4277).

- **It doesn't compose with other transport features.** `unstable_httpBatchStreamLink`
  (needed for async-generator/streaming responses) is incompatible with FormData
  uploads; plain `httpLink` supports FormData but not streaming — so a project that
  wants both ends up needing two separate link configurations and manual routing between
  them.
  Evidence: [discord-questions.trpc.io/m/1336316873620455515](https://discord-questions.trpc.io/m/1336316873620455515).

- **Common workaround is to route around tRPC entirely** — base64-encode the file into
  the JSON payload (works but bloats payload/CPU), or hand the upload to a Next.js
  Server Action / plain REST route and only use tRPC for everything else, which breaks
  the "one API surface" pitch of the library.
  Evidence: [discord-questions.trpc.io/m/1252662359244144660](https://discord-questions.trpc.io/m/1252662359244144660).

## Request batching and network visibility

- **Batching is on by default and obscures the network tab.** Multiple independent
  hook calls collapse into one `?batch=1` request, so DevTools shows one opaque call
  instead of the individual queries/mutations that triggered it, making it harder to
  attribute latency or errors to a specific call site.
  Evidence: [trpc/trpc discussion #1874](https://github.com/trpc/trpc/discussions/1874)
  ("how to remove the batch parameter from network request").

- **Batched requests are gated by the slowest member of the batch.** A fast query gets
  stuck behind a slow one because they share one HTTP round trip; users have asked for
  out-of-order streaming of batch responses so fast results aren't blocked.
  Evidence: [trpc/trpc issue #4343](https://github.com/trpc/trpc/issues/4343) ("feat:
  out-of-order batch response streaming").

- **Opting out of batching per-request is possible but not ergonomic** — it requires
  `splitLink` plus a context flag (e.g. `skipBatch`) threaded through call sites, and
  disabling batching entirely has its own bug history (e.g. broken string
  serialization).
  Evidence: [discord-questions.trpc.io/m/1324730126205849600](https://discord-questions.trpc.io/m/1324730126205849600);
  [trpc/trpc issue #4243](https://github.com/trpc/trpc/issues/4243) ("Disabling batching
  breaks serialization of string values").

- **Batching solves the HTTP-request count problem, not the N+1 problem.** One HTTP
  batch can still fan out into N separate database queries server-side if resolvers
  aren't written with a dataloader/eager-load pattern — a distinction that trips people
  up when they assume "tRPC batches" means "tRPC solves N+1."
  Evidence: [Taming tRPC — CoddyKit blog](https://www.coddykit.com/pages/blog-detail?id=512524&slug=taming-trpc-common-mistakes-and-how-to-avoid-them-for-rock-solid-apis).

## Middleware / context typing

- **Composing context types across chained `.use()` calls is genuinely hard**, and the
  merge behavior relies on internal type utilities that aren't exposed publicly, so
  users can't replicate it themselves for more complex context-merging needs.
  Evidence: [trpc/trpc issue #5037](https://github.com/trpc/trpc/issues/5037) ("bug:
  inference errors in middleware and context").

- **No supported way to extract "the context type as of this middleware" for reuse** in
  helper functions, forcing people to either duplicate context shapes by hand or reach
  into tRPC's internal `ProcedureBuilder` types, which are not a stable API.
  Evidence: [trpc/trpc discussion #5472](https://github.com/trpc/trpc/discussions/5472)
  ("How to get the context type from a specific procedure?"); [trpc/trpc issue #5110](https://github.com/trpc/trpc/issues/5110)
  ("feat: types to infer middleware params").

- **Circular-inference failures** when a sub-router or middleware tries to reference
  the root `appRouter`'s type for context inference — a pattern users reach for
  naturally (e.g. for a caller factory) that breaks TypeScript's inference.
  Evidence: [trpc/trpc discussion #2779](https://github.com/trpc/trpc/discussions/2779)
  ("Can I specify the context type of middlewares somehow?").

## React Query integration / cache invalidation

- **No structured guidance on which queries a mutation should invalidate**, so teams
  drift toward either hand-maintained (and easily stale) per-mutation invalidation
  lists, or "just invalidate everything on any mutation" as a pragmatic escape hatch —
  described explicitly as the common fallback once precise invalidation gets too hard to
  track.
  Evidence: [Steve Kinney — React Query + tRPC course notes](https://stevekinney.com/courses/react-typescript/react-query-trpc).

- **Timing confusion between invalidation and `onSuccess` callbacks** — both the mutate
  call and `invalidateQueries` can fire before a component's own `onSuccess` handler
  runs, producing surprising ordering bugs.
  Evidence: [discord-questions.trpc.io/m/1100118275347714180](https://discord-questions.trpc.io/m/1100118275347714180)
  ("Full cache invalidation and timing problem").

- **`useContext`/`useUtils` churn across versions.** `useContext` (the pre-v11 handle
  for cache utilities) was effectively superseded/deprecated in favor of `useUtils`,
  leaving users unsure which API is current and whether their invalidation code still
  works.
  Evidence: [trpc/trpc discussion #4780](https://github.com/trpc/trpc/discussions/4780)
  ("TRPC's useContext does not invalidate query").

- **TanStack Query v5's own breaking changes forced tRPC's React Query integration to
  break in lockstep**, meaning users absorbed a second library's major-version churn
  just to stay on a supported tRPC + React Query combination.
  Evidence: [trpc.io — Migrate from v10 to v11](https://trpc.io/docs/migrate-from-v10-to-v11).

## Version migrations

- **v9 → v10 was a full rewrite** (different router/procedure builder API), and v10's
  own TypeScript-performance rewrite was significant enough that the team wrote a
  dedicated postmortem blog post about the compiler cost of the old design.
  Evidence: [trpc.io/blog/typescript-performance-lessons](https://trpc.io/blog/typescript-performance-lessons).

- **v10 → v11, while billed as "largely backward-compatible," still broke real
  projects**: transformer (superjson) config moved from client-init to the per-link
  config, `.interop()` mode was removed outright, the `AbortControllerEsque` ponyfill
  was dropped (breaking older-browser support unless the app supplies its own polyfill),
  and `callProcedure` disappeared. Users report types silently becoming `never` after
  upgrading with no code changes on their side.
  Evidence: [discord-questions.trpc.io/m/1296744845305450546](https://discord-questions.trpc.io/m/1296744845305450546)
  ("Types issues upgrading to v11, `never` when using t.router"); [trpc.io/docs/migrate-from-v10-to-v11](https://trpc.io/docs/migrate-from-v10-to-v11).

- **Migration documentation is described as incomplete** — a guide exists but users
  report there isn't a clear, exhaustive changelog of what actually changed, so upgrades
  involve some amount of trial and error against real breakage.
  Evidence: [trpc/trpc discussion #6235](https://github.com/trpc/trpc/discussions/6235)
  ("Where can I find about changes introduced on v11 release candidate versions?").

## WebSocket subscriptions

- **Subscriptions are not re-established after a reconnect.** If the WebSocket drops
  and reconnects (server restart, network blip), the client does not automatically
  re-send its active subscription requests — the subscription silently goes dead until
  the user manually refreshes.
  Evidence: [trpc/trpc issue #2776](https://github.com/trpc/trpc/issues/2776) ("bug:
  Subscriptions are not re-registered on socket reconnect").

- **When subscriptions do get re-registered, they can replay stale parameters**,
  causing the server to resend events the client already processed before the drop.
  Evidence: [trpc/trpc issue #6962](https://github.com/trpc/trpc/issues/6962) ("Server
  Closed Subscriptions Don't Update Websocket Client Connection State").

- **No built-in heartbeat**, so idle-connection timeouts on common hosts (e.g. Fly.io
  terminating idle sockets around 60s) cause constant reconnect churn under normal,
  low-traffic usage.
  Evidence: [trpc/trpc issue #2822](https://github.com/trpc/trpc/issues/2822) ("feat:
  Subscriptions heartbeat option").

- **Connection-failure retries are not backed off.** If `createContext` fails on the
  server, the WebSocket client has been observed entering a fast, tight retry loop
  instead of backing off — described as effectively spamming the server.
  Evidence: [trpc/trpc issue #4774](https://github.com/trpc/trpc/issues/4774) ("feat(client):
  don't spam retry when createContext fails").

## Structural / architectural lock-in

- **Whole-stack TypeScript is a hard requirement, not a soft preference.** tRPC's type
  safety comes entirely from the client importing the server's router *type*; if the
  backend isn't TypeScript (or isn't reachable from the frontend's build, e.g. separate
  repos/languages), tRPC provides no benefit over a plain REST call, and teams describe
  this as ruling it out for polyglot backends or any public/third-party-consumed API.
  Evidence: [Wallarm — "What Is tRPC protocol?"](https://www.wallarm.com/what/trpc-protocol);
  discussion of oRPC as the polyglot-friendly alternative in
  [LogRocket — tRPC vs oRPC](https://blog.logrocket.com/trpc-vs-orpc-type-safe-rpc/).

- **Effectively requires a monorepo (or a published private types package) to get the
  advertised guarantee.** Cross-repo setups lose the "client and server always agree"
  property that is tRPC's core pitch, and the fallback (publish an npm package of
  server types) is extra infrastructure most blog posts describe as a compromise, not a
  clean solution.
  Evidence: [trpc/trpc discussion #1860](https://github.com/trpc/trpc/discussions/1860)
  ("Monorepo mandatory?"); [billyjaco.by — "How to use tRPC types outside of a
  monorepo"](https://www.billyjaco.by/blog/export-trpc-types).

- **Batching/JSON-RPC transport model obscures what's actually happening on the wire**,
  making it harder to reason about tRPC calls using ordinary HTTP tooling/mental models
  (curl, generic API clients, non-JS consumers) compared to a plain REST endpoint.
  Evidence: summarized from developer commentary in [Medium — "Why I Stopped Using REST
  and Switched to tRPC for Everything"](https://medium.com/@connect.hashblock/why-i-stopped-using-rest-and-switched-to-trpc-for-everything-2e46c2ab1b9c)
  (response/counter-commentary) and [cocz.net — "What's Up with tRPC?"](https://cocz.net/whats-up-with-trpc/),
  which argues tRPC "doesn't fix that many problems" relative to a well-engineered REST
  API and "just overcomplicates the project" for teams without the specific
  monorepo-TS-everywhere constraint it assumes.

## React Server Components / Next.js integration churn

- **The v10-era integration pattern for Server Components was widely regarded as the
  worst part of using tRPC with Next.js App Router** — described by multiple sources as
  requiring adapter hacks and non-obvious wiring, with "no one-size-fits-all way" to
  integrate depending on which rendering pattern (RSC direct call vs. client-side hook)
  a given page needed.
  Evidence: [dev.to — "tRPC v11 + Next.js App Router: End-to-End Type Safety Without the
  Boilerplate"](https://dev.to/whoffagents/trpc-v11-nextjs-app-router-end-to-end-type-safety-without-the-boilerplate-4h5m),
  which frames v11's `createCaller` pattern as explicitly fixing "the biggest pain point
  from v10."

- **Overlap with RSC itself raises the question of whether tRPC is even needed** in an
  App Router project, since React Server Components solve some of the same
  client/server data-fetching problems tRPC was built for — a point acknowledged even in
  pro-tRPC write-ups.
  Evidence: [dev.to — "tRPC v11 + Next.js App Router"](https://dev.to/whoffagents/trpc-v11-nextjs-app-router-end-to-end-type-safety-without-the-boilerplate-4h5m).
