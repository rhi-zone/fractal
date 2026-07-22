# fractal 1.0 Release Roadmap

## Vision

fractal is a universal type conversion hub: a single type intermediate
representation (type-ir) that ingests type and schema information from
across the software ecosystem — programming language source, schema
languages, IDLs, wire formats, and runtime validation libraries — and
projects it back out to any of them. Where a tool like quicktype turns
sample data into types for a handful of target languages, and a tool like
Terraform's providers model infrastructure state, fractal's job is
narrower and deeper: it is the hub through which type information moves
*between* representations that were never designed to talk to each other
— a Zod schema becomes a Rust struct, an OpenAPI document becomes a SQL
table, a Protobuf message becomes a Pydantic model — without every pair of
formats needing its own bespoke converter. On top of that type layer sits
a second, independent capability: the fractal framework, which lets a
single API description (the `api()`/`op()` tree) project to HTTP, CLI,
MCP, and GraphQL surfaces from one source of truth. The two layers compose
but are separable: type-ir is useful standalone as a conversion library;
the framework is useful because it is built on type-ir's projections.

This document is the public checklist for what "1.0" means. Every slice
below is marked **NOT GREEN**. A slice only turns green with the project
owner's explicit sign-off — this file records status, it does not confer
it.

---

## 1.0 Release Checklist

### Type IR Core

**Status: NOT GREEN**

The shared representation every ingester and projector reads and writes:
a kind-tagged `TypeShape` union, an open `meta` bag per node, a subtyping
`parents` lattice with `resolve()`/`ancestors()` fallback dispatch, and
`TypeRefDocument` (`{ root, defs }`) for named/recursive/shared types.

What exists:
- Core structural + universal-primitive kinds (`boolean`, `number`,
  `integer`, `string`, `null`, `void`, `unknown`, `never`, `object`,
  `instance`, `array`, `stream`, `page`, `tuple`, `map`, `union`,
  `literal`, `enum`, `ref`, `intersection`, `function`, `method`,
  `interface`) in `packages/type-ir/src/index.ts`.
- An extension mechanism: additional kinds (int/float widths, wire
  numerics, date/time, duration, temporal, semantic strings, bytes,
  refinements — `packages/type-ir/src/kinds/*.ts`) augment `TypeKinds` via
  declaration merging and register their place in the subtyping lattice
  with `registerParent()`, independently importable.
- `resolve()`/`ancestors()` — a handler for a specific kind, or its
  nearest registered ancestor (e.g. `method` falls back to `function`).
- `TypeRefDocument` — self-contained `{ root, defs }` documents for
  recursive and shared types, with `resolveRef`, `walkTypeRef`,
  `nodeCount`, and an opt-in `shouldShare` heuristic for structural
  sharing across projectors.
- An AOT validator codegen projector (`compile.ts`) — `check`/`errors`/
  `parse` functions with no runtime dependency, alongside the 30+
  interpretive projectors.

What's planned / open:
- Kind groupings under `kinds/*` were "designed quickly" per project
  history and are flagged for a composition/orthogonality pass once the
  extension API has broader external consumers.
- `ref`/`instance` kinds still can't be validated structurally by the
  AOT codegen projector (pass-through, non-throwing).

Acceptance criteria for green:
- Kind vocabulary and extension mechanism reviewed and stable enough to
  commit to as a public API (breaking a kind's shape post-1.0 is a major
  version event).
- `TypeRefDocument`/structural-sharing model exercised by every
  ingester and projector that can meaningfully participate (recursive
  types round-trip correctly end to end).
- Kind-grouping cleanup pass completed or explicitly deferred with
  rationale.

---

### Ingestion

**Status: NOT GREEN**

Every `from-*` module converts an external representation into a
`TypeRef`/`TypeRefDocument`.

What exists (`packages/type-ir/src/from-*.ts`):
- `from-json-schema` — JSON Schema → TypeRef
- `from-standard-schema` — any Standard Schema–compliant validator → TypeRef
- `from-openapi` — OpenAPI → TypeRef
- `from-protobuf` — Protobuf → TypeRef
- `from-flatbuffers` — FlatBuffers → TypeRef
- `from-sql` — SQL DDL → TypeRef
- `from-cql` — Cassandra CQL → TypeRef
- `from-capnp` — Cap'n Proto → TypeRef
- `from-elasticsearch` — Elasticsearch mappings → TypeRef
- `from-jtd` — JSON Type Definition → TypeRef
- `from-typescript` — TypeScript source → TypeRef (also used by the
  fractal framework's extractor)
- `from-graphql` — GraphQL SDL → TypeRef
- `from-json` / `from-json-corpus` — inference from sample JSON data or a
  corpus of samples (see "JSON Inference" below — parked, not part of the
  1.0 push)

Covered: every schema/IDL/wire format the project also emits (JSON
Schema, OpenAPI, Protobuf, FlatBuffers, Cap'n Proto, SQL, JTD, GraphQL),
plus TypeScript source and any Standard Schema library.

What's planned / open:
- No ingester yet for the general-purpose target languages beyond
  TypeScript (no `from-python`, `from-rust`, `from-go`, etc.) — ingestion
  is schema/IDL-first; source-language ingestion for the newer emit
  targets has not been started.
- `from-json`/`from-json-corpus` are parked (see "JSON Inference" below).

Acceptance criteria for green:
- Every format fractal emits also has a matching ingester where that
  makes conceptual sense (round-trip coverage), or an explicit
  documented reason it doesn't.
- Ingesters have adversarial/edge-case test coverage comparable to the
  JSON-inference fuzz/adversarial suites already in place for that
  module.

---

### Output: Schema & IDL Formats

**Status: NOT GREEN**

What exists (`packages/type-ir/src/*.ts`):
- JSON Schema — `json-schema.ts` (current draft), `json-schema-07.ts`,
  `json-schema-04.ts`
- OpenAPI — `openapi30.ts`, `openapi20.ts`
- JTD (JSON Type Definition) — `jtd.ts`
- GraphQL — `graphql.ts`
- Protobuf — `protobuf.ts`
- Cap'n Proto — `capnp.ts`
- FlatBuffers — `flatbuffers.ts`
- SQL — `sql.ts`, plus a dialect variant `sql-mssql.ts`

What's planned / open:
- Additional SQL dialects beyond the generic + MSSQL projectors (no
  explicit Postgres/MySQL/SQLite-specific projector at this time —
  unclear whether the generic projector already serves this need or a
  dedicated one is warranted; not yet decided).

Acceptance criteria for green:
- Each format's projector has round-trip tests against its matching
  ingester (where one exists).
- Every format handles fractal's full kind vocabulary with an explicit,
  documented degrade path for kinds it can't express natively (the
  `instance`/`interface`/`stream`/`page` "honest degrade" convention
  already documented in `type-ir/src/index.ts`).

---

### Output: TypeScript Validation Libraries

**Status: NOT GREEN**

What exists (`packages/type-ir/src/*.ts`):
- Zod (`zod.ts`)
- Valibot (`valibot.ts`)
- io-ts (`io-ts.ts`)
- ArkType (`arktype.ts`)
- TypeBox (`typebox.ts`)
- Superstruct (`superstruct.ts`)
- Runtypes (`runtypes.ts`)
- Yup (`yup.ts`)
- Effect Schema (`effect-schema.ts`)

All nine libraries named in the 1.0 scope are implemented, each with a
matching test file.

Acceptance criteria for green:
- Emitted code for each library independently verified against that
  library's actual runtime (not just structural assertions on the
  generated AST/string) for a representative type suite.
- Coverage of each library's own idioms (e.g. Zod's `.refine`,
  discriminated unions, Effect Schema's transformation pipeline) beyond
  the shared TypeRef feature set, where fractal's kind vocabulary maps
  onto them.

---

### Output: General-Purpose Languages

**Status: NOT GREEN**

These are actively in flight — status varies module by module. Current
state, audited directly against `packages/type-ir/src/`:

| Language | Source module | Tests | Published export |
|---|---|---|---|
| TypeScript | `typescript.ts` | yes | yes |
| Python | `python.ts` | yes | yes |
| Go | `go.ts` | yes | yes |
| Rust | `rust.ts` | yes | yes |
| Java | `java.ts` | yes | yes |
| Swift | `swift.ts` | yes | yes |
| Kotlin | `kotlin.ts` | yes | yes |
| PHP | `php.ts` | yes | yes |
| Flow | `flow.ts` | yes | yes |
| Ruby | `ruby.ts` | no | yes |
| C# | `csharp.ts` | no | no |
| C++ | `cpp.ts` | no | no |
| Crystal | `crystal.ts` | no | no |
| Dart | — | — | — |
| Elm | — | — | — |
| Haskell | — | — | — |
| Objective-C | — | — | — |

Reading this table: "no" under Tests/Published export means the module
exists on disk but hasn't cleared the bar this project uses elsewhere
(a test file, and a subpath entry in `package.json`'s `exports` map) — a
deliberate in-progress state, not an oversight. A dash means no module
exists yet.

Acceptance criteria for green:
- Every language in the 1.0 scope list has a source module, a test
  suite, and a published export subpath.
- Ruby, C#, C++, and Crystal specifically need test coverage added
  before they're export-ready.
- Dart, Elm, Haskell, and Objective-C need to be started.
- A decision on whether all sixteen are truly 1.0-blocking, or whether
  a subset ships in 1.0 with the rest following after, is open and
  belongs to the project owner.

---

### Output: Validation Libraries in Other Languages

**Status: NOT GREEN**

Planned, not yet started. No source modules exist for this slice as of
this audit.

Scope under consideration:
- Python — Pydantic
- Rust — serde (with `validator` for refinements)
- Java — Jackson (serialization) / Jakarta Bean Validation (constraints)
- C# — `System.Text.Json` (serialization) / FluentValidation (constraints)
- Swift — `Codable`
- Kotlin — kotlinx.serialization

Acceptance criteria for green:
- At minimum, one validation/serialization library per general-purpose
  language that has reached export-ready status in the previous slice.
- Each follows the same "verify against the real runtime" bar as the
  TypeScript validation library slice.

---

### Standard Schema Integration

**Status: NOT GREEN**

[Standard Schema](https://standardschema.dev/) is a vendor-neutral
interface (`~standard.validate`, and the JSON-Schema-emitting
`~standard.jsonSchema` extension) that Zod, Valibot, ArkType, and others
implement natively.

What exists:
- Ingestion — `from-standard-schema.ts`: any compliant validator →
  `TypeRef`.
- Emission — `standard-schema.ts`: `TypeRef` → a runtime object
  implementing both `StandardSchemaV1` (structural runtime validation by
  interpreting the TypeRef tree directly, not codegen) and
  `StandardJSONSchemaV1` (delegating to the JSON Schema/OpenAPI
  projectors for the spec's named target schemas).
- Fractal boundary validation — `http.validate(schema)` in
  `packages/http-api-projector/src/verbs.ts` attaches any Standard
  Schema validator directly to a route; `runRoute` runs it against the
  decoded input bag before the handler executes, short-circuiting to a
  422 on failure with the validator's own `issues`.

Acceptance criteria for green:
- Round-trip verified: a Standard-Schema-compliant library's schema →
  `TypeRef` → back out as a Standard Schema object → validates
  equivalently to the original for a representative type suite.
- `http.validate()` documented as the recommended boundary-validation
  pattern, with test coverage across success/failure/coercion paths.

---

### JSON Inference

**Status: NOT GREEN — parked, not blocked**

What exists (`packages/type-ir/src/from-json.ts`,
`from-json-corpus.ts`): single-value inference (`fromJson`) and
corpus-level inference (`fromJsonCorpus`, split into an evidence-collection
phase and a configurable resolution phase), full integer-width kind
narrowing, property-based (fast-check) fuzz tests, and adversarial tests
targeting enum-detection heuristics.

This work is intentionally parked rather than actively driven toward
1.0 — it surfaces a set of difficult design decisions (around clustering,
union splitting, and confidence scaling at low sample counts) that need
a dedicated design pass before further building on top of the current
heuristics. This roadmap does not attempt to enumerate those decisions
here; see `TODO.md`'s "Low Priority" section and the module's own tests
for the specifics.

Acceptance criteria for green:
- The parked design decisions revisited and settled (or explicitly
  scoped out of 1.0) by the project owner.

---

### Web Playground

**Status: NOT GREEN — planned**

Not yet started. An interactive, browser-based converter in the spirit
of quicktype.io, but exercising fractal's full format coverage rather
than a fixed subset — paste or upload a schema/type/sample in one format,
pick any of the emit targets above, see the converted output live.

Acceptance criteria for green:
- Deployed, publicly reachable, covering a representative slice of
  ingesters and projectors (not necessarily every single one at launch).
- No server-side execution of untrusted input beyond what's needed to
  run the conversion (fractal itself does not execute generated code).

---

### Documentation Site

**Status: NOT GREEN — planned**

What exists: a VitePress-style `docs/` tree with a landing page
(`docs/index.md`), a guide section (`docs/guide/` — introduction,
concepts, authoring, decode, versioning, codegen CLI), an API reference
stub (`docs/api/index.md`), and an extensive internal design-decision
archive (`docs/design/`).

What's planned:
- A documentation site on par with React's or Vite's docs — comprehensive
  API reference (auto-generated from source where feasible), guided
  onboarding for each ingestion/emission target, and a clear
  type-ir-vs-framework split so newcomers evaluating fractal purely as a
  conversion library aren't forced through framework-specific material.
- Public hosting and a stable URL.

Acceptance criteria for green:
- Every ingester and projector documented with at least one worked
  example.
- Site live at a public URL, navigable without needing to read source.

---

### Testing & Quality

**Status: NOT GREEN**

What exists: per-module unit tests (`*.test.ts` alongside most source
modules), property-based fuzz tests for JSON inference (fast-check),
adversarial test suites for enum-detection heuristics, and a routing
benchmark harness (`packages/http-api-projector/src/route.bench.ts`)
with measured results documented in `docs/design/routing-benchmarks.md`.

What's planned / open:
- Fuzz testing and property-based testing beyond the JSON-inference
  modules — extending the same approach to ingesters/projectors
  generally.
- Cross-format round-trip validation as a first-class, systematic test
  category (format A → TypeRef → format B → TypeRef → compare), rather
  than the current per-module round-trip tests.
- A CI pipeline — none is currently configured (noted as an open thread
  in `TODO.md`: "GitHub repo is live … no CI/CD configured yet").
- Adding target languages to the Nix flake so generated code in each
  emitted language can actually be compiled/type-checked as part of the
  test suite, not just structurally asserted. The current flake
  (`flake.nix`) provides only `nodejs_20` and `bun`.

Acceptance criteria for green:
- CI pipeline running typecheck + test on every push/PR.
- At least the general-purpose-language emit targets have flake-provided
  toolchains and a compile-check step exercising generated output.
- Cross-format round-trip tests exist as a named, discoverable category.

---

### Fractal Framework

**Status: NOT GREEN**

The `api()`/`op()` tree and its projectors — a separate, composable
layer built on top of type-ir.

What exists:
- Core tree model (`packages/api-tree`) — `api`, `op`, `Node`, `Meta`,
  `mergeMeta`, tags lattice, extraction from TypeScript source
  (`extract.ts`), build orchestration (`build.ts`), and a
  `fractal-api-tree` CLI (`build`/`watch`/`stub`/`check`).
- HTTP projector (`packages/http-api-projector`) — verb-helper bundles
  (`http.get/post/put/patch/delete/head/options`), `http.moveTo`,
  `http.source()` (per-param store overrides), `http.validate()`
  (Standard Schema boundary validation — both confirmed present in
  `verbs.ts`), `createFetch`, multiple composable router strategies
  (`radixRouter`, `compiledCharRouter`, `mapCharRouter`), OpenAPI 3.1
  projection (`toOpenApi`, auto-served at `/openapi.json`), a runtime
  typed HTTP client (`createClient`/`TypedClient<N>`), and a
  client-extension system (retry, timeout, interceptors, errors,
  logging, streaming, pagination).
- MCP projector (`packages/mcp-api-projector`) — tools, resources,
  prompts (MCP Tier 1 complete; Tier 2 logging/progress and Tier 3
  sampling/roots/subscriptions open, see `TODO.md`).
- CLI projector (`packages/cli-api-projector`).
- GraphQL projector (`packages/graphql-api-projector`) — server
  (schema/resolve/server), WebSocket subscriptions, and a client with
  typed codegen.
- Auth (`packages/auth-oidc`) — `AuthAdapter`/`AuthClientAdapter`
  contract plus a generic OIDC/JWT package; provider-specific packages
  (Clerk, Auth0, Supabase, Firebase, Cognito) not yet built.

What's planned / open (per `TODO.md`):
- MCP Tier 2 (logging, streaming/progress notifications) and Tier 3
  (sampling, roots, subscriptions) still open.
- `stream` TypeRef kind doesn't propagate through HTTP/CLI/MCP
  projectors (they work from JSON Schema, which loses the distinction) —
  GraphQL alone has it wired.
- CLI and MCP still walk the raw `Node` tree directly rather than
  through the `Node ⇒ ProtocolType` projection pattern HTTP/type-ir use.
- CLI/MCP input-pipeline consolidation onto the shared `assemble()`
  core is unstarted (each still has its own implementation).
- No dedicated declaration for an operation's possible error kinds in
  the tree/meta itself (error mapping is projector-level config today).

Acceptance criteria for green:
- HTTP, MCP, CLI, and GraphQL projectors demonstrated end-to-end against
  a real example app (as `examples/library-api` already does for HTTP).
- MCP Tier 2 complete; Tier 3 either complete or explicitly deferred
  with a documented reason (currently "speculative until concrete use
  case").
- `stream`/`page` kind propagation consistent across all four
  projectors, not just GraphQL.

---

### Developer Experience & Packaging

**Status: NOT GREEN**

What exists:
- A Bun-based monorepo (`package.json` workspaces: `api-tree`,
  `type-ir`, `http-api-projector`, `mcp-api-projector`,
  `cli-api-projector`, `graphql-api-projector`, `auth-oidc`,
  `examples/library-api`).
- A Nix flake (`flake.nix`) providing `nodejs_20` and `bun` for the
  dev shell.
- Per-package `exports` maps in each `package.json` for granular subpath
  imports (e.g. `@rhi-zone/fractal-type-ir/zod`).
- All packages currently at `0.1.0-alpha.0` — none published to npm yet.

What's planned / open:
- npm publishing — no package has been published; versioning strategy
  for the jump to 1.0 across eight interdependent workspace packages is
  undecided.
- Nix flake needs the target-language toolchains added (see "Testing &
  Quality" above) — currently JS/Bun only.
- A contributor guide — none exists yet; `CLAUDE.md` documents the
  project's own design philosophy and constraints but is not written as
  external contributor onboarding.
- Root `tsconfig.json` strictness/consistency audit across packages —
  flagged as still open in `TODO.md`.

Acceptance criteria for green:
- Every package publishable and published to npm at a coordinated 1.0
  version.
- Flake covers the toolchains needed to validate generated output in
  every 1.0-scope target language.
- A contributor guide exists covering monorepo layout, test/typecheck
  commands, and the project's own conventions (open metadata bags,
  subtyping over taxonomy, three-layer separation) at a level a new
  external contributor can act on without reading the full design
  archive.

---

## Beyond 1.0

Stretch goals and directions not required for 1.0, recorded here so they
aren't lost and aren't mistaken for near-term commitments:

- **Additional validation-library targets** beyond the six languages
  named above (e.g. Elixir's Ecto, Go's validator libraries beyond
  serde-adjacent patterns).
- **Provider-specific auth packages** (Clerk, Auth0, Supabase, Firebase,
  Cognito) as thin wrappers over the existing `AuthAdapter` contract —
  explicitly noted in `TODO.md` as suitable for community or
  fractal-maintained follow-on packages, not 1.0-blocking.
- **WebSocket / additional transport kits** beyond GraphQL's existing
  WebSocket subscription support, following the same projection
  pattern as HTTP/MCP/CLI/GraphQL.
- **A canonical reactive/streaming substrate** — live queries and
  reactive client bindings, deferred per `TODO.md`'s "Deferred" section.
- **Production-grade codegen extras** — OpenTelemetry tracing,
  idempotency keys, webhook validation as HTTP client extensions
  (currently listed as remaining nice-to-haves, not required for 1.0).
- **Automatic strategy selection for compiled HTTP routers** — the
  routing benchmark work identified crossover points between router
  strategies but never tuned them into automatic selection constants;
  `createFetch` still requires an explicit opt-in today.
- **SQL dialect breadth** beyond the generic + MSSQL projectors, if
  demand emerges for Postgres/MySQL/SQLite-specific output.
