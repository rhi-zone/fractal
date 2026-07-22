# fractal — TODO

## Open threads (2026-07-22)

- **Typed JIT client (`TypedClient<N>`)** — recursive mapped type in `api-tree` that walks Node's generic type structure to produce a typed client interface. Each projector's `createClient` returns `TypedClient<typeof node>` instead of `AnyClient`. Runtime unchanged; purely type-level. Foundation: Node types already preserve handler signatures through generics (`op(fn: H) → Node<H>`, `api(children: C)` preserves literal keys). tRPC-like DX: zero codegen, types from the tree.
- **Route manifest** — typed contract as a first-class artifact. Base `TreeManifest<N>` in `api-tree` (projector-agnostic: dot-path → {input, output}). Protocol-specific manifests in projectors (HTTP: path → method → {input, output}). Serves tooling, testing, third-party integration, cross-service contracts without coupling to fractal's client machinery.
- **Production-grade codegen** (design backlog) — Stainless-level external SDK: retries, pagination, streaming, configurable error handling, request/response interceptors. Needs design decisions on retry strategy, pagination model (cursor/offset/keyset), streaming interface before implementation.

## Next session (handoff)

> *Open threads from a previous session. Treat as starting context, not instructions — verify relevance before acting.*

**Design backlog is now fully cleared**: GraphQL API projector, extract
improvements (overloads/generics/async-generator streams), and MCP sampling
support are all DONE — see the completed sections below for what landed and
where.

**New open threads from this session (2026-07-21):**
- **GraphQL resolver wrapper overhead** — measured ~0.28µs/call vs ~0.055µs for a raw graphql-js resolver (~5x, ~0.22µs absolute), dominated by `assemble()` and Result-shape detection. <1% of query latency for single-field queries; worth profiling if deep queries with hundreds of resolved fields become a real workload.
- **`compile.ts` AOT validator codegen has no `stream` case** — runtime check/errors/parse for the `AsyncIterable`/stream TypeRef kind is unhandled; a distinct feature needing its own design pass.
- **`derive.ts`'s `deepPartial`/`deepRequired` don't recurse through `stream` kind** — only object/array are recursed into today.
- **`tags.ts` `TAG_STREAMING` is still manual-meta-only** — now derivable from a handler's return type via the `stream` TypeRef kind, but the automatic derivation isn't wired up yet.
- **GraphQL codegen client exists; MCP/CLI typed codegen doesn't** — whether that gap is worth closing depends on usage patterns.
- **Protobuf got real `stream` RPC support; FlatBuffers/Cap'n Proto didn't** — those two binary-format projectors degrade `stream` to their vector/list constructs since they have no native streaming concept.
- **MCP sampling is wired for tool handlers only** — resource and prompt handlers also receive `stores.caller.createMessage`, but it's unclear if that's useful; the MCP spec doesn't define sampling use cases for resource/prompt handlers.
- **GitHub repo is live** (`rhi-zone/fractal`, public) — no CI/CD configured yet.

**Open items (quality & design depth, not blockers):**
- **Root tsconfig investigation** — workspace root `tsconfig.json` still needs a full audit for strictness/consistency across packages. (A narrower, related fix landed 2026-07-21 — commit 2411e3a corrected stale `../core` path mappings to `../api-tree` in three projector tsconfigs — but that was a specific bug fix, not the broader audit.)
- **Structured error types are projector-level config, not a tree-level declaration** — `ErrorEncoder<E,R>` (`packages/api-tree/src/index.ts`) and each projector's `httpErrors`/`cliErrors`/`mcpErrors` combinators let a handler's `Result.err()` values get mapped to transport responses, but this is all consumer-supplied config passed to the projector at wire-up time. There is still no way to *declare* an operation's possible error kinds in the tree/meta itself.
- **Stores typing via declaration merging could go further** — `StoreRegistry` (commit f005c05) makes accessing an undeclared *store name* a compile error, but doesn't type individual *values* within a store. Worth a follow-up pass if store misuse ever shows up in practice.
- **Opt-in detection config for Result/streaming defaults to on** — `detection: { result?, streaming? }` (commit c1ef32b) lets a projector turn off automatic `Result`-unwrapping or `AsyncIterable`-streaming, but both default to `true` for backwards compatibility. Worth reconsidering whether on-by-default is the right long-term default or just the safe migration default.
- **JSON-shape inference (`fromJson`/`fromJsonCorpus`)** — landed and merged (commits 97d8f5b through e292c9d), not an open decision. Known limitations (clustering, union splitting, K=1 confidence scaling) are parked in the low-priority thread below.

**Open threads:**
- **Input pipeline wiring** (CLI/MCP) — `api-tree/src/input.ts` has core `assemble()`, but CLI and MCP still have own implementations. CLI needs stores (env, config, stdin); MCP needs (argument, uri-variable, session context). _Note: low priority — works as-is; consolidation is a quality improvement, not a blocker._
- **MCP Tier 2** — logging (`notifications/message` + log-level negotiation) still not implemented.
- **MCP Tier 3** — Subscriptions, roots (speculative until concrete use case).
- **Type-ir semantic types cleanup** — current kind groupings work but designed quickly; revisit for composition/orthogonality once extension API gets broader consumers.
- **Coercion placement specifics** — currently handled in `parse()` (transform+validate single pass). Broader story for store-level coercion and pre-input coercion TBD.

---

## GraphQL API projector — DONE (2026-07-21)

Server and client implementation complete. Projector includes:

- **Server components**: `project.ts` (core projector), `schema.ts` (schema projection), `resolve.ts` (field resolver), `server.ts` (HTTP/WebSocket setup)
- **Presets**: `presets.ts` (HTTP transport), `ws.ts` (WebSocket subscriptions)
- **Client**: `client.ts` (runtime proxy), `codegen.ts` (typed code generation)
- **Benchmarking**: `resolve.bench.ts` (performance profiling), `context.ts` (store integration)

Follows HTTP/CLI/MCP projection pattern, integrated with middleware/store system.

**Performance note**: Resolver wrapper overhead measured at ~0.28µs per call vs ~0.055µs for raw graphql-js resolver, with ~5x overhead ratio. Dominated by `assemble()` and Result-shape detection; absolute overhead is ~0.22µs/call. For typical single-field queries, this represents <1% of total query latency. Worth profiling if deep queries (hundreds of resolved fields) become a workload.

---

## Non-JSON request bodies, opt-in detection, structured errors, JSON-shape inference — DONE (2026-07-20/21)

Second half of the 2026-07-20 session plus a follow-on 2026-07-21 session, picking up after the streaming/caller-store handoff below.

- **HTTP non-JSON request bodies** (commit 218c845) — multipart/form-data, plain text, and binary request body parsing, completing the non-JSON content-type item (response side landed earlier the same session).
- **Opt-in detection config** (commit c1ef32b) — each projector now accepts `detection: { result?, streaming? }` to toggle automatic `Result`-unwrapping and `AsyncIterable`-streaming independently; `ResponseOverride` (Symbol-based) is always active regardless. Both default `true`.
- **Structured error types** (commit f53a43d) — `ErrorEncoder<E,R>` and `composeErrorEncoders`/`matchKind` (`packages/api-tree/src/index.ts`) give handlers a way to return typed errors via `Result.err()` that each projector maps to a transport-specific response through an `errorEncoder` option — pre-built `httpErrors`/`cliErrors`/`mcpErrors` combinators cover common patterns, unknown errors fall back to prior default behavior. This is projector-wiring-level, not a tree/meta declaration — see the open thread above.
- **JSON-shape inference** (commits 97d8f5b, cd3c241, f922f76, 811448e, a1b3524, 9b90872, be2bdfd, f5f3aab, 78fdf87, e292c9d) — `fromJson` (single-value inference), `fromJsonCorpus` (corpus-level, later split into evidence-collection + resolution phases), full integer-width kind narrowing, property-based (`fast-check`) fuzz harnesses, adversarial tests targeting enum-detection heuristics (K=1 saturation, boundary conditions, clustering), and a prior-art survey document comparing the approach against quicktype and others. Tangential to the projector/middleware work; parked with known limitations, see low-priority thread below.
- Misc: commit 2411e3a fixed stale `../core` → `../api-tree` tsconfig path mappings across three projector packages.

---

## Streaming, progress notifications, and caller store — DONE (2026-07-20)

HTTP streaming (SSE via async generators), MCP progress notifications, and CLI incremental JSONL streaming all completed this session. Handlers yielding `StreamEffect` values now work uniformly across all three projectors:

- **HTTP**: `ResponseOverride` streams via `AsyncIterable<Uint8Array>` with appropriate `Content-Type` headers (application/x-ndjson for JSONL, text/event-stream for SSE).
- **MCP**: `StreamProgress` extractor yields are captured and sent as `notifications/progress` messages. Handlers receive `reportProgress(message, progress)` callback via caller store.
- **CLI**: Incremental JSONL streaming to stdout, matching HTTP's line-delimited JSON format.

**Caller store** (typed via declaration merging on `StoreRegistry` interface) provides transport-level capabilities to handlers without coupling. Pattern unified across all three projectors via middleware/layer design. Each projector populates caller-specific stores (HTTP: response/setHeader, MCP: reportProgress, CLI: writeStderr).

**Stores refactored** from closure-captured context to plain objects with lazy proxy getters, eliminating accidental mutation and improving debuggability.

**StreamEffect DU** defined in `packages/api-tree/src/effect.ts` with discriminated union pattern (kind-tagged values for `Progress`, `Log`, etc.), matching the fractal design philosophy.

---

## Middleware redesign, typed stores, and HTTP response bodies — DONE (2026-07-20)

Middleware refactored from `(next, context) => (input) => result` (with invented context bags per projector) to a cleaner `F => F` pattern where `F = (input, stores) => result`. This eliminates the abstraction leakage and projection-specific `*MiddlewareContext` types (removed: `McpMiddlewareContext`, `CliMiddlewareContext`, `HttpHandlerMiddlewareContext`). 

Stores are now declared via TypeScript declaration merging on the `StoreRegistry` interface — each projector and consumer app merges its own stores into the shared interface, providing type-safe access without coupling. Documented as a side channel and strongly discouraged in favor of explicit handler parameters.

HTTP response body support extended to non-JSON types (binary/stream/text/blob) via `ResponseOverride` passthrough on the response side — request-side multipart/form-data/file upload still open.

Design doc written: `docs/design/middleware-and-caller-context.md`. Caller-context assembly via caller store now in progress (see handoff above).

---

## Cross-projector consistency, middleware, and ALS support — DONE (2026-07-19)

Middleware redesigned 2026-07-20; see section above. Original work: uniform middleware/layer pattern across HTTP/CLI/MCP, ALS support with `withALS`, typed stores via declaration merging.

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

## Validation & middleware patterns — SETTLED (2026-07-18–2026-07-19)

### Design decisions (settled)

1. **Pipeline type is gone**: The 8-stage `HttpRoute` pipeline (including `reqTransforms`, `inputTransforms`, `outputTransforms`, `resTransforms`) was removed 2026-07-19. Real needs (ALS bracket, caller-context, around-hooks) are served by the middleware/layer pattern (`(inner) => (req) => result`), which is now uniform across HTTP, CLI, and MCP. The actual working pipeline is: decode (stores/assemble) → validate → handler → encode.
   See "HttpRoute Pipeline abstraction removed" and "Middleware/layers for CLI and MCP — DONE (2026-07-19)" below.

2. **Validation is a composable mechanism at the Node level, not a core concept**: Validation doesn't live in a special slot; it's a `Node`-level wrapper (`wrapValidators`) that runs generated `parse()` before the handler. This mechanism is used identically by all three projectors (HTTP, CLI, MCP).

3. **All operations get validation, not protocol-specific**: All operations in the API tree receive validation based on extracted types. The tree carries the types (via extract), not the protocol. MCP's `inputSchema` is a projection artifact derived from the extracted types, not the source of truth.

4. **Type guards from generated validators with import provenance** — DONE (2026-07-18): `typeRefFromFunctionNode` (packages/api-tree/src/extract.ts) carries `meta.typeName`/`meta.declarationFile` provenance for NAMED handler parameter types. `compileValidatorModule` (packages/type-ir/src/compile.ts) emits three functions per entry: `check(value): value is T` (boolean), `errors(value): ValidationError[]` (structured errors), and `parse(value): Result` (validate+coerce). Type guards use imported named types or inline structural rendering.

5. **Coercion is type-dependent and separate from strict validation**: Coercion converts string-source values (e.g., `"42"` → `42`). Strict validation checks conformance. `parse()` combines both in one pass for performance; separate `check()` + `coerce()` paths available if needed.

6. **Uniform middleware across all surfaces**: Middleware mechanism is identical — `(inner) => (context) => result` layer shape across HTTP, CLI, MCP. CLI/MCP received this pattern this session (2026-07-19) matching HTTP's established approach.

7. **ValidationError is a flat discriminated union with 15 kinds**: Result-based error signaling, not error classes. Errors carry TypeRef for type information (named type or inline structural). HTTP maps errors to 400, CLI to stderr, MCP to error content.

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

## Middleware/layers for CLI and MCP — DONE (2026-07-19)

Added middleware/layer pattern to CLI and MCP projectors, matching HTTP's
established `(inner) => (req) => result` shape. Both projectors now support
composable layers: a `layers` option on `PresetOptions` accepts an array of
layer factories, each wrapping the inner handler.

CLI layers receive `(input, context)` where `context` carries command-line
metadata; MCP layers receive `(params, context)` where `context` carries
protocol and operation metadata. Middleware composition is identical to HTTP's
via spread/concat/array chaining.

No preset function changes needed (both `runCli` and `createMcpServer` already
accepted a `validators` option and threaded it to the Node-wrapper API; layers
simply extend that mechanism). Tests cover basic composition and isolation
across calls.

Known limitation: middleware/layers are not yet exercised against real
cross-cutting concerns (auth, logging, rate limiting) — the mechanism is in
place but consumer patterns remain to be established.

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

### Low Priority

- **JSON shape inference from data** — single-value and corpus inferrers implemented (`fromJson`, `fromJsonCorpus`), two-phase architecture (evidence collection → configurable resolution), adversarial tests. Parked with known limitations (clustering, union splitting, K=1 confidence scaling). See `packages/type-ir/src/from-json*.ts` and recent commits (a1b3524, 811448e, f922f76, 97d8f5b).

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
