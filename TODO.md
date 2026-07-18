# fractal — TODO

## Next session (handoff)

Pick up from remaining HIGH-priority coverage audit items + open threads (2026-07-18):

**From projector coverage audit (HIGH — blocks production use):**
- **HTTP streaming responses** (SSE/chunked encoding) + **MCP progress notifications** — both need handler context design: how handlers receive transport-level capabilities (MCP: reportProgress/log; HTTP: setHeader/stream; CLI: writeStderr). Critical blocker for AI/realtime use cases.
- **HTTP non-JSON content types** — multipart, form-data, file upload, octet-stream. Request/response payload currently JSON-only.
- **Validation auto-wiring** — HTTP's validation (codegen-based via `injectValidators`) differs from CLI and MCP (hand-rolled). Wire validation consistently: connect extract → compile → inject into preset by default.

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

The input-resolution mechanism that HTTP's projector implements (named stores → sourceMap → convention-based defaults → assembled handler input) now lives in core.

**Completed (2026-07-18):**
- **Core extraction** — `packages/api-tree/src/input.ts` exports `Store`, `Stores`, `SourceMap`, and `assemble()`. `assemble(params, stores, sourceMap)` reads each param from the right store by sourceMap override or convention-based default, applying type coercion, required-field validation, and optional transforms.
- **Dropped provenance thunk** — `sourceMap` is the provenance. No longer a function-returning-config, just the mapping data.

**Current state per projector:**
- **HTTP** (`http-api-projector`): Uses `assemble()` via `defaultDecode` / `Pipeline.sources` (unchanged, already correct).
- **CLI** (`cli-api-projector`): Hardcoded to flags + slug values in `buildInput()`. Still has own implementation; needs wiring.
- **MCP** (`mcp-api-projector`): Passes client arguments or URI-template variables directly. Still has own implementation; needs wiring.

**Open:** Wire CLI and MCP to use the shared `assemble()` from `api-tree`. CLI needs new stores (env, config, stdin); MCP needs stores (argument, uri-variable, session context).

Related but distinct: **handler context** — transport-level capabilities pushed into the handler (MCP: reportProgress/log/sendNotification; HTTP: setHeader/stream; CLI: writeStderr/reportProgress). This is about what the handler can *do*, not what it *receives*. Needs its own design pass (open thread).

---

## Type-safe proxies, type-ir modularization, client codegen — DONE (2026-07-18)

- **Type-safe direct API proxy** — `createDirectApi` now returns `DirectApi<N>`,
  a recursive mapped type computing the proxy shape from the tree's node type.
  Slug subtraction: fallback-captured fields are `Omit`'d from handler inputs,
  collapsing to zero args when fully covered.
- **Type-ir vocabulary modularization** — Semantic type kinds (int32/int64,
  float32/float64, datetime/date/time, duration, uuid/uri, bytes) moved from
  core TypeKinds into independently importable extension modules under
  `src/kinds/`. Core retains only structural + universal-primitive kinds. Each
  extension uses declaration merging + `registerParent`; composite modules
  (wire-numerics, temporal, common) re-export for convenience.
- **fromJsonSchema converter** — JSON Schema → TypeRef reverse conversion,
  enabling consumption of external schemas. Round-trip tested against all
  existing toJsonSchema cases.
- **Client codegen** — `generateClient(route, schemas)` and
  `generateClientFromNode(node, schemas)` emit standalone typed TypeScript
  clients from HttpRoute + SchemaMap. No fractal imports in generated code.
  Nested structure mirrors the tree, path-param fields stripped from inputs,
  GET query params preserved. End-to-end tested with library-api example
  (generate script, generated client, live HTTP tests).

## MCP protocol implementation — Tier 1 DONE (2026-07-18), Tier 2–3 OPEN

**Tier 1 — fully completed (2026-07-18):**
1. **Resources** (`resources/list`, `resources/read`, `resources/subscribe`) — nodes with `meta.mcp.as: "resource"` project to MCP resources. URI derived from tree position; fallback nodes map to URI template variables. Built and wired.
2. **Prompts** (`prompts/list`, `prompts/get`) — nodes with `meta.mcp.as: "prompt"` project to MCP prompts. Argument derivation from schema. Built and wired.
3. **Rich content types** — handler return type drives content type. Projector examines return shape and sets `mimeType` accordingly. Built.
4. **Transport presets** — `createStdioMcpServer` and `createHttpMcpServer` (with Streamable HTTP) provide one-call MCP server construction. Wired.
5. **Input validation** — `createMcpServer` validates `tools/call` arguments against each tool's `inputSchema` before handler invocation (`validateAgainstSchema` — checks `required` and `properties[key].type`; returns error on missing required fields or type mismatch). Built.

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

**Four new type kinds** added to `packages/type-ir` to round out the structural vocabulary:

1. **`instance` kind** — purely nominal: `{ className, source }`. No structure, no fields. Used to mark the concrete side of `instanceof` checks. Extracted from class types by the extractor.
2. **`function` kind** — `{ params, returnType, thisType? }`. Standalone callables, callbacks, higher-order function types. Represents a function signature without belonging to a type's contract.
3. **`method` kind** — subtype of `function`. Belongs to a type's contract, not standalone. Extracted from class methods and attached to the parent type.
4. **`interface` kind** — `{ methods: Record<string, TypeRef> }`. The callable surface of a type. Maps to protobuf `service`, capnp `interface`. Attached to instance TypeRefs via `meta.interface`.

**Projector updates (2026-07-18):** 23 projectors across all format targets — JSON Schema (3 drafts), OpenAPI (2 versions), TypeScript, SQL (4 dialects), Protobuf, Cap'n Proto, JTD, JSDoc, 9 validator libraries, **GraphQL SDL (new), FlatBuffers (new)** — all updated to handle the four new kinds. The extractor (`packages/api-tree/src/extract.ts`, moved from `type-ir` 2026-07-18) updated: classes now project to `instance` (nominal) + methods extracted as `method` TypeRefs + `interface` attached via meta. Round-trip tested; codegen output byte-identical to baseline.

## Session wrap-up: DX build-out + extractor rewrite — DONE (2026-07-18)

Same session as the two merges below, later commits. `bun test` — 1701 pass,
0 fail, 2262 assertions, 51 files (verified end of session).

- **`service()` removed** (commit ba9f9d9) — `service()` reflected class
  instances into `Node` trees to mirror Rust's `impl`-block namespacing
  model; TS already has modules for that, so the pattern added no value.
  `examples/library-api`'s `BooksService` was converted to `api()`/`op()`
  with module-level functions.
- **Stale guide fixed** (commit 82cf56b) — `docs/guide/index.md` referenced
  removed APIs (`path`, `methods`, `body`, `validate`, `serve`, `leaf`, …);
  rewritten for the current authoring surface (`api`, `op`, `http.get`/
  `post`, `createFetch`).
- **OpenAPI and client migrated to consume `HttpRoute`** (commits d7fd295,
  96f4635) — both projectors used to re-walk the raw `Node` tree, duplicating
  verb/segment/path derivation that `http-api-projector`'s own rewriters
  (`applyMethods`, `applyMoveTo`, etc.) already do. Both now take the
  already-projected `HttpRoute` tree instead (`createClientFromRoute(route,
  opts)` is the new core entry point for the client; `createClient(node,
  opts)` wraps it). This landed *before* the two merges below folded both
  packages into `http-api-projector` — see "Other projection packages still
  on the old Node-walking pattern" further down, now updated to reflect only
  `mcp` and `cli` remain unmigrated.
- **`createDirectApi` added to `api-tree`** (commit 79416a2,
  `packages/api-tree/src/direct.ts`) — builds a nested proxy from a `Node`
  tree where each leaf is a direct in-process handler call (`api.books.list()`
  invokes the handler with no HTTP layer at all) — the same shape as the
  client projector but with zero protocol involved.
- **`createMcpServer` preset added** (commit fd5eb22,
  `packages/mcp-api-projector/src/server.ts`) — one-call MCP server
  construction wrapping the official `@modelcontextprotocol/sdk`: registers
  tools derived from `toTools()` and dispatches `tools/call` to `Node`
  handlers, the same DX pattern `createFetch` established for HTTP. Runtime
  input validation against each tool's `inputSchema` (commit ca34f12) landed
  on top of this preset — see the MCP protocol gaps section above.
- **CLI DX parity work** (commits 489e2e1, c46555c) — `cli-api-projector`
  gained: type coercion of flag values to their schema type (number,
  boolean, enum) before handler invocation; generated shell completion
  scripts (bash/zsh/fish) from the command tree
  (`packages/cli-api-projector/src/completions.ts`); `--version`/`-V`;
  required-field validation before handler invocation; schema default values
  applied to absent fields; `CliMeta.alias` wired into dispatch + help text;
  Levenshtein "did you mean?" suggestions for unknown subcommands.
- **Meta type consolidation** (commit 5533c21) — `HttpMeta` + `getHttpMeta`
  now live in `http-api-projector` only; `openapi` and `client` (at the time
  still separate packages, pre-merge) import instead of maintaining
  divergent local copies. Each projector now exports its own typed meta
  interface for consumers: `HttpMeta`, `McpMeta`, `CliMeta`, `OpenApiMeta`.
  Builds on the `Meta`-as-`interface` declaration-merging change from
  2026-07-17 (see the "Meta typing pattern" thread below) — this session's
  work is the dedup + per-projector exports, not the interface conversion
  itself.
- **Extractor rewritten from AST pattern matching to type-system traversal**
  (commits f6f8621, 6617769, 0ef8175, 9874090) — `packages/api-tree/src/tree.ts`'s
  walker used to detect `op()`/`api()` call shapes and follow identifier
  references through the AST to recover tree structure. It's now driven
  entirely by the TypeScript checker: `api()`/`op()` already preserve
  concrete handler types (settled 2026-07-17), so the checker resolves
  children, leaf/branch discrimination, and each leaf's real input/output
  types directly, no AST walking needed for structure. The one remaining
  AST touch — recovering a leaf's underlying function node for JSDoc/param
  reads — stayed, since the type system has no way to hand back a source
  node. The last AST *fallback* (recovering a literal `fallback.name`
  string, which generic inference was widening to plain `string`) was
  eliminated in the final commit (9874090) by making `api()`'s `F` type
  parameter a `const` type parameter (TS 5.0+) — this stops the widening at
  its source, so `fallback.name` survives as a literal through the checker
  with no AST needed at all. Per-field JSDoc descriptions and
  variable-reference following (commits f6f8621, 6617769) landed as
  incremental hardening just before the full rewrite subsumed them. Verified
  byte-identical codegen output against the old AST-based path on
  `examples/library-api`.

## client-api-projector merged into http-api-projector — DONE (2026-07-18)

`packages/client-api-projector` was merged into `packages/http-api-projector`
as `src/client.ts` (+ `src/client-error.ts`, `src/client.test.ts`) — the
runtime client builds HTTP requests and derives verbs/paths from `HttpRoute`,
so it's inherently an HTTP concern, not a separate projection package. Same
reasoning as the OpenAPI merge below. Full rationale in
`docs/design/decisions.md` § Merge client-api-projector into
http-api-projector.

- `createClient`/`createClientFromRoute`, `ClientError`, and the
  `ClientOptions`/`AnyClient` types are now re-exported from
  `http-api-projector`'s package root and a `./client` subpath; the module's
  former cross-package imports of `@rhi-zone/fractal-http-api-projector/dx`
  and `/route` became relative (`./dx.ts`, `./route.ts`).
- `client.test.ts`'s round-trip tests still use `createFetch(api)` (now from
  the same package) for in-process dispatch — no network, no server process;
  they pass unchanged, now exercising a same-package round trip.
- Root `package.json` `workspaces` and the fencing `comment` field, `README.md`,
  `docs/guide/index.md`, `docs/api/index.md`, the `api-tree`/`examples/library-api`
  cross-reference comments, and the `spike/` tsconfig path maps were all
  updated; no `.ts`/`.json`/`.md` reference to `client-api-projector` or
  `@rhi-zone/fractal-client-api-projector` remains outside historical/superseded
  design docs (`roadmap.md`, `converged-model.md`, `handler-model.md` — already
  marked stale/superseded — and this file's own history below this entry).
- `packages/client-api-projector` deleted. `bun run typecheck` and `bun test`
  pass across the whole workspace.

## openapi-api-projector merged into http-api-projector — DONE (2026-07-18)

`packages/openapi-api-projector` was merged into `packages/http-api-projector`
as `src/openapi.ts` (+ `src/openapi.test.ts`) — OpenAPI only ever describes
HTTP APIs, so it's inherently an HTTP concern, not a separate projection
package. Full rationale in `docs/design/decisions.md` § Merge
openapi-api-projector into http-api-projector.

- `toOpenApi`/`toOpenApiFromRoute` and the `OpenApi*` types are now re-exported
  from `http-api-projector`'s package root and a `./openapi` subpath; the
  module's former cross-package imports of `@rhi-zone/fractal-http-api-projector/dx`
  and `/route` became relative (`./dx.ts`, `./route.ts`).
- `createFetch` (`preset.ts`) gained a `PresetOptions.openapi` toggle
  (`boolean | (OpenApiOpts & { path? })`, default `true`) that auto-mounts a
  `GET /openapi.json` handler — the spec is built lazily on first request from
  the same `HttpRoute` tree the router dispatches against, then cached.
- Root `package.json` `workspaces` and the fencing `comment` field, `README.md`,
  `docs/guide/index.md`, `docs/api/index.md`, and the two `spike/` tsconfig
  path maps were all updated; no `.ts`/`.json`/`.md` reference to
  `openapi-api-projector` or `@rhi-zone/fractal-openapi-api-projector` remains
  outside historical/superseded design docs (`roadmap.md`, `converged-model.md`,
  `handler-model.md` — already marked stale/superseded — and this file's own
  history above this entry).
- `packages/openapi-api-projector` deleted. `bun run typecheck` and `bun test`
  pass across the whole workspace.

## tree/extract/cli moved from type-ir to api-tree — DONE (2026-07-18)

`tree.ts`, `extract.ts`, `cli.ts`, and `build.ts` (plus their tests and
`__fixtures__`) moved from `packages/type-ir/src` to `packages/api-tree/src`.
Rationale: they walk `api()`/`op()` source AST — api-tree dev tooling that
happens to use the TypeScript compiler, not type-ir concerns. `compile.ts`
(`TypeRef` → TypeBox validator code) stayed in type-ir as a projector
alongside the other 20+. type-ir dropped its `typescript` dependency and
`bin` field; api-tree gained both, plus new `./tree`/`./extract` subpath
exports (kept off the package root so runtime consumers of the base
`Node`/`Result` model don't pull in the TS compiler) and a `fractal-api-tree`
CLI bin (renamed from `fractal-type-ir`/`fractal-codegen`). All external
call sites (`openapi-api-projector`, `cli-api-projector`,
`examples/library-api`) updated to import `extractToolSchemas`/`SchemaMap`
from `@rhi-zone/fractal-api-tree/tree` instead of `@rhi-zone/fractal-type-ir`.

## Package renames — DONE (2026-07-17)

`core` → `api-tree`, and the protocol projector packages took a `-api-projector`
suffix (`http` → `http-api-projector`, `mcp` → `mcp-api-projector`, `cli` →
`cli-api-projector`, `openapi` → `openapi-api-projector`, `client` →
`client-api-projector`). The naming convention and rationale are settled and
recorded in `docs/design/decisions.md` § Package naming convention. Verified
(2026-07-17): no stale unsuffixed references remain anywhere in `.ts`/`.json`/
`.md` sources (checked via grep across the repo, excluding `node_modules`);
all 1600 tests across the monorepo pass.

---

## Projector coverage audit — MOSTLY COMPLETE (2026-07-18)

Surface inventory of missing or incomplete projector implementations across HTTP, CLI, MCP, type-IR, and extraction layer. Organized by severity for prioritization.

### HIGH — blocks production use:

1. **HTTP: no non-JSON content types** — multipart, form-data, file upload, octet-stream unsupported. Request/response payload only supports JSON serialization. **OPEN**
2. **HTTP: no streaming responses** — SSE/chunked encoding unavailable. Critical blocker for AI/realtime use cases (streaming LLM outputs, live data feeds). **OPEN** — needs handler context design.
3. **HTTP: no auth metadata** — no `securitySchemes` in OpenAPI output. Can't emit security requirements in the spec. **DONE (2026-07-18)** — `meta.openapi.security` + `securitySchemes` implemented.
4. **HTTP client: no retry/backoff, timeout, or streaming** — generated client has no resilience or streaming support. **DONE (2026-07-18)** — client-level + per-call timeout, runtime + codegen support added.
5. **MCP server: no progress notifications** — long-running tool calls appear hung with no way to report progress to the client. **OPEN** — needs handler context design.
6. **Cross-cutting: validation inconsistent** — HTTP's validation (optional, codegen-based, wired via `injectValidators`) differs from CLI and MCP (hand-rolled per projector). No shared validation primitive exists. **OPEN** — validation auto-wiring design needed.
7. **Type-IR `fromJsonSchema`: silently mishandles draft-04/07 tuple syntax** — expects 2020-12 `prefixItems` format; older schemas with positional array items fail silently or produce incorrect TypeRefs. **DONE (2026-07-18)** — draft-04/07 tuple support added to `fromJsonSchema`.

### MEDIUM-HIGH:

8. **MCP: no sampling support** — server and client lack sampling capability. Blocks LLM-in-the-loop tool patterns (e.g. model-chooses-tool chains). **OPEN**
9. **Node: no auth/permission metadata convention** — each projector reinvents or skips. No settled pattern. **OPEN**

### MEDIUM:

10. **HTTP: no declarative status codes** — always 200/400 unless handler overrides. No way to declare that an operation always returns 201, 301, 204, etc. **DONE (2026-07-18)** — `meta.http.directives` response override already supports this.
11. **CLI: no interactive prompts** — can't prompt for missing args interactively; no stdin piping support. **OPEN**
12. **MCP server: no logging, subscriptions, or cancellation** — missing `notifications/message`, `resources/subscribe`, tool `Cancel` support. **OPEN** — Tier 2–3 features.
13. **Node: no deprecation at tree level** — only `meta.openapi.deprecated` exists (HTTP-specific). Should be projector-agnostic. **DONE (2026-07-18)** — lifted to tree-level tag (projector-agnostic).
14. **Node: no structured error types** — no way to declare operation-specific error outcomes in the tree. Handlers throw or return Result; tree is silent. **OPEN**
15. **Type-IR: no readonly modifier** — IR lacks a way to express read-only fields. Most targets support it; IR doesn't track it. **DONE (2026-07-18)** — readonly modifier added to type-ir.
16. **Extract: no overloaded functions, generics, or async generators** — these TS patterns either error or degrade silently. **OPEN**

### Missing projectors entirely:

17. **GraphQL** — no type-ir projector, no API projector. Design exploration archived at `docs/archive/fc-op-kinds/projection-graphql.md`. **PARTIALLY DONE (2026-07-18)** — type-ir SDL projector complete; API projector (server + client) still open.

### New projectors added (2026-07-18):

18. **FlatBuffers type-ir projector** — DONE (2026-07-18). Follows the same `TypeRef` → wire-format pattern as Protobuf/Cap'n Proto.

---

## Open design questions

### ~~Attribute dispatch (header/query/contentType) is an open design question~~

RESOLVED (2026-07-17): parked — not a routing-tree concern. Header/query/
contentType-based dispatch (e.g. `X-Api-Version` selecting different response
shapes at the same path+method) is realistically rare, requirements are
unpredictable, and it doesn't belong on the routing tree. The stores-based
decode system already supports reading arbitrary headers/query params as
handler input (`Pipeline.sources.sourceMap`), so version-conditional logic
is a helper function in user code, not routing infrastructure. OpenAPI has no
native mechanism for same-path/method header-differentiated schemas (the
projection was already faking it as extra path segments), and the client
projection doesn't model header variants at all — further evidence this isn't
a tree-level concern.

Prior design work (2026-07-09 session) identified a source×strategy split
(exact hash vs. ordered floor-lookup, with a pluggable comparator) — that
analysis is sound but the conclusion is that it doesn't earn its complexity
as a framework primitive. If a real consumer need surfaces, revisit then.

## Open threads (advisory)

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
- **Other projection packages still on the old Node-walking pattern** —
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

- ~~The full **verb/method model**~~: RESOLVED (2026-07-17) — the system is
  complete: seven builtin verb helpers (`get`/`post`/`put`/`patch`/`delete`/
  `head`/`options`), `verbFromTags` tag-lattice dispatch, an extensible
  `HttpMethods` interface via declaration merging, and `httpVerbBundle`
  exported from `packages/http-api-projector/src/index.ts` as the shared
  constructor each verb helper is built from. The only remaining gap — a
  `customVerb()` convenience helper — is non-blocking and can be added on
  demand; reopen if it turns out to block something.
- Whether **one agnostic tree can auto-derive both HTTP and CLI**, given HTTP
  paths/headers and CLI subcommands/env vars have no 1:1 mapping —
  reframed (2026-07-16): structure is optionally part of the skeleton
  (explicit tree, flat declarations, or inferred from class/module/other
  signals). The question isn't "can one tree drive both" but "how much
  structure does each projection need, and where does it come from?" See
  `docs/design/invariants.md` § Identity.
- ~~**Node disambiguation**~~: partly addressed — `fallback` field separates
  wildcard capture from keyed dispatch, static children always win. Remaining
  question: is there ever more than one fallback?
- ~~**Authoring form for bespoke verb/path overrides**~~: settled — `meta.http`
  is a DU interpreted by the projector (interpreter pattern). No named keys.
  See `docs/design/router-model.md` § HTTP metadata.
- ~~**Creation / non-record output encoding**~~: CLOSED (2026-07-17) —
  purely theoretical, no concrete need. Nothing in the codebase implements
  or references a creation semantic: no directive, no tag, no rewriter, no
  test, no example. The `examples/library-api` `add` endpoint is a plain
  `http.post`. Reopen if a real use case surfaces.
- The unresolved **"is it too general?"** tension — never closed.

### Codegen-from-types — RESOLVED (2026-07-16, see handoff-2026-07-16-type-layer.md)

The vertical slice's on-tree `Schema` values (`str`/`num`/`bool`/`obj`) were
provisional scaffolding pending codegen-derived validators from TS types +
JSDoc. That codegen now exists: `packages/api-tree/src/extract.ts` extracts
`TypeRef`s from TS source (tuples, index signatures, literals, enums,
discriminated unions, intersections, 3 branded-type patterns, recursion,
`Promise` unwrapping, class privacy), and `packages/type-ir` projects those
`TypeRef`s to 23 format targets (see the two SETTLED sections below). Whether
the on-tree `Schema` scaffolding in `packages/api-tree`/`packages/http-api-projector` has
actually been swapped out for codegen-derived validators is a separate,
still-open question — see "Integration into the consumer app is not started"
below, which is about the *consumer app*, not this in-repo scaffolding; that
in-repo swap has not been verified either way this session.
`extract.ts` moved from `type-ir` to `api-tree` 2026-07-18 (see "tree/extract/cli
moved" above) and the *tree walker* it feeds, `packages/api-tree/src/tree.ts`,
was fully rewritten the same session from AST pattern-matching to
type-system traversal (see "Session wrap-up" above) — `extract.ts`'s own
`TypeRef` extraction from a function node is unaffected by that rewrite,
only how the walker finds the function nodes changed.

### Concrete type hierarchy — SETTLED and BUILT (2026-07-16, see handoff-2026-07-16-type-layer.md)

The type IR design principles (shape hierarchy via subtyping + open metadata
bag) are now built, not just designed: `packages/type-ir` — 28 `TypeKind`s,
`parents`/`ancestors`/`resolve()` subtyping-with-fallback, open `meta` bag,
9 derivation operators (`partial`/`required`/`deepPartial`/`deepRequired`/
`pick`/`omit`/`extend`/`nullable`/`withMeta`). 1118 tests passing in
`packages/type-ir` alone (1365 across the full monorepo, verified this
session). See `docs/design/handoff-2026-07-16-type-layer.md` for the full
inventory.

### Type projector comprehensive coverage — SETTLED and BUILT (2026-07-16)

21 projectors across 23 format targets (JSON Schema current/07/04, OpenAPI
3.0/2.0, TypeScript, SQL DDL postgres/mysql/sqlite + separate MSSQL dialect,
Protobuf, Cap'n Proto, JTD, JSDoc, and 9 runtime validator libraries: Zod,
Valibot, TypeBox, ArkType, runtypes, Superstruct, io-ts, Yup, Effect Schema),
all following the `handlers` + `resolve()` fallback pattern. The extractor
(`packages/type-ir/src/extract.ts` at the time; now `packages/api-tree/src/extract.ts`,
moved 2026-07-18) was hardened for tuples, index
signatures, literals, enums, discriminated unions, intersections, 3 branded-type
patterns, recursive types, `Promise` unwrapping, and class privacy filtering.
Full inventory: `docs/design/handoff-2026-07-16-type-layer.md`.

### Built code doesn't match the combinator identity — RESOLVED (2026-07-16)

**Resolved**: the "combinator identity gap" was a symptom of unclear
self-description, not a structural deficiency. Fractal's identity is settled:
a codebase compression substrate that gives codebases a skeleton (the central
structure supporting the entire app) as a single source of truth, with
everything else derived from it. The "Parsec-style combinator composition"
label was aspirational naming; the actual pattern is inspectable declarations
+ projectors. See `docs/design/invariants.md` § Identity. The operation layer
design work continues under this framing — see
`docs/design/operation-layer-design.md`.

The stated identity is "Parsec-style combinator composition," but the built
code is `node`/`op`/`service`/`param` — data structure construction, not
combinator composition. `docs/design/routing-expression-model.md` was supposed
to bridge this gap but the combinator primitives aren't settled and the
expression model isn't implemented. Until this is resolved, the gap between
stated identity and built code is real, not cosmetic.

**New input (2026-07-16): `docs/design/operation-layer-spec.md`.** This is a
requirements document mined from the consumer app's evidence (use-case
descriptors, entity descriptors, HTTP binding, audit specs, session-input
threading, authorization guards, error-code mapping) — not a fractal design
proposal, but real pressure on this exact gap. The spec's requirements need,
in order: (a) the combinator identity resolved first (an "operation"
declaration presumably composes from combinators — no substrate to define it
in terms of until the primitives are settled); (b) a decision on whether
auth/audit/side-effects/error-mapping are DU metadata on an operation node
(open metadata bag, consistent with the type IR's own pattern) or a separate
mechanism/layer; (c) reconciliation of the spec's direct
handler-binding-with-throws + declarative `errorMap` against the existing
Result/Kleisli composition style in `packages/api-tree`. Per the "unsettled
design questions need the author's own definition" guardrail above, this
spec supplies evidence and pressure, not an answer — the operation layer
still needs the author's own definition, not invention from the evidence.

### Type projection as a deliberate capability, not incidental to MCP

`@rhi-zone/fractal-type-ir` (formerly the separate `fractal-codegen` package,
merged 2026-07-18) already does type projection (TS types → JSON Schema for MCP
input schemas), and a valibot codegen spike exists in `the consumer app`. The
2026-07-14–16 session recognized this should be a first-class concern —
separate from routing — rather than something that happens to exist because
MCP needed it. The type IR (see the concrete-type-hierarchy thread above) is
the foundation for projecting to JSON Schema, validation schemas, SQL DDL, etc.
See `docs/design/architecture-layers.md` § Type projection layer.

### SQL optional vs nullable — open design decision (2026-07-16)

`partial()` (`packages/type-ir/src/derive.ts`) sets `meta.optional = true` on
object fields; the SQL projector (`packages/type-ir/src/sql.ts`) only
inspects `meta.nullable` when deciding whether to render a column as
`NULL`-able. A `partial()`-derived type does not currently make its optional
fields nullable in the emitted DDL. Open question: should `optional` imply
`nullable` for the SQL projector specifically, or should they stay separate
axes (a field can be optional on an input schema without being nullable in
the stored table, e.g. server-defaulted)? Not yet decided; see
`docs/design/handoff-2026-07-16-type-layer.md` § What's open.

### Integration into the consumer app is not started (2026-07-16)

`packages/type-ir` is built and tested in isolation but not wired into the
consumer app to replace any hand-duplicated schemas — see
`docs/design/operation-layer-spec.md` §1.2/§4 for the concrete duplication
(`LocationCreateSchema`/`LocationPatchSchema`/`ListLocationsInputSchema`,
"location patch" hand-typed in up to 4 places) this would resolve once wired
up.

### Dispatch extensibility model is settled in `docs/design/dispatch-extensibility.md`

The extensible dispatch model is settled: augmentable `DispatchKinds` interface,
batteries as plain matcher functions, declaration merging next to the tree,
projector takes a dictionary + tree. See `docs/design/dispatch-extensibility.md`
for the full model and pseudocode. Implementation: replace the closed
`DispatchMarker` union and hardcoded if/else dispatch in `packages/http-api-projector/src/project.ts`.

Note: dispatchers/matchers are interpreters — degenerate (non-nested) case
of the interpreter pattern. The DU is the "AST", the projector does case
analysis. This reframing means ALL projection concerns (not just dispatch)
should follow the same DU + interpreter pattern. See `router-model.md`
§ HTTP metadata.

Reframed: the DU + matcher model is one implementation of the `match`
combinator in the routing expression model. See
`docs/design/routing-expression-model.md`.

### Migrate the fenced packages to the function-core model — RESOLVED (2026-07-11, commit 8e8329c)

The function-core rewrite (`docs/design/function-core-and-projection.md`) landed
as a vertical slice: `packages/api-tree` + `packages/http-api-projector` are rewritten to the new
model (function category + Result + Kleisli/applicative combinators; the
protocol-neutral D-tree `path`/`param`/`group`/`methods`/`route` + `app`; HTTP
dispatch + `Result`→`Response` encoding), proven by `examples/library-api` (the
`examples/spine-demo` name in earlier notes does not exist on disk — the actual
example directory is `examples/library-api`; `examples/todo-api` and
`examples/dogfood` also do not exist on disk).

Root `package.json` `workspaces` (verified 2026-07-11) is now:
`packages/api-tree`, `packages/http-api-projector`, `packages/mcp-api-projector`, `packages/codegen`
(later merged into `packages/type-ir`, 2026-07-18),
`packages/openapi-api-projector`, `packages/cli-api-projector`, `packages/client-api-projector`, `examples/library-api`.
**Every package in `packages/` is in the workspace — none are fenced out.**
`packages/openapi-api-projector` and `packages/client-api-projector` were previously fenced but are back
in; `packages/mcp-api-projector` and `packages/cli-api-projector` are new packages not mentioned in the
original fencing note at all. `examples/library-api` imports
`@rhi-zone/fractal-mcp-api-projector` and `@rhi-zone/fractal-codegen` (later
merged into `@rhi-zone/fractal-type-ir`, 2026-07-18) directly, so at least
those two are active, not just present.

The open question this left — whether `openapi` and `client` had actually
been migrated to the function-core model, or were back in the workspace
un-migrated — is now closed: the coordinated refactor (commit 8e8329c) touched
`openapi`, `client`, `cli`, `codegen`, and `mcp` directly, updating each for
the `fallback` field and DU-based `meta.http` shape (and rewriting
`packages/client-api-projector` as a self-contained enumerator mirroring `openapi`'s
pattern). All packages work with the new node shape now; `npm test`/typecheck
pass across all 8 workspaces (233 tests, 0 failures) per the commit.

---

## Design backlog (2026-07-10 session audit)

Ordered roughly easiest → hardest to decide:

1. ~~**Override authoring form**~~ — SETTLED (2026-07-10): `meta.http` is a DU
   interpreted by the projector (interpreter pattern), not named keys. `verb`,
   `segment`, `when` are retired as separate keys. See router-model.md
   § HTTP metadata.
2. **`readOnly` vs `safe`** — tag naming. `safe` aligns with HTTP semantics
   (RFC 9110 §9.2.1); `readOnly` is more intuitive but narrower.
3. **`openWorld` tag** — is it a tag, a meta field, or something else? What
   does it actually control?
4. ~~**Codegen hardening**~~ — substantially addressed 2026-07-16: the
   extractor (`packages/type-ir/src/extract.ts` at the time; now
   `packages/api-tree/src/extract.ts`) now handles tuples, index
   signatures, literals, enums, discriminated unions, intersections, 3
   branded-type patterns, recursive types, `Promise` unwrapping, and class
   privacy. Whether further edges remain is unknown until the consumer-app
   integration (below) exercises it against real schemas. The *tree walker*
   this feeds was separately rewritten 2026-07-18 from AST pattern-matching
   to type-system traversal (see "Session wrap-up" near the top) — a
   different concern from the extractor's own `TypeRef`-from-node logic,
   which this item covers.
5. **Versioning patterns** — how do versioning strategies (date-based, semver,
   header) compose with the dispatch model? (dispatch-extensibility.md has
   the date-versioning example; are there others?)
6. **Decorator / metadata layer** — is there a need for a decorator-like
   pattern for cross-cutting metadata (auth, rate-limit, caching)?
7. ~~**Per-param HTTP location**~~ — largely built (2026-07-17, commit
   cc10c04): `packages/http-api-projector/src/decode.ts` makes this explicit via named
   stores (`path`/`query`/`header`/`body`) plus a `primaryStoreForMethod`
   convention and a per-param `sourceMap` override on `Pipeline.sources`, so
   a param's source is either convention-derived or explicitly declared, not
   silently implicit. Still open: this is HTTP-specific, not yet generalized
   as a type-IR-level metadata convention the way the 2026-07-14–16 reframing
   anticipated, and CLI has no equivalent (params/env sourcing for CLI is
   still undesigned).
8. ~~**Node disambiguation**~~ — reframed: the API tree is keyed by operation
   name (unique by construction). Path-level disambiguation (wildcard vs
   keyed dispatch) only arises in the HTTP route tree, which is a projection.
   See `docs/design/routing-and-transforms.md`.
9. ~~**One tree for HTTP + CLI**~~ — resolved: one API tree drives both. Each
   protocol has its own independent projection (`Node => ProtocolType`,
   e.g. `Node => HttpRoute`) with its own convention transforms and
   rewriters; the API tree itself doesn't change. The seam is the
   projection function per protocol, not the tree. See
   `docs/design/routing-and-transforms.md`.
10. ~~**"Is it too general?"**~~ — dissolved by the identity settlement. The
    scope is bounded by "what your codebase's skeleton needs to express." See
    invariants.md § Identity.
11. ~~**Constructor sugar / DX**~~ — built (2026-07-17): `api(children, opts?)`
    is now the single constructor (`node()` retired, commit ebc0064);
    `http.*` method directives, `crud()`, `httpProjection()` preset landed
    earlier (commit eee3c66). `op()`/`api()` are now generic and preserve
    handler types through tree construction instead of erasing to `Handler`
    (commit ff7c579), and the downstream `route.ts` projections now preserve
    those types too (commit 1f63e1c, see resolved thread above) — the only
    remaining erasure boundary is `applyMoveTo`, deliberately, since its
    runtime string paths are unknowable statically. See
    `docs/design/routing-and-transforms.md` § DX.
12. ~~**`mergeMeta` shallow-merge bug**~~ — FIXED (2026-07-17): `mergeMeta`
    (`packages/api-tree/src/node.ts`) is now a fully recursive deep-merge —
    plain objects (e.g. `tags`, `http` sub-bags) merge deeper instead of the
    later bag clobbering the earlier one wholesale, arrays concatenate (e.g.
    `http.directives`, so a verb-bundle's directive and a caller's extra
    directive both survive instead of the second call overwriting the
    first), and scalars are overwritten by the later bag as before. `undefined`
    still defers rather than overriding a previously-set value.

---

## Pending renames — DONE (2026-07-11, commit 8e8329c)

- `by` → `kind` rename on the HTTP dispatch marker discriminant landed in
  `packages/http-api-projector/src/project.ts` as part of the coordinated refactor.

## Pending removals — DONE (2026-07-11, commit 8e8329c)

All four items landed in the coordinated refactor (commit 8e8329c,
"refactor: retire dispatch()/ParamNode/effectiveTags/buildRoutes for fallback
+ DU model"):

- `effectiveTags` / tag inheritance in `packages/api-tree/src/tags.ts` — removed;
  replaced by the `mapNodes` pre-order/post-order tree-transform visitor. A
  node's tags are now exactly what's on the node.
- `ParamNode` type and `param()` constructor — removed; replaced by a
  `fallback?: { name, subtree }` field on `Node` (`children` is now
  `Record<string, Node>`). See `docs/design/router-model.md` § Node Shape.
- `buildRoutes` / `compile` / flat route table in `packages/http-api-projector/src/project.ts`
  — removed; the projector dispatches directly on the tree at request time
  (`candidatesForUrl` + `makeRouter(node)`, O(depth)), with a small full-tree
  scan reserved for the `legacyPath` escape hatch only. See
  `docs/design/router-model.md` § No compilation step.
- `meta.http.verb`, `meta.http.segment`, `meta.http.when` as named keys —
  removed; replaced by DU variants (`meta.http.dispatch: DispatchMarker`,
  `meta.http.directives: HttpDirective[]`) with interpreter functions in the
  projector. See `docs/design/router-model.md` § HTTP metadata.
- `dispatch()` in `packages/api-tree/src/node.ts` — removed along with its test
  (the dead protocol-neutral path-walking dispatcher flagged 2026-07-11 had no
  callers in production code). The "which mechanism wins" question this
  raised is moot now that both the core walker and the flagged
  `buildRoutes`/`makeRouter` duplication are gone — see Architecture gaps
  § Two divergent dispatch mechanisms below.

Downstream packages (`cli`, `mcp`, `openapi`, `client`, `codegen`) and
`examples/library-api` were updated in the same commit for the new
`fallback`/DU shapes. All packages' `npm test`/typecheck pass (8/8
workspaces, 233 tests, 0 failures) per the commit message.

---

## PUBLISH (after the model settles)

- Create `github.com/rhi-zone/fractal`, push, set pages/topics/homepage.
- Ecosystem docs-sync in `~/git/rhizone/github-io` — 7 touchpoints:
  1. `docs/about.md`
  2. `README.md`
  3. `docs/.vitepress/config.ts`
  4. `docs/index.md`
  5. `docs/projects/index.md`
  6. NEW `docs/projects/fractal.md`
  7. `~/git/rhizone/profile/profile/README.md`

---

## Architecture gaps (2026-07-11 session)

The gap between the abstract tree and a complete API projection is larger than
currently addressed. The tree says WHAT exists and HOW it's organized; the
projection fills in HOW TO TALK TO IT in a specific protocol. Key gaps:

### Input extraction

How to get `T` from a protocol request. Currently hardcoded in the HTTP
projector: merge path params + query params + JSON body. Should be pluggable
with reasonable defaults. Reasonable defaults first, decomposition into
primitives later — don't over-engineer upfront.

All extraction strategies are extensions (same mechanism as dispatch kinds —
shipped variants are not architecturally different from user-added ones).
The need for specific default strategies should be proven, not assumed.

Auth and caller-context (middleware concerns) collapse into input
extraction — auth credentials are just another input parameter sourced from
the protocol request. No special middleware layer needed. See
`docs/design/routing-expression-model.md`.

**Update (2026-07-17)**: input sources (query, body, path segments, headers,
cookies for HTTP; params, env for CLI) and validation/transformation are still
open. They're separate from the structural routing model settled in
`docs/design/routing-and-transforms.md` — that doc covers tree structure and
transforms only, not input binding.

**Further update (2026-07-17, later)**: HTTP input extraction is now built,
not just designed. `packages/http-api-projector/src/decode.ts` (commit cc10c04) introduces
a stores-based model — a request is exposed as uniform named key-value stores
(`path`, `query`, `header`, `body`); `httpStores()` builds them, and
`assemble()` reads each declared param from the right store by convention
(`primaryStoreForMethod`: GET/HEAD/DELETE → query, POST/PUT/PATCH → body)
with per-param source overrides. `Pipeline.sources` (`route.ts`) wires this
in; an explicit `decode` function still wins when set (full override,
backward compatible with the old `defaultDecode`/`bulkCollect` behavior).
Validation is also built: `Pipeline.validate` is an array of
`(input) => Result<unknown, unknown>` validators, run sequentially after
`inputTransforms` and before the handler — first `Err` short-circuits with a
400, node-level and method-level validators concatenate (commits 8bf72e2,
ad8b921). `createApplyValidation(validators)` is a rewriter that injects
codegen-generated validators into the route tree by key + path, with
duplicate-key detection and pass-through when a path has no matching
generated validator (the pre-codegen stub case) — see open thread below on
wiring the actual TypeBox codegen output through this. Still open: CLI-side
input sources (params, env) and the general "input transform escape hatch"
for non-conventional payload shapes (open thread below).

### Output formatting

How to turn `U` into a protocol response. Currently hardcoded: JSON + 200 OK.
Same approach as input: pluggable, reasonable defaults, decompose later.

### Protocol behavior

Protocol obligations that aren't business logic:
- HEAD (derive from GET response), OPTIONS (allowed methods), 405 — currently
  `autoMethodLayer`
- CORS — separate concern from the above (preflight, Access-Control-* headers)
- Content negotiation, error status mapping, etc.

### Middleware / cross-cutting

Auth, rate limiting, logging, caching. Not in the tree. Design backlog #6.

Auth collapses into input extraction. Rate limiting, logging, caching remain
as open questions — may also reduce to input extraction or may need their
own expression. See `docs/design/routing-expression-model.md`.

### SDK generation / Stainless NIH

Generating typed client SDKs directly from the tree (no OpenAPI intermediate).
The tree already has the structure and types that Stainless infers from OpenAPI.
`packages/client-api-projector` proxy is a rough version of this. A natural projection.

### Projection-specific metadata is co-located, not external

Metadata that governs a node lives on the node (`meta.http.*`). Tree transforms
targeting specific nodes in a typesafe manner is impractical (fragile path
strings or heavy lens machinery). Each projection reads what it needs from meta;
other projections ignore irrelevant namespaces.

### Dispatch builtins are extensions, not a separate category

Method dispatch, header dispatch, etc. are DU variants + matchers shipped with
the package — same mechanism as user-added kinds. The architecture is uniform.
Note: the specific builtins shipped (method, header) were assumed from HTTP
convention, not derived from proven need. This may or may not be problematic.

Reframed by routing expression model: "which builtins earn their spot" falls
out of the expression language design, not from importing HTTP categories.
See `docs/design/routing-expression-model.md`.

### Two divergent dispatch mechanisms — RESOLVED (2026-07-11, commit 8e8329c)

`packages/api-tree/src/node.ts` used to have its own `dispatch()` — a
protocol-neutral, path-segment-only tree walk (no method/header awareness) —
while `packages/http-api-projector/src/project.ts` had `buildRoutes`/`makeRouter`, the one
actually wired into the HTTP projection. Both were removed in the coordinated
refactor: core's `dispatch()` was deleted outright (dead code, no production
callers), and HTTP's `buildRoutes`/`makeRouter(routes)`/`Route[]` were replaced
by direct tree-walk dispatch at request time (`candidatesForUrl` +
`makeRouter(node)`, O(depth)). There is now a single dispatch mechanism, not
two.

**Superseded (2026-07-17, commit 18c5195)**: that single mechanism
(`candidatesForUrl`/`makeRouterForNode`/`collectCandidates`/`findLegacyPath`/
`MatchCondition`) was itself retired in favor of the `HttpRoute` pipeline —
`makeRouter` in `packages/http-api-projector/src/project.ts` now only accepts an
`HttpRoute` (built via `naiveTransform` → `applyMethods`/`applyMoveTo`/
`applyResponse` → `makeRouterFromRoute`, see `packages/http-api-projector/src/route.ts`).
`autoMethodLayer` and `createFetch` migrated to the same pipeline.
`verbFromTags` was extracted out of `project.ts` into the HTTP-specific
`packages/http-api-projector/src/tags.ts` in the same commit (it's not a core concern);
`project.ts`, `openapi`, and `client` re-import it from there without
changing their import paths. There is still a single dispatch mechanism —
this is a further consolidation, not a new fork.

---

## Deferred (build when needed)

### WebSocket / MCP / CLI surface kits

The protocol-neutral D-tree is surface-agnostic at the core level. Additional
surface kits (WS, MCP, CLI) would follow the same projection pattern. Note the open
question above on whether one tree can drive both HTTP and CLI — that's a
prerequisite for the CLI kit. No design work started.

### Reactivity / streaming substrate

invariants.md notes the author wants a canonical stream construct (rejecting a
`Result<T,E> | Response` escape hatch). Live queries and reactive client bindings
would require a reactive client library to exist first.

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
