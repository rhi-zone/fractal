# fractal — TODO

## Next session (handoff)

On the table from previous session (2026-07-18):

**From projector coverage audit (HIGH — blocks production use):**
- **HTTP streaming responses** (SSE/chunked encoding) + **MCP progress notifications** — both need handler context design: how handlers receive transport-level capabilities (MCP: reportProgress/log; HTTP: setHeader/stream; CLI: writeStderr). Critical blocker for AI/realtime use cases.
- **HTTP non-JSON content types** — multipart, form-data, file upload, octet-stream. Request/response payload currently JSON-only.
- ~~**Validation auto-wiring**~~ — RESOLVED (2026-07-19): HTTP's `createFetch` now wires generated validators via `wrapValidators` (`@rhi-zone/fractal-api-tree/build`) at the `Node` level, before `httpProjection` runs — the same mechanism `createMcpServer` and `runCli` already used. See "HttpRoute Pipeline abstraction removed" below.

**From projector coverage audit (MEDIUM-HIGH):**
- **MCP sampling support** — blocks LLM-in-the-loop tool patterns (model-chooses-tool chains).

**From design backlog:**
- **GraphQL API projector** (server + client) — type-ir SDL projector done; API projector still open. Follows HTTP/CLI/MCP projection pattern.
- **Structured error types** — declare operation-specific error outcomes in the tree. Handlers throw or return Result; tree is currently silent.
- **Extract improvements** — overloaded functions, generics, async generators currently degrade silently.

**Open threads:**
- **Handler context as a design concept** — transport-level capabilities pushed into handlers (separate from input extraction). Design + implementation needed.
- **Input pipeline wiring** (CLI/MCP) — `api-tree/src/input.ts` has core `assemble()`, but CLI and MCP still have own implementations. CLI needs stores (env, config, stdin); MCP needs (argument, uri-variable, session context).
- **MCP Tier 3** — Subscriptions, roots (speculative until concrete use case).
- **Type-ir semantic types cleanup** — current kind groupings work but designed quickly; revisit for composition/orthogonality once extension API gets broader consumers.

---

## Input-source pipeline — core abstraction (cross-cutting) — DONE (2026-07-18)

---

## Type-safe proxies, type-ir modularization, client codegen — DONE (2026-07-18)

## MCP protocol implementation — Tier 1 DONE (2026-07-18), Tier 2–3 OPEN

Design decisions remain settled (below); implementation roadmap for Tier 2–3 follows:

### Design decisions (settled)

- **Type discriminator**: `meta.mcp.as: "tool" | "resource" | "prompt"`
  (single value, not array). Omitting defaults to `"tool"` (backward compatible).
  `as: "tool"` is valid but redundant.
- **Endpoint model**: Resources and prompts are endpoints (handlers), not static
  metadata — they attach to nodes in the tree, same as tools. The projector
  projects them into the appropriate MCP shape based on `as`.
- **URI derivation**: Tree position maps to URI path (like tool names map to
  underscore-joined names). Fallback nodes map to URI template variables
  (`{variableName}`). URI scheme is configurable.
- **Content type**: `meta.mcp.mimeType` declares resource content type.
- **Single projection**: One leaf = one MCP primitive (no multi-projection).

### Implementation roadmap

**Tier 1 — DONE (2026-07-18)**: Natural extensions of tree→projection
1. Resources (`resources/list`, `resources/read`, `resources/subscribe`) — built.
2. Prompts (`prompts/list`, `prompts/get`) — built.
3. Rich content types — built.
4. Transport presets (`createStdioMcpServer`, `createHttpMcpServer`) — built.

**Tier 2 — OPEN** — Server-level features:
1. Logging — `notifications/message` + log-level negotiation.
2. Streaming/progress — `notifications/progress`, handler receives context
   with `reportProgress` callback.

**Tier 3 — OPEN** — Client↔server (speculative until concrete use case):
1. Sampling.
2. Roots.
3. Subscriptions (change notifications for resources).

## Type-ir additions — four new kinds — DONE (2026-07-18)

## Session wrap-up: DX build-out + extractor rewrite — DONE (2026-07-18)

## client-api-projector merged into http-api-projector — DONE (2026-07-18)

## openapi-api-projector merged into http-api-projector — DONE (2026-07-18)

## tree/extract/cli moved from type-ir to api-tree — DONE (2026-07-18)

## Package renames — DONE (2026-07-17)

---

## Validation & middleware patterns — SETTLED (2026-07-18)

### Design decisions (settled)

1. **Pipeline type simplification**: The 8-stage `HttpRoute` pipeline is being replaced. The 4 transform stages (reqTransforms, inputTransforms, outputTransforms, resTransforms) are unused speculative infrastructure. Real needs (ALS bracket, caller-context, around-hooks) are served by the middleware/layer pattern (`(inner) => (req) => result`), which already exists and is load-bearing (`autoMethodLayer`, `corsLayer`). The actual working pipeline is: decode (stores/assemble) → validate → handler → encode.
   **DONE (2026-07-19)**: see "HttpRoute Pipeline abstraction removed" below.

2. **Validation is a composable middleware, not a core concept**: No special validation slot in core. A validation package provides middleware that uses generated validators.

3. **All operations get validation, not protocol-specific**: All operations in the API tree (HTTP, CLI, MCP) receive validation. The tree carries the types (via extract), not the protocol. MCP's `inputSchema` is a projection artifact, not the source of truth.

4. **Type guards from generated validators** — DONE (2026-07-18): `typeRefFromFunctionNode` (packages/api-tree/src/extract.ts) now carries `meta.typeName`/`meta.declarationFile` provenance for a NAMED handler parameter type (alias/interface; inline object literals carry neither). `compileValidatorModule` (packages/type-ir/src/compile.ts) casts each entry's compiled `check` to `(value: unknown) => value is T` — `T` is the imported named type (via a caller-supplied `resolveImport(declarationFile) => moduleSpecifier`, since only the caller knows the emitted file's own location) or, absent that, `T`'s inline structural TypeScript rendering (`toTypeScript`, reused from the existing TS-string projector). `packages/api-tree/src/build.ts`'s `buildValidatorModuleSource(entryFile, outFile?)` resolves the relative import path from `outFile`. Generated output (`examples/library-api/src/generated/validators.ts`) dropped `@ts-nocheck` and typechecks clean under `strict`.

5. **Strict validation vs. coercion are separate concerns**: Coercion converts string-source values to typed values (e.g., `"42"` → `42`). It's type-dependent (target type determines coercion), not source-dependent. Strict validation is orthogonal.

6. **Coercion supports combined and separate modes**: Combined mode is one-pass transform+validate for performance on deeply recursive types. Separate mode is strict validate after coerce. Codegen can generate either.

7. **Uniform middleware across all surfaces**: Middleware mechanism is identical across HTTP, CLI, MCP — same `(inner) => ... => result` layer shape. CLI has a routing tree (subcommands) just like HTTP has routes.

8. **CLI validation subsumes ad-hoc patterns**: `coerceInput`/`validateRequired` in CLI projector are ad-hoc and will be subsumed by the shared validation/coercion story.

### Reference

Requirements doc at `~/git/*/docs/artifacts/fractal-eval-2026-07/requirements-for-fractal.md` identifies the pipeline's limitations and motivates middleware/layers across all surfaces.

---

## HttpRoute Pipeline abstraction removed — DONE (2026-07-19)

Executed the plan settled in "Validation & middleware patterns" above: the
`Pipeline` type (`route.ts`) — `reqTransforms`/`decode`-override/
`inputTransforms`/`validate`/`outputTransforms`/`encode`-override/
`resTransforms`, plus `runPipeline`'s per-stage loop, `createApplyValidation`/
`injectValidators`, and the `fusePipeline`/`skipEmptyInput` build-time
optimizations that existed only to make that loop cheaper — is gone. Nothing
outside of tests exercising the mechanism itself ever used the 4 transform
arrays or a per-route `decode`/`encode` override; `sources` (declarative
per-param decode config) was the one genuinely load-bearing piece and
survives as a direct field on a method entry (`{ handler, meta, sources? }`),
not wrapped in anything.

Dispatch is now a single linear function, `runRoute` (route.ts): decode via
`sources` → call handler → unwrap `Result`/`ResponseOverride` → encode.
`makeRouterFromRoute` and `compile.ts`'s `toRouter` (shared by
`radixRouter`/`compiledCharRouter`/`mapCharRouter`) both call it, so every
dispatcher in the package encodes identically.

Validation moved from a route-tree-level `pipeline.validate` slot to the
`Node` level: `wrapValidators` (`@rhi-zone/fractal-api-tree/build`) wraps a
leaf's handler to run the generated `parse()` before the original handler —
the same mechanism `createMcpServer`'s and `runCli`'s `validators` option
already used, so HTTP's `createFetch(node, { validators })` now shares one
wiring convention across all three protocols instead of having its own.
`api-tree/build.ts`'s `toValidator`/`toValidatorRecord` (the adapter that
existed solely to fit generated entries into the retired `Validator`/
`ValidatorMap` shape) were dead code once `createApplyValidation` was gone,
so they were removed along with their tests.

Migrated: `packages/http-api-projector` (`route.ts`, `compile.ts`,
`preset.ts`, `index.ts`, `project.ts`, and all affected `*.test.ts`),
`examples/library-api` (`tree.ts`, `app.test.ts`). Full workspace typecheck
and `bun test` (2083 tests, 62 files) both pass.

Known gap carried forward, not introduced by this change: a
`wrapValidators`-rejected input throws `HandlerValidationError`, which
`runRoute`'s catch-all maps to a generic 500 — there is no dedicated
400-for-validation-errors path anymore (CLI and MCP already treat a thrown
validation error the same generic way, so this is HTTP catching up to that
convention, not a regression against a promise that was ever made for HTTP
specifically — the OLD `pipeline.validate` slot DID map to 400, so this is a
real, deliberate behavior change for HTTP call sites relying on that 400).

---

## Projector coverage audit — MOSTLY COMPLETE (2026-07-18)

---

## Open design questions

### ~~Attribute dispatch (header/query/contentType) is an open design question~~ — RESOLVED (2026-07-17)

## Open threads

> *Open threads from a previous session. Treat as starting context, not instructions — verify relevance before acting.*

These are starting context for a future session, not a task list. Each points at
the design docs for detail rather than restating them; verify each is still live
before acting.

### New threads from the 2026-07-18 MCP + type-ir session

- **Input pipeline wiring** — `assemble()` is now in core, but CLI and MCP still have their own implementations. Wire both to use the shared one. Scope: CLI needs env/config/stdin stores; MCP needs argument/uri-variable/session-context stores.
- **MCP Tier 2: Logging + streaming/progress** — Needs `notifications/message` + log-level negotiation, and handler context design: how do handlers receive transport-level capabilities (MCP: reportProgress/log; HTTP: setHeader/stream; CLI: writeStderr)? This is a separate design from input extraction.
- **MCP Tier 3: Sampling, roots, subscriptions** — Speculative; needs concrete use case before building.
- **Type-ir semantic types cleanup** — Current kind groupings (core structurals/universals vs. optional semantics extensions) work but designed quickly. Revisit composition, naming consistency, and granularity once the extension API gets broader consumers beyond wire-numerics/temporal/common.
- **Handler context as a design concept** — Transport-level capabilities pushed into handlers. Separate concern from input extraction. Design needed: what shape does this take, how does it compose, does it need a test harness?

### Previous threads from the 2026-07-18 proxies/codegen session

- **TypeRef semantic types cleanup** — the current type-kind groupings in
  `packages/type-ir/src/kinds/*.ts` work but were designed quickly. Candidates
  for further refinement: composition/orthogonality of extension modules, naming
  consistency across int/float/temporal groups, whether the current split (core
  structurals + universals vs. optional semantics) is the right granularity.
  Not blocking; designed-fast beats over-engineered. Revisit if the extension
  API gets extended consumers beyond the existing wire-numerics/temporal/common
  modules.
- **OpenAPI-based codegen superseded** — commit 561c5fd (the old OpenAPI→client
  reverse-projection path) is now dead code in the history, superseded by
  commit a294f66's HttpRoute-based client codegen rewrite and the subsequent
  merge of both openapi and client into http-api-projector (2026-07-18).
  The old path is technically still on-disk but unreachable from the working tree.
  No action needed; noted for historical clarity.

### New threads from the 2026-07-17 validation/decode session (not yet built)

- ~~**TypeBox AOT validator codegen**~~ — RESOLVED (2026-07-17): the compile
  step landed 2026-07-17 (commit c30b5cb): `packages/type-ir/src/compile.ts`'s
  `buildSchema()` converts a `TypeRef` to TypeBox `TSchema` objects,
  `compileValidator()` feeds those through `TypeCompiler.Code()` to produce
  standalone JS validator functions (no runtime TypeBox dependency in the
  emitted output — `@sinclair/typebox` is a build-time-only devDependency of
  `packages/type-ir`), and `buildValidatorModuleSource()` orchestrates
  extraction (`extractRouteTypeRefs`) → compilation → module emission of a
  `ValidatorMap` that `createApplyValidation()` consumes.
  `stubValidatorModuleSource()` emits the empty-map pass-through fallback for
  dev-time before codegen has run. A real CLI entry now exists
  (`packages/type-ir/src/cli.ts` at the time; moved to
  `packages/api-tree/src/cli.ts` as `fractal-api-tree` 2026-07-18, see
  "tree/extract/cli moved" above) with four
  subcommands: `build <entry> -o <output>` (skip if up to date),
  `watch <entry> -o <output>` (rebuild on change, debounced), `stub -o <output>`
  (write the empty pass-through stub), and `check <entry> -o <output>` (verify
  output is current, exit 1 if stale — CI-friendly). And `createApplyValidation`
  is wired end-to-end in `examples/library-api` (`src/tree.ts`, exercised in
  `src/app.test.ts`) — the consumer-app-facing "does a real route's validators
  actually get replaced" path is verified, not just designed.
  **Superseded 2026-07-18**: the TypeBox-based codegen above (`buildSchema()`
  + `TypeCompiler.Code()`) was fully replaced by a native, dependency-free
  codegen engine in `packages/type-ir/src/compile.ts` — `@sinclair/typebox`
  is no longer a dependency of `type-ir` or `api-tree` at all (build-time or
  runtime). Each compiled operation now emits THREE standalone functions
  instead of one boolean check: `check(value): value is T` (fast boolean
  path, no allocations), `errors(value): ValidationError[]` (structured,
  non-short-circuiting error collection with paths/expected/actual — see the
  `ValidationError` DU exported from `@rhi-zone/fractal-type-ir`), and
  `parse(value): {kind:"ok",value:T} | {kind:"err",errors}` (validates +
  coerces — e.g. numeric/boolean strings — into a FRESH output value, never
  mutates input). `compileValidatorModule()`'s emitted shape changed from
  `Record<path, Validator>` to `Record<path, {check,errors,parse}>` — a
  type-ir-only concern with no opinion on http-api-projector's
  `Result`/`Validator` types. `packages/api-tree/src/build.ts` gained
  `toValidator`/`toValidatorRecord`, adapting a generated entry's `parse`
  into the single-function `Validator` shape `createApplyValidation`
  expects (`{kind:"err",errors}` → `{kind:"err",error:errors}`, matching
  `Result<T,E>`'s singular `error` field) — written structurally, no new
  runtime dependency between api-tree and http-api-projector.
  `examples/library-api` regenerated and typechecks clean under `strict`.
  Known scope cuts (not attempted this pass): `ref`/`instance` kinds still
  can't be validated structurally (pass-through, same limitation the old
  TypeBox path had, now non-throwing instead of throwing); format regexes
  for uuid/uri/date/time/datetime/duration/bytes are best-effort, not
  spec-exact.
- ~~**Meta typing pattern**~~ — RESOLVED (2026-07-17): `packages/api-tree/src/node.ts`
  now defines `Meta` as an `interface` (was a `type` alias), enabling
  declaration merging. Each protocol package already exports its own meta type
  — `HttpMeta` (`http-api-projector/src/project.ts`), `McpMeta`
  (`mcp-api-projector/src/project.ts`), `CliMeta` (`cli-api-projector/src/cli.ts`),
  `OpenApiMeta` (`openapi-api-projector/src/index.ts`) — rather than mutating
  core's `Meta`. A consuming project can now do declaration merging:
  `declare module '@rhi-zone/fractal-api-tree' { interface Meta extends HttpMeta,
  McpMeta {} }`. No package touches another package's or core's types
  directly.
  Follow-up (2026-07-18, commit 5533c21): consolidated the duplication this
  pattern left behind — `HttpMeta`/`getHttpMeta` had diverging local copies
  in `openapi` and `client` (at the time still separate packages); both now
  import from `http-api-projector` instead. `OpenApiMeta` and `CliMeta` are
  exported alongside `HttpMeta`/`McpMeta` as of the same commit. `OpenApiMeta`
  now lives in `http-api-projector` too, post-merge.
### New threads from the 2026-07-18 validation & middleware session

- **Exact coercion placement in the architecture** — where coercion logic lives (input stage? pre-validate? post-extract?), how it composes with validation, whether codegen produces combined or separate coercion+validation functions by default.
- **Import resolution/provenance tracking for type guard codegen** — DONE (2026-07-18, same session as item 4 above): see that entry for the mechanism (`meta.typeName`/`meta.declarationFile` provenance + caller-supplied `resolveImport`).
- ~~**Pipeline removal/simplification timeline**~~ — RESOLVED (2026-07-19): removed now. See "HttpRoute Pipeline abstraction removed" below.

### Other projection packages still on the old Node-walking pattern —
  narrowed (2026-07-18): `openapi` and `client` (commits d7fd295, 96f4635)
  now consume the already-projected `HttpRoute` tree instead of re-walking
  raw `Node` — both live inside `http-api-projector` now (see the merge
  entries above), so this only applies within that one package's internal
  structure, not as a cross-package gap anymore. `mcp` and `cli` still
  directly walk the raw `Node` tree rather than going through a
  `Node ⇒ ProtocolType` projection + rewriter pipeline the way
  `packages/http-api-projector/src/route.ts` and `packages/type-ir` now do.
  `type-ir` is the reference implementation of the correct pattern.
  Migrating `mcp`/`cli` is unstarted.
- ~~**Projection pipeline generics don't reach HTTP's route projection**~~ —
  RESOLVED (2026-07-17, commit 1f63e1c): `HttpRoute<H>` is now generic;
  `op()`'s return type marks the handler as required (not optional),
  enabling leaf/branch discrimination at the type level. New conditional
  types `NaiveRoute`, `ApplyMethodsRoute`, `ApplyResponseRoute` recursively
  preserve handler types through `naiveTransform`/`applyMethods`/
  `applyResponse`. `applyMoveTo` remains the deliberate erasure boundary —
  runtime string paths from `Meta` are unknowable statically. Type-flow
  tests added (`packages/http-api-projector/src/type-flow.test.ts`).
- **Routing performance** — substantially addressed 2026-07-17. Micro-optimizations
  landed first (commit e525eb5): `splitPath()` avoids a split+filter double
  allocation, `matchRoute()` does direct method lookup at the leaf instead of
  building a candidate array, and slug accumulation mutates in place instead
  of spreading per dynamic segment (safe because static children always win
  over fallback). `compileRouter()` then landed (commit a0f89d5) as an
  optional drop-in replacement for `makeRouterFromRoute()`, walking the
  `HttpRoute` tree once at build time into direct-calling closures with
  pipeline merging hoisted to compile time — but this only pre-merged
  route-level + method-level pipelines, and once the route-level pipeline
  was removed entirely (commit 7072e2c: pipeline now lives on method entries
  only, `mergePipelines`/`compileRouter`/`compileNode` all deleted as dead
  weight) there was nothing left for it to hoist, so it was removed too.
  In its place, composable route compilers landed (commit b669278,
  `packages/http-api-projector/src/compile.ts`): `radixRouter`, `compiledCharRouter`,
  `mapCharRouter` are independent `HttpRoute → (req) => Promise<Response>`
  compilers; their underlying matchers (`radixMatcher`, `compiledCharMatcher`,
  `mapMatcher`) return `RouteMatch | undefined` and compose via
  `chainMatchers` (first-wins); `toRouter` wraps any `Matcher` with pipeline
  execution. A benchmark harness (`packages/http-api-projector/src/route.bench.ts`, 8
  architectures × 30 cases × path lengths up to 8k chars) backs this with
  measured results in `docs/design/routing-benchmarks.md` — the hybrid
  Map+compiled-charFn strategy (#8) wins broadly (13-280ns vs 45-12000ns+ for
  the segment-trie baseline as path length grows), a regex-per-method
  approach is uniformly worst. Separately, `fusePipeline` + `skipEmptyInput`
  (commit a1fe16c) are optional `HttpRoute → HttpRoute` visitors:
  `fusePipeline` composes each method entry's transform arrays down to at
  most one function, collapsing `runPipeline`'s per-request loops to a single
  call; `skipEmptyInput` swaps in a no-op decode/validate for 0-param
  handlers (detected via runtime `handler.length`). Both compose with either
  dispatcher. Update (commit ed29b51): `fusePipeline`/`skipEmptyInput` are now
  wired as `createFetch` defaults (`preset.ts`, both default `true`), but the
  compiled router choice (`radixRouter`/`compiledCharRouter`/`mapCharRouter`)
  is still opt-in — `createFetch`'s default `router` is `makeRouterFromRoute`
  (zero build cost), not one of the compiled strategies. The benchmark numbers
  are single-machine (see Hardware table in routing-benchmarks.md) and the
  crossover points between strategies (when does the hybrid approach's setup
  cost stop paying for itself vs. the plain segment trie) haven't been tuned
  into actual selection constants, nor would `createFetch` pick a strategy
  automatically even if they were.
  Update (2026-07-17): router auto-selection is a non-issue — the
  static/dynamic split already covers the performance space; `createFetch`
  defaults to the zero-cost `makeRouterFromRoute` and the compiled strategies
  are opt-in for users who want them.
- **DX helper composition mechanism is undesigned** — the directive *data
  model* is settled (an array of kind-tagged DU objects on `meta.http`), and
  individual helpers exist (`http.get()` sets only the method directive, with
  no implicit `moveTo`; `http.moveTo("..")` adds a `moveTo` directive;
  `httpVerbBundle(verb, tags)` — exported from `packages/http-api-projector/src/index.ts`
  — is the underlying constructor each verb helper (`get`/`post`/`put`/
  `patch`/`delete`/`head`/`options`) is built from, bundling a method
  directive with its conventional tags in one call) — but how these helpers
  compose together to build up a directive array (e.g. chaining vs.
  spreading vs. some builder) hasn't been designed. This is separate from,
  and downstream of, the settled data model.
- ~~**Input transform escape hatch not yet on the pipeline type**~~ —
  RESOLVED: `Pipeline.sources.transform` already exists in `route.ts` and is
  wired into `defaultDecode` (landed as part of commit cc10c04, the
  stores-based input extraction). An optional
  `transform: (bag: Record<string, unknown>) => Record<string, unknown>`
  step runs after assembly, before the handler sees the input — exactly the
  designed escape hatch for non-conventional payload shapes.
- **Route-level pipeline removed — architectural simplification** (2026-07-17,
  commit 7072e2c): `HttpRoute` no longer carries a `pipeline` at the node
  level, only on individual method entries. `mergePipelines`, `compileRouter`,
  and `compileNode` were deleted — they existed solely to merge/hoist
  route-level and method-level pipelines, and with only one level left
  there's nothing to merge. `matchRoute` and `makeRouterFromRoute` now read
  `entry.pipeline` directly; `injectValidators` stopped threading
  `route.pipeline` through. Net effect: a real simplification, not a
  regression — the compiled-router capability this displaced was rebuilt
  properly as the composable route compilers (see Routing performance
  thread above).
- **`withALS` — built** (2026-07-17, commit ed29b51): `withALS(router, storage,
  init)` in `packages/http-api-projector/src/compile.ts` wraps any `CompiledRouter` so every
  request runs inside its own `AsyncLocalStorage.run()` context — composable
  over `radixRouter`/`compiledCharRouter`/`mapCharRouter`/
  `makeRouterFromRoute`, or another `withALS` layer. Relies on `runPipeline`
  being a clean linear `await` chain (verified safe earlier this session, no
  changes needed there). Wired into `createFetch` as an opt-in `als` option
  (`preset.ts`), applied before `autoMethodLayer` so HEAD/OPTIONS/405
  short-circuits that call through to the router also see the context. Tests
  in `compile.test.ts` (isolation across concurrent requests) and
  `preset.test.ts`. Open question carried forward: whether a plain wrapper is
  all `withALS` ever needs to be, or whether request-scoped-context users hit
  cases (e.g. nested/derived contexts) that want more — unexercised so far.
- **Propagating the HTTP architecture to other projections — partly done**
  (updated 2026-07-18): `packages/http-api-projector/src/route.ts` is the
  reference pattern — generic `HttpRoute<H>`, `Node ⇒ ProtocolType`
  projection + rewriter pipeline, composable compiled dispatch,
  pipeline-fusion visitors, and a shared `mapRoute` tree-visitor. `openapi`
  and `client` were migrated to this pattern this session (commits d7fd295,
  96f4635 — consume `HttpRoute` instead of re-walking `Node`) and then
  folded into `http-api-projector` itself (see the merge entries above).
  `mcp` and `cli` still walk the raw `Node` tree directly (see "Other
  projection packages still on the old Node-walking pattern" above) —
  migrating those two is still unstarted.
- **Sensible HTTP config defaults — built, verified end-to-end against a real
  app** (built 2026-07-17 commit ed29b51; verified 2026-07-18): `createFetch`
  (`packages/http-api-projector/src/preset.ts`) is the single "just give me a
  working HTTP server" entry point — `PresetOptions` exposes toggles for
  `directives`, `validators`, `fusePipeline`/`skipEmptyInput` (both default
  `true`), `rewriters`, `router` (a plain function value, default
  `makeRouterFromRoute` — zero build cost), `cors`, and `als` (opt-in).
  `examples/library-api` was already using `createFetch(api)` (default
  config) as its sole HTTP entry point (`src/tree.ts`/`src/app.test.ts`) —
  confirmed by re-reading, not assumed. What was actually missing was
  coverage of the *toggleable* options against that real tree specifically
  (`preset.test.ts` only exercised them against a synthetic fixture); added a
  `describe("createFetch preset options against the real tree")` block to
  `examples/library-api/src/app.test.ts` exercising `cors`, a custom
  `router` (`radixRouter`), `als` (via a `mapRoute`-built spy rewriter
  wrapping every handler, proving the whole real dispatch — including
  `autoMethodLayer`'s HEAD short-circuit — runs inside the
  `AsyncLocalStorage` context), `fusePipeline`/`skipEmptyInput: false`,
  `directives: false`, and option composition (`cors` + custom `router` +
  codegen-generated validators together) against the actual book/catalog
  routes. All defaults and option shapes held up with no code changes needed
  to `preset.ts` itself — `bun run typecheck` and `bun test` pass across the
  whole workspace (37/37 in the example package, 266/266 in
  http-api-projector).
- **`mapRoute` — shared tree-visitor extracted for rewriters** (2026-07-17,
  commit 7b4b9cc): `mapRoute(route, fn)` in `packages/http-api-projector/src/route.ts` is a
  pre-order visitor that applies `fn` to each node and handles
  `children`/`fallback` recursion; `applyMethods`, `applyResponse`,
  `fusePipeline`, `skipEmptyInput` are now built on it instead of each
  hand-rolling the same recursion. Exported from the package (`index.ts`) for
  users writing custom `HttpRoute => HttpRoute` rewriters. `applyMoveTo` and
  `injectValidators` deliberately stay manual — `applyMoveTo` does structural
  rearrangement (not a per-node transform) and `injectValidators` threads
  path-accumulation context that `mapRoute`'s single-node `fn` signature
  doesn't carry. Not generic over `HttpRoute<H>`'s handler-type parameter, so
  `applyMethods`/`applyResponse` (which need to preserve `H` through their
  conditional return types) still keep their own typed recursion rather than
  delegating to it — `mapRoute` is the erased-type building block for
  rewriters that don't need that precision.

### Design model is captured and authoritative in `docs/design/invariants.md`

The settled model was mined from the design conversation (with the original
author's verbatim words) into `docs/design/invariants.md`, and the next-session
handoff lives in `docs/design/handoff.md`. `docs/design/function-core-and-projection.md`
is fuller but partly superseded — on any conflict, invariants.md wins. invariants.md
also records 7 **guardrails** (things to NOT do — reified runtime meta, treating
input as "raw", leaking HTTP shape into the handler, Kleisli-as-base, losing the
single explicit tree, `create→POST`, forcing "data over code") that recurred as
mistakes. Worth reading those before proposing anything in this area.

### Unsettled design questions need the author's own definition, not invention

From invariants.md §open — these were explicitly left open and (per the guardrails)
should be settled FROM the author's definition rather than guessed:

- ~~The full **verb/method model**~~: RESOLVED (2026-07-17)
- Whether **one agnostic tree can auto-derive both HTTP and CLI** — reframed: structure is optionally part of the skeleton. See `docs/design/invariants.md` § Identity.
- ~~**Node disambiguation**~~: partly addressed with `fallback` field
- ~~**Authoring form for bespoke verb/path overrides**~~: SETTLED — `meta.http` is a DU interpreted by the projector
- ~~**Creation / non-record output encoding**~~: CLOSED (2026-07-17) — purely theoretical, no concrete need
- The unresolved **"is it too general?"** tension — never closed

### Codegen-from-types — RESOLVED (2026-07-16, see handoff-2026-07-16-type-layer.md)

### Concrete type hierarchy — SETTLED and BUILT (2026-07-16)

### Type projector comprehensive coverage — SETTLED and BUILT (2026-07-16)

### Built code doesn't match the combinator identity — RESOLVED (2026-07-16)

Fractal's identity: a codebase compression substrate with a single source of truth skeleton. The "Parsec-style combinator composition" label was aspirational; the actual pattern is inspectable declarations + projectors. See `docs/design/invariants.md` § Identity.

### Type projection as a deliberate capability, not incidental to MCP — SETTLED

The type IR is the foundation for projecting to JSON Schema, validation schemas, SQL DDL, etc. See `docs/design/architecture-layers.md` § Type projection layer.

### SQL optional vs nullable — OPEN (2026-07-16)

Should `optional` imply `nullable` for the SQL projector, or stay separate axes?

### Integration into the consumer app — NOT STARTED (2026-07-16)

`packages/type-ir` built and tested in isolation but not wired into consumer app.

### Dispatch extensibility model — SETTLED

Documented in `docs/design/dispatch-extensibility.md`. Implementation: replace the closed `DispatchMarker` union in `packages/http-api-projector/src/project.ts`.

### Migrate the fenced packages to the function-core model — RESOLVED (2026-07-11)

---

## Design backlog (2026-07-10 session audit)

1. ~~**Override authoring form**~~ — SETTLED (2026-07-10)
2. **`readOnly` vs `safe`** — tag naming question
3. **`openWorld` tag** — meta field or tag? What does it control?
4. ~~**Codegen hardening**~~ — substantially addressed (2026-07-16)
5. **Versioning patterns** — composition with dispatch model
6. **Decorator / metadata layer** — cross-cutting metadata pattern needed?
7. ~~**Per-param HTTP location**~~ — largely built (2026-07-17)
8. ~~**Node disambiguation**~~ — RESOLVED
9. ~~**One tree for HTTP + CLI**~~ — RESOLVED
10. ~~**"Is it too general?"**~~ — DISSOLVED
11. ~~**Constructor sugar / DX**~~ — built (2026-07-17)
12. ~~**`mergeMeta` shallow-merge bug**~~ — FIXED (2026-07-17)

---

## Pending renames — DONE (2026-07-11, commit 8e8329c)

## Pending removals — DONE (2026-07-11, commit 8e8329c)

---

## PUBLISH (after the model settles)

---

## Architecture gaps (2026-07-11 session)

### Input extraction — PARTIALLY BUILT

HTTP extraction is now built (stores-based model with `assemble()`). CLI-side input sources (params, env) still open.

### Output formatting — OPEN

How to turn `U` into a protocol response. Currently hardcoded: JSON + 200 OK.

### Protocol behavior — MOSTLY BUILT

HEAD/OPTIONS/405 via `autoMethodLayer`. CORS separate concern. Content negotiation and error status mapping remain open.

### Middleware / cross-cutting — OPEN

Auth, rate limiting, logging, caching. Auth collapses into input extraction; others remain open.

### SDK generation — BUILT (as client projection)

`packages/client-api-projector` projects tree directly to typed clients.

### Projection-specific metadata — SETTLED

Metadata lives on the node (`meta.http.*`). Each projection reads what it needs.

### Dispatch builtins are extensions — SETTLED

### Two divergent dispatch mechanisms — RESOLVED (2026-07-11)

---

## Deferred (build when needed)

### WebSocket / additional surface kits

Additional protocols (WS, additional CLI work) would follow the same projection pattern.

### Reactivity / streaming substrate

Author wants a canonical stream construct. Live queries and reactive client bindings deferred.

---

## Pointers

- **Authoritative model: `docs/design/invariants.md`** (mined, verbatim; wins on conflict)
- **Next-session handoff: `docs/design/handoff.md`**
- Settled decisions log (naming conventions, etc.): `docs/design/decisions.md`
- Fuller (partly superseded) design: `docs/design/function-core-and-projection.md`
- Commit history: `git log --oneline` in this repo
- Scorecard vs Hono/Elysia: `docs/design/vs-hono-elysia.md`
- Ecosystem design principles: `~/git/rhizone/github-io/docs/decisions/throughlines.md`
- Pre-function-core docs (superseded): `docs/design/roadmap.md`, `docs/design/handler-model.md`, `docs/design/optics-direction.md`
- Architecture layers: `docs/design/architecture-layers.md`
- Type IR survey: `docs/design/type-ir-survey.md`
- Cap'n Proto design rationale: `docs/design/prior-art/capnp-design-rationale.md`
- DX pain points: `docs/design/prior-art/dx-pain-*.md`
- Design philosophy: `CLAUDE.md` § Design Philosophy
</content>
</invoke>
