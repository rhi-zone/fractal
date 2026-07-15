# Elysia — DX Pain Points (User Research)

Real complaints from GitHub issues, GitHub discussions, and blog/comparison posts. Grouped
by theme. No editorializing — what people actually said hurts.

## Type Inference / IDE Performance at Scale

- **IntelliSense becomes unusable on real-sized projects.** A user migrating ~100 routes
  from Node/Express reported every autocomplete suggestion taking 10–20+ seconds, with
  `tsserver.js` pegging CPU, describing the DX post-migration as "catastrophic" and "a
  nightmare." Confirmed reproducible with `tsserver` tracing showing the time going into
  "semantic work." ([GitHub issue #1031](https://github.com/elysiajs/elysia/issues/1031))
- **The docs' own reassurance is contested by users running larger codebases.** The
  TypeScript patterns page states "most of the time writing Elysia, you wouldn't encounter
  any type performance issue" — a commenter running 202 plugins / 1,168 endpoints called
  this "dishonest" and concluded the framework doesn't cater to typical commercial codebase
  sizes despite being past 1.0. ([GitHub issue #1031](https://github.com/elysiajs/elysia/issues/1031))
- **Workarounds are folk knowledge, not documented guidance.** Commenters on the same issue
  independently converged on splitting Elysia modules so they don't extend one another,
  pre-compiling `.d.ts` files via `tsup`, or building declarations in a separate
  package/project so Eden consumes a compiled type rather than live-inferring across the
  whole app — with people asking "any traction on this issue?" months apart and no fix
  landing, only a 1.3 release that reduced (not eliminated) the cost by ~51%.
  ([GitHub issue #1031](https://github.com/elysiajs/elysia/issues/1031))
- **Eden Treaty is identified by users and maintainers alike as the main type-perf
  offender**, prompting commenters to suggest deprecating it outright in favor of Eden Fetch
  ("I support deprecation of eden treaty. It feels harder to read and compose" / "eden
  threaty is really harder for typescript so probably we should avoid it"), with the
  counterpoint that Eden Fetch lacks feature parity (e.g., no generator body support).
  ([GitHub issue #1031](https://github.com/elysiajs/elysia/issues/1031))
- Related type-inference breakages reported independently: type inference lost for decorated
  properties inside macro `resolve` ([#1468](https://github.com/elysiajs/elysia/issues/1468)),
  incorrect inference with deferred modules causing runtime `TypeError`s
  ([#1038](https://github.com/elysiajs/elysia/issues/1038)), and inconsistent context typing
  across files reported as a "seeking help" discussion rather than an obvious fix
  ([Discussion #784](https://github.com/elysiajs/elysia/discussions/784)).

## Eden Treaty (RPC Client) — Structural and Ergonomic Complaints

Collected primarily from the maintainer-solicited feedback thread
([Discussion #432](https://github.com/elysiajs/elysia/discussions/432)) plus scattered
issues:

- **Errors are swallowed instead of thrown**, breaking integration with libraries that
  expect throw-on-failure semantics (e.g., react-query never sees `error`, only
  `data.error`) — users have to override the `fetcher`/`onResponse` hook themselves to
  restore normal error propagation. ([GitHub issue #651](https://github.com/elysiajs/elysia/issues/651),
  echoed independently as "I have to modify the fetcher to throw error so that tanstack
  properly triggers onError" in Discussion #432)
- **No built-in way to set headers dynamically per-request** (e.g., a bearer token pulled
  from storage) without either repeating it on every call site or monkey-patching the
  fetcher — requested repeatedly as a first-class interceptor/transform hook.
- **Route path mismatch between the framework's routing and Eden's generated client**: a
  nested group route reachable at `/deep/nested` on the server showed up as
  `client.deepnested.get()` on the Eden client (missing the segment boundary), producing a
  404 unless the caller manually retypes the path and loses type safety doing so.
  ("I guess this an issue.")
- **Root-level dynamic routes (`/:id`) aren't registered by the newer Treaty implementation
  at all** — a regression versus the older `edenFetch`/`edenTreaty`, which supported them.
  ([GitHub issue #823](https://github.com/elysiajs/elysia/issues/823))
- **`body` params typed as `any` in Eden Treaty while Eden Fetch gets correct types for the
  same route** — an inconsistency between the two client flavors doing ostensibly the same
  job. ([GitHub issue #1666](https://github.com/elysiajs/elysia/issues/1666))
- **Macro-derived endpoints type as `any` in Eden Treaty.**
  ([GitHub issue #1701](https://github.com/elysiajs/elysia/issues/1701))
- **A minor version range (1.1.21–1.1.26) broke end-to-end type safety with Eden Treaty
  entirely** for that window. ([GitHub issue #934](https://github.com/elysiajs/elysia/issues/934))
- **Explicit return-type extraction syntax got more verbose across a Treaty rewrite** —
  users had to migrate from indexed-access types (`TreatyType["domain"][string]["user"]`)
  to nested `ReturnType<...>` wrapping, and even then TypeScript can't always narrow which
  method (`get`, etc.) is present when multiple dynamic-param routes overlap.
- **File download / raw response access wasn't supported** — a user had to add an
  undocumented, type-unsafe `getRaw` escape hatch via PR because Eden Treaty reads the
  response stream itself, preventing direct access to it.
- **Testing error scenarios through Eden Treaty is broken** — the error object isn't
  formatted the way assertions expect, making it hard to write tests against failure paths.
  ([GitHub issue #1055](https://github.com/elysiajs/elysia/issues/1055))
- **Property access in the Treaty proxy implementation isn't cached**, and special path
  cases (e.g. `/path` colliding with `/path/get`) don't resolve correctly; one commenter's
  preference was simply "just return a typed response like Hono HC" instead of Elysia's
  proxy approach.
- **Mismatch between Elysia's own OpenAPI generation and what Eden Treaty infers** for the
  same routes. ([GitHub issue #1142](https://github.com/elysiajs/elysia/issues/1142))
- **Error type shapes differ between raw Elysia errors and what Eden surfaces**, described
  as inconsistent and the resulting error response structure as "enormous and difficult to
  work with." ([GitHub issue #220](https://github.com/elysiajs/eden/issues/220))

## Validation Error Messages (TypeBox)

- **Custom `error` messages on a TypeBox schema replace the entire structured validation
  error with a bare string**, discarding the `type`/`on`/`property`/`expected`/`found`
  fields that the default (non-customized) validation failure returns — so adding a
  human-readable message means losing everything else a client-side error handler might
  need to parse. ([GitHub issue #968](https://github.com/elysiajs/elysia/issues/968))
- **Accessing the structured error inside `onError` requires re-parsing the stringified
  message**, described as unnecessary overhead just to get information that should already
  be structured. (Referenced in [GitHub issue #768](https://github.com/elysiajs/elysia/issues/768)
  discussion of TypeBox errors being stringified instead of returned as an object)
- Users cannot attach custom string literals to specific TypeBox error properties, limiting
  how descriptive validation feedback can be made without the stringification tradeoff above.
  ([GitHub issue #1612](https://github.com/elysiajs/elysia/issues/1612))

## Versioning / Breaking Changes

- **A release containing an acknowledged breaking change was tagged as a patch version**
  (1.1.18), violating the semver expectation that patch releases are safe to auto-update.
  Direct quote from the issue: "1.1.18 clearly says breaking change so why is it a patch
  update?" ([GitHub issue #867](https://github.com/elysiajs/elysia/issues/867))
- **The 1.0 release changed lifecycle-hook scoping defaults** (hooks now default to
  `local` instead of the previous global-by-default behavior), a change the framework's own
  docs admit is necessary because "the global event is hard to trace and control properly"
  — an implicit acknowledgment that the pre-1.0 default was itself a footgun users had been
  living with. ([GitHub issue #513](https://github.com/elysiajs/elysia/issues/513))
- **1.3 removed `.index`** as a breaking change requiring a find-and-remove pass across
  affected codebases.

## Runtime Performance Regressions

- **AOT compilation caused a 45.7x throughput regression specifically on Bun** between
  Elysia 1.2 and 1.4 with default settings (3,853 req/s vs. 175,951 req/s with `aot: false`
  manually set) — the same AOT setting performed fine on Deno and Node, isolating the
  regression to the Bun code path Elysia is nominally optimized for. Reporter noted this
  "contradicts the intended purpose of AOT compilation" and that "default settings make
  Elysia practically unusable on Bun." ([GitHub issue #1604](https://github.com/elysiajs/elysia/issues/1604))
- **Memory leak in the built-in multipart parser** — memory grows with each file upload and
  is never released, eventually causing an OOM crash; does not reproduce with a hand-rolled
  parser built on `request.formData()` instead of Elysia's own.
  ([GitHub issue #1744](https://github.com/elysiajs/elysia/issues/1744))
- Separately reported memory leaks when combining Elysia with Prisma under load, tracked
  against the underlying Bun runtime rather than Elysia itself
  ([oven-sh/bun#15518](https://github.com/oven-sh/bun/issues/15518),
  [oven-sh/bun#14664](https://github.com/oven-sh/bun/issues/14664)).

## Testing

- **Unit tests silently become end-to-end tests.** Following Elysia's own Eden testing
  guide, a test using `edenTreaty` against the app type fails with `ConnectionRefused`
  unless a real server is running in another terminal — the docs present `edenTreaty`
  testing and direct `app.handle()` testing as equivalent-but-type-safe, when in practice
  only one of them is actually unit-testable. Direct quote: "I had to use `app` directly
  rather than `edenTreaty`. The docs make it sound like they are equivalent but with type
  safety, but one is unit testable and the other is e2e testing."
  ([GitHub discussion #535](https://github.com/elysiajs/elysia/discussions/535))
- **WebSocket routes can't be unit tested** — Eden Treaty fails to connect to the app's
  WebSocket endpoint under test. ([GitHub issue #704](https://github.com/elysiajs/elysia/issues/704))

## Runtime Portability (Bun Coupling)

- **No stable, documented path to running Elysia on Node.js in production** — the framework
  is described as heavily biased toward shipping new features for Bun first, which
  discourages teams constrained to Node.js from adopting it even though multi-runtime
  support exists nominally.
- **Deployment breakage on Vercel** tied to `tsconfig.json` path aliases: builds succeed but
  routes fail at request time with "Bun process exited with exit status: 1," resolved only
  by removing the `paths` config. ([GitHub issue #1789](https://github.com/elysiajs/elysia/issues/1789))
- An open RFC titled "Making Elysia.js a True Cross-Runtime Framework" exists specifically
  because cross-runtime support is considered incomplete by the community, not a solved
  problem. ([GitHub issue #1174](https://github.com/elysiajs/elysia/issues/1174))

## Hot Reload

- **`--hot` stopped starting the server after a specific commit**, surfaced via `git
  bisect` by a user hitting "Failed to start server. Is port 8080 in use?" on every file
  change. ([GitHub issue #125](https://github.com/elysiajs/elysia/issues/125))
- **Hot reload silently stopped triggering browser reloads** on save with `--watch`/`--hot`
  both set, in an earlier release. ([GitHub issue #100](https://github.com/elysiajs/elysia/issues/100))

## Ecosystem / Community Maturity (comparative framing)

- Download-volume comparisons against Hono are used by third-party reviewers as a proxy for
  "you'll more often be the first person to file the issue" — one comparison cites roughly
  an 80-to-1 gap in npm downloads between Hono and Elysia in the same measurement window.
- Reviewers note Elysia ships without built-in database support, pub/sub, cron, distributed
  tracing, or metrics — everything beyond routing/validation/OpenAPI is bring-your-own,
  compared to more batteries-included competitors.

## MVC / Project Structure Guidance

- **Elysia's documented best practice actively discourages separate controller classes**,
  recommending a plain Elysia instance act as the controller instead — the stated reason
  being that passing a whole `Context` object to an external controller function breaks
  down under Elysia's plugin/decorator-driven type system (types depend on chaining order
  and accumulated state, so a decoupled controller can't reliably see the right shape).
  Adapting a conventional MVC layout onto Elysia is explicitly flagged in the docs
  ecosystem as something "found to be hard to decouple and handle types" for — i.e., a
  common architectural pattern from other frameworks doesn't transfer cleanly.
