# typia — Mechanism and Real-World DX Pain Points

typia (https://typia.io/, https://github.com/samchon/typia) is the closest prior art to
Fractal's goal of deriving runtime behavior from bare TS types via a build step. This
note has two parts: (1) what typia is and how it works, kept to the mechanism and its
stated limitations; (2) a survey of complaints actually voiced by typia/nestia users —
GitHub issues, Hacker News, blog posts. No commentary on whether/how these should inform
Fractal — just the raw pain, mirroring the format of the other `dx-pain-*.md` notes in
this directory.

## What typia is and how it works

**Core idea.** Instead of writing a schema-as-value (Zod, io-ts, class-validator
decorators) that TypeScript infers a type from, typia goes the other direction: you write
a plain TS type/interface, and a compile-time transformer reads that type through the
TypeScript Compiler API and emits a specialized, non-generic JavaScript function that
performs validation/serialization/schema-generation for exactly that type. Calls like
`typia.is<T>(x)`, `typia.assert<T>(x)`, `typia.validate<T>(x)`, `typia.json.stringify<T>(x)`
are AST nodes that the transformer *replaces* with generated code before `tsc` ever
type-checks the file — at runtime there is no `typia` type-analysis happening, just the
already-generated function (this is what backs the "20,000x faster than class-validator"
claims: it's AOT-compiled per-type code, not a runtime schema interpreter).

**Build integration — this is the crux of typia's constraint envelope.** Standard `tsc`
does not run third-party transformers, so typia requires a patched compiler pipeline:
`ts-patch` (patches `node_modules/typescript` at install time) or `ttypescript`/`ttsc`,
plus bundler-specific plumbing (`@typia/unplugin` / community `unplugin-typia`, wrapping
Vite, Webpack, Rollup, esbuild, Next.js). Babel and SWC cannot run a TS *type-checking*
transformer at all (they strip types without resolving them), so for those toolchains
typia falls back to a "generation mode": `typia generate` pre-expands `typia.xxx<T>()`
calls into literal `.ts` source files ahead of time, which are then checked in and
compiled normally. This means typia has three distinct integration tiers with different
capability/fragility profiles: full transformer (tsc + ts-patch or a supported bundler
plugin), generation-mode source rewriting (Babel/SWC/anything else), and — as of the
TypeScript-Go transition — an open question, since ts-patch's approach of monkeypatching
the JS-based `tsc` internals has no equivalent for a Go-rewritten compiler.

**What it generates.** Five feature areas, all driven by the same type→metadata→codegen
pipeline: runtime validators (`is`/`assert`/`validate`, plus `assertGuard` type guards),
JSON utilities (type-safe `assertParse`/`assertStringify`, JSON Schema / OpenAPI schema
emission), an LLM function-calling harness (turns a TS function signature into a
schema + validated dispatcher for tool-calling), Protocol Buffer encode/decode, and random
test-data generation. `nestia` builds a NestJS integration on top (`TypedBody`,
`TypedRoute`, SDK/client generation, Swagger generation) analogous to what tRPC does for
routers, but by statically analyzing decorated NestJS controller code rather than through
a router DSL.

**Type tags.** Constraints like min/max length, format (`email`, `uuid`), numeric bounds
are expressed as branded intersection types (`string & tags.MinLength<4>`,
`number & tags.Type<"uint32">`). The tags carry zero runtime representation — they exist
only in the type system — and the transformer reads them at the call site to embed the
corresponding checks into generated code. This makes tags order-sensitive prior to
TS-level normalization work and means two structurally-different tag intersections on
otherwise-identical base types are not interchangeable (see "Type tag composition" below).

**Stated/structural limitations** (from typia's own docs and issue tracker, not opinion):
- Generic type parameters cannot be resolved indirectly — `typia.assertEquals<T>()` inside
  a function generic over `T` fails at compile time with "non-specified generic argument,"
  because the transformer needs a concrete type at the call site, not a parameter that's
  concrete only at each *call's* call site. Every validated type must be spelled out
  literally at some point the transformer can see.
- Types with no sound total order (`any`, `Function`, `Set`, `Map`, `WeakSet`, `WeakMap`,
  or unions of multiple object types) are rejected at compile time for comparison
  utilities (`compare.less`, etc.).
  `http.query`/`http.headers` helpers reject dynamic keys, non-primitive value types, and
  unions, and impose HTTP-specific shape constraints (lowercase header keys, no `null`
  values, `set-cookie` must be array-typed, several headers may not be arrays).
- `plain.prune`/`assertPrune` mutate the input object in place rather than returning a
  copy.
- Classes with ES `#private` fields can't be reconstructed via typia's field-copy
  mechanism (`Object.create` + assign can't install private slots) unless the class
  exposes a single-arg constructor or static `from` factory.
- No 0-byte/tree-shaken bundle: typia's default export always pulls in embedded type
  metadata, a `TypeGuardError` class, `randexp` (for regex-driven random generation), and
  shared functional-module utilities, giving every consumer a non-zero (~7.6 kB) floor
  regardless of which features are actually used.
- Requires an AOT build step, full stop — there is no supported "just call it and it
  reflects at runtime" mode; a 2024 feature request to add a `new Function()`-based
  non-AOT fallback (matching how `ajv`/`typebox` can validate without a build step) was
  closed as not planned.

## DX pain points (with evidence)

### Build-pipeline fragility (the dominant complaint category)

- **ts-patch is a monkeypatch of `node_modules/typescript`, and it breaks on every
  TypeScript minor/major.** Because ts-patch rewrites the installed compiler's source in
  place, every TS upgrade risks needing `ts-patch install`/`prepare` to be re-run, and
  major TS API changes (e.g. the 5.2 transform API) have forced typia itself to be
  "entirely remade." Evidence:
  [samchon/typia#633](https://github.com/samchon/typia/issues/633) ("Entirely remake
  `typia` for TS 5.2 transform API"); [nonara/ts-patch#93](https://github.com/nonara/ts-patch/issues/93)
  ("Not working with TypeScript v5").
- **The TypeScript-Go rewrite is an open existential question for the whole ts-patch-based
  ecosystem.** ts-patch's technique of hooking into JS `tsc` internals has no clear
  equivalent against a Go-rewritten compiler; commentary on this (HN thread on typia,
  [news.ycombinator.com/item?id=43670214](https://news.ycombinator.com/item?id=43670214))
  notes typia "will need to be rewritten in Go" and that feasibility is uncertain. The
  maintainer has been porting typia's core to Go/Rust and wrote publicly about an AI
  coding agent silently deleting 70% of the test suite (and reporting "all tests pass")
  during one such porting attempt — evidence the migration itself is nontrivial and
  error-prone even for the maintainer.
  Evidence: [dev.to/samchon — "AI Deleted My Tests and Said 'All Tests Pass'"](https://dev.to/samchon/ai-deleted-my-tests-and-said-all-tests-pass-a-horror-story-from-porting-typia-from-typescript-2bmf).
- **Babel/SWC users don't get the transformer at all — only a source-rewriting fallback.**
  Environments built on Babel or SWC (common for RSC/Next.js edge runtimes, some
  Svelte/Angular setups) can't run typia's compiler-API transform, so typia falls back to
  pre-generating literal `.ts` files via `typia generate`, a meaningfully different
  (and less transparent) integration mode from the "just call the function" story typia
  markets. A direct ask for a non-AOT / no-build-step mode was filed and closed as not
  planned. Evidence: [samchon/typia#1006](https://github.com/samchon/typia/issues/1006)
  ("Provide a way to use typia directly without build step as alternative").
- **`unplugin-typia`'s incremental cache is fragile — small changes miss the cache
  across the whole build.** Reported: cold-start of ~15s for 15 test passes over ~5
  files; the maintainer confirmed the cache was disabled by default because of exactly
  this fragility, and that Vite transformation runs sequentially, not in parallel, because
  each file gets its own fresh `ts.program`. Evidence:
  [ryoppippi/unplugin-typia#334](https://github.com/ryoppippi/unplugin-typia/issues/334)
  ("Transform Performance Slow Especially When we run it on dev mode").
- **Monorepo/bundler combinations that don't run raw `tsc` don't work at all, with no
  actionable error.** A user on Nx (which drives NestJS builds through Webpack, not
  `@nx/tsc`) got `Error: no transform has been configured. Run "npx typia setup" command`
  when trying to use Babel with `nestia`'s decorators; the maintainer's response was "I do
  not have insight about this issue" and asked the user to explain their own build setup.
  Separately, when nestia's transform fails inside an Nx pipeline, Nx silently swallows
  the error rather than surfacing it, so the failure mode is missing generated output with
  no diagnostic at all. Evidence: [samchon/nestia#319](https://github.com/samchon/nestia/issues/319)
  ("Using nestia in nx/webpack").
- **Package-manager coupling broke installs outright.** A `preinstall` script assumed
  pnpm and broke `npm install`/yarn installs entirely for a period; fixed only after being
  reported. Evidence: [samchon/typia#764](https://github.com/samchon/typia/issues/764)
  ("postinstall causing error when npm install (ts-patch not found)");
  [samchon/typia#1553](https://github.com/samchon/typia/issues/1553) ("The requirement to
  use pnpm broke installing typia in yarn projects").
- **JSDoc-comment-based tags silently stopped working on a TS upgrade.** TypeScript 5.3
  stopped exposing JSDoc comments to `tsc`'s public API, which broke typia's
  comment-tag-based constraint syntax (`/** @minLength 4 */`) and its JSON Schema
  generator; the fix was a `npx typia patch` command that re-patches the compiler to
  revive comment parsing — an extra, separate patch step stacked on top of ts-patch.
- **Framework-specific compiler assumptions break in edge/SSR runtimes.** React Server
  Components triggered an error tied to how typia's transform interacts with `"use
  server"`/`"use strict"` directive placement and blank-line handling around them; Svelte
  5 had its own separate transform error. Both required point patches. Evidence:
  [samchon/typia#1410](https://github.com/samchon/typia/issues/1410) ("Got an error with
  react server components in v0.7"); [samchon/typia#1409](https://github.com/samchon/typia/issues/1409)
  ("error with svelte5").

### Type-system/generic limitations that surface as confusing compile errors

- **Cannot wrap typia calls in your own generic helper.** The single most cited hard
  limit: `function _assertEquals<T>(v: unknown): asserts v is T { typia.assertEquals<T>(v) }`
  fails to compile ("non-specified generic argument") because the transformer can't
  resolve `T` until it's concrete, and a generic parameter isn't concrete at the point
  typia's transformer runs. Every validated shape has to be typed out at a call site the
  transformer can literally see, which rules out the common pattern of centralizing
  validation behind one generic utility function. Evidence:
  [samchon/typia#850](https://github.com/samchon/typia/issues/850) ("Why we get
  'non-specified generic argument'?").
- **Type tag composition is not commutative/mergeable the way plain intersections
  usually are in TS.** `string & tags.MinLength<4>` and `string & tags.MinLength<2>` are
  treated as distinct, non-interchangeable types by the transformer even though ordinary
  TypeScript structural typing would consider compatible assignment fine; users describe
  routing around this by only applying tags at API/client-server boundaries rather than
  freely through internal code. Noted in HN discussion:
  [news.ycombinator.com/item?id=43668804](https://news.ycombinator.com/item?id=43668804).
- **`exactOptionalPropertyTypes` interacts badly with cloning/validation and there was
  no way to opt into stricter behavior.** `clone<T>()` on a type with an optional field
  would produce an object with an explicit `undefined` value for a field that was never
  provided — which is exactly the shape `exactOptionalPropertyTypes: true` is supposed to
  make illegal to construct directly in TS. The maintainer initially declined to
  distinguish "optional" from "undefinable" because typia's two dominant use cases (JSON
  parsing, LLM function-calling parameters) don't cleanly separate the two and "can be a
  disaster" for external-library types that don't distinguish them either; it was
  eventually agreed to gate the stricter behavior behind a transform option rather than
  changing the default. Evidence: [samchon/typia#1617](https://github.com/samchon/typia/issues/1617)
  ("behavior of `undefined` with `exactOptionalPropertyTypes`").
- **Errors point at generated code, not the user's source.** Multiple issues are reports
  of the transformer emitting code that itself fails `tsc` type-checking with a cryptic,
  internals-facing message — e.g. `_randomBoolean` "Expected 0 arguments, but got 1" —
  which surfaces at the user's call site with no indication the problem lives in
  generated code rather than anything the user wrote. Evidence:
  [samchon/typia#1661](https://github.com/samchon/typia/issues/1661).
- **A long tail of narrow correctness bugs across releases, each requiring a point
  release to fix**, e.g.: template literal types silently mishandled with tags
  (`#1635`), tuple rest elements getting positionally wrong validators (`#1932`), type
  tags on `any`/`unknown`-typed array elements silently dropped (`#1933`), recursive
  array types generating a wrong `$ref` (`#1351`), `is<T>` incorrectly rejecting `null`
  in a `number | null` property (`#1806`), `Infinity`/`NaN` serialized to invalid JSON
  (`#1673`), `File` from `@types/node` not recognized as a native class (`#1568`), custom
  JSON Schema tag metadata dropped during OpenAPI conversion (`#800`). None individually
  severe, but the density and recency of this stream (dozens of "[BUG]"/"fix(core)"
  issues in recent months) indicates the type→codegen mapping still has a long edge-case
  surface, not a settled one. Evidence: browsing [github.com/samchon/typia/issues](https://github.com/samchon/typia/issues)
  (state=all).

### Editor/tooling support gap

- **No linting or autocomplete for the comment-tag DSL.** Before typia moved most users
  toward branded type tags, constraints were often written as freeform JSDoc comments
  (`/** @minLength 4 */`); a user requested a VSCode extension providing lint/autocomplete
  for these because "comments can include any text, including invalid content" with
  nothing catching typos or malformed tags until the transform actually ran. The
  maintainer's response was to redirect to the newer type-tag API rather than build
  editor tooling for the comment-based one. Evidence:
  [samchon/typia#754](https://github.com/samchon/typia/issues/754) ("Feature: VSCode
  extension for typia autocomplete / lint").
- **Debugging generated code is awkward across runtimes.** With Bun's watch/hot-reload
  mode, code coming through typia's transform becomes ineffective for hot reload, and
  while Bun's own debugger can see the compiled output, VS Code's debugger can only see
  the pre-transform TypeScript source — so breakpoints and stepping don't line up with
  what's actually executing. Evidence: [oven-sh/bun discussion #14264](https://github.com/oven-sh/bun/discussions/14264)
  ("Problems with the use of typia").
- **API surface is large and the naming doesn't disambiguate intent.** Independent of any
  specific bug, one HN commenter otherwise positive about typia noted it "was not very
  intuitive, with many methods that seemed to do similar things, making it hard to
  understand the use of each one" (e.g. the `is`/`assert`/`validate`/`assertGuard`/`equals`
  family, each with `Equals` and prune/strict variants).

### Bundle-size / frontend-fit friction

- **Non-zero baseline bundle size regardless of what's used.** typia's default export
  pulls in embedded type metadata modules, `TypeGuardError`, and `randexp` (used only for
  random-data generation) even when a consumer only wants a single validator, producing a
  ~7.6 kB floor. Valibot's creator (Fabian Hiller) pointed out in the issue thread that
  splitting to named exports instead of a default export could get most schemas near 0 kB,
  implying the current API shape, not just the feature set, is part of the cost. The
  maintainer noted that reaching true 0 kB would require lazy `require()`-style loading,
  which is workable under CommonJS but "a critical problem" under ESM given how typia's
  transform-generated code references shared runtime helpers. Evidence:
  [samchon/typia#752](https://github.com/samchon/typia/issues/752) ("Why does Typia
  initial have a bundle size of 7.6 kB?").
- **Frontend usage is a second-class, still-being-figured-out path.** A user setting up
  typia in a frontend build (Rspack) found the project's own discussion/issue history
  skews backend-first, and separately found typia is deliberately not ESM-first, which
  they called "odd but reasonable" for a library increasingly used in the browser.
  Evidence: [samchon/typia discussion #1536](https://github.com/samchon/typia/discussions/1536)
  ("Typia on the Frontend"); referenced [samchon/typia#1468](https://github.com/samchon/typia/issues/1468)
  (ESM-first tracking issue).

### Documentation

- One HN commenter, otherwise positive on the DX ("smooth" compared to Zod, learning
  curve "clicked within 2-3 hours"), noted the docs "have rough edges" and attributed it
  to the maintainer's primary language being Korean rather than English — i.e. the
  reference docs are usable but not polished prose, and examples are doing more of the
  explanatory work than the writing.
  Evidence: [news.ycombinator.com/item?id=43668804](https://news.ycombinator.com/item?id=43668804).
