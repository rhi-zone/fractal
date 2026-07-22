# fractal 1.0 Release Roadmap

## Vision

fractal is a universal type conversion hub: a single type intermediate
representation (type-ir) that ingests type and schema information from
across the software ecosystem — programming language source, schema
languages, IDLs, wire formats, and runtime validation libraries — and
projects it back out to any of them. Where a tool like quicktype turns
sample data into types for a handful of target languages, 1Password's
typeshare shares Rust types out to a smaller set of client languages from
a Rust-first entry point, and a tool like Terraform's providers model
infrastructure state, fractal's job is narrower and deeper: it is the hub
through which type information moves
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
- No `from-json-rpc` yet — parsing JSON-RPC service/method definitions
  (method name, params shape, result shape, error shape) into
  `TypeRef`/`TypeRefDocument`. Not started; mirrors the emission-side gap
  noted in "Output: Schema & IDL Formats" below.

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
- Additional SQL dialects beyond the generic + MSSQL projectors —
  Postgres/MySQL/SQLite-specific output if demand emerges once the
  generic projector's coverage is evaluated against real dialect-specific
  needs (no explicit Postgres/MySQL/SQLite-specific projector at this
  time — unclear whether the generic projector already serves this need
  or a dedicated one is warranted; not yet decided).
- No JSON-RPC method signature emission yet — no `json-rpc.ts` projector
  exists. Mirrors the `from-json-rpc` ingestion gap noted above; scope is
  TypeRef → JSON-RPC method/params/result/error signatures.

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

What exists (`packages/type-ir/src/*.ts`, following the `{language}-{library}`
naming convention — see "Projector naming convention" note in the
General-Purpose Languages slice below):
- Zod (`typescript-zod.ts`)
- Valibot (`typescript-valibot.ts`)
- io-ts (`typescript-io-ts.ts`)
- ArkType (`typescript-arktype.ts`)
- TypeBox (`typescript-typebox.ts`)
- Superstruct (`typescript-superstruct.ts`)
- Runtypes (`typescript-runtypes.ts`)
- Yup (`typescript-yup.ts`)
- Effect Schema (`typescript-effect-schema.ts`)

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

All sixteen general-purpose target languages now have an implemented,
tested projector. Current state, audited directly against
`packages/type-ir/src/` and each package's `package.json` `exports` map:

| Language | Source module | Tests | Test count | Published export |
|---|---|---|---|---|
| TypeScript | `typescript-native.ts` | yes | — | yes |
| Python | `python-dataclass.ts` | yes | 28 | yes |
| Go | `go-encoding-json.ts` | yes | 27 | yes |
| Rust | `rust-serde.ts` | yes | 27 | yes |
| Java | `java-jackson.ts` | yes | 35 | **no** |
| C# | `csharp-systemtextjson.ts` | yes | 19 | yes |
| Swift | `swift-codable.ts` | yes | 24 | yes |
| Kotlin | `kotlin-kotlinx.ts` | yes | 29 | yes |
| Dart | `dart-json-serializable.ts` | yes | 21 | yes |
| Elm | `elm-json.ts` | yes | 24 | yes |
| Haskell | `haskell-aeson.ts` | yes | 41 | yes |
| Ruby | `ruby-sorbet.ts` | yes | 75 | yes |
| C++ | `cpp-nlohmann.ts` | yes | 27 | yes |
| PHP | `php-native.ts` | yes | 31 | yes |
| Crystal | `crystal-json-serializable.ts` | yes | 43 | yes |
| Objective-C | `objc-foundation.ts` | yes | 26 | yes |
| Flow | `flow-native.ts` | yes | 36 | yes |

Test counts are `it(`/`test(` occurrences in each module's `.test.ts`
file, as a rough size signal, not a quality measure. Every module here
has cleared the bar this project uses elsewhere (a test file, and a
subpath entry in `package.json`'s `exports` map) with one exception:
**Java has a full module and 35 tests but no `exports` subpath entry
at all** — not even under an alias — so it isn't currently importable
by consumers as `@rhi-zone/fractal-type-ir/java` or any equivalent path.

Note — projector naming convention: modules now follow a
`{language}-{library}.ts` naming scheme (e.g. `typescript-zod.ts`,
`rust-serde.ts`, `python-dataclass.ts`) instead of a bare language name,
anticipating the "Per-Language Serialization Library Variants" slice
below where a single language will have more than one projector. Each
renamed module keeps a backward-compatible `exports` alias at the old
bare-language path (e.g. `./python` and `./python-dataclass` both
resolve to `python-dataclass.ts`) — confirmed for Python, Go, Rust,
Swift, Kotlin, Dart, Elm, Haskell, Ruby, C++, PHP, Crystal, Objective-C,
and Flow. Java has neither the bare alias nor the qualified path
exported (see above).

Acceptance criteria for green:
- Every language in the 1.0 scope list has a source module, a test
  suite, and a published export subpath — sixteen of sixteen now have
  the first two; Java is the one outstanding gap on the third.
- Java's `exports` entry (bare `./java` and/or `./java-jackson`) needs
  to be added.
- The bare-language `exports` aliases audited for completeness once the
  serialization-library-variants slice lands, since a language with
  multiple libraries can no longer have its bare name mean only one of
  them by default without an explicit decision on which library "wins"
  the unqualified path.
- A decision on whether all sixteen are truly 1.0-blocking, or whether
  a subset ships in 1.0 with the rest following after, is open and
  belongs to the project owner.

---

### Output: Validation Libraries in Other Languages

**Status: NOT GREEN**

Superseded in substance by the "Per-Language Serialization Library
Variants" slice directly below: every language named in the original
scope list here (Python/Pydantic-adjacent, Rust/serde, Java/Jackson,
C#/`System.Text.Json`, Swift/`Codable`, Kotlin/kotlinx.serialization) now
has its first serialization projector implemented as part of the
General-Purpose Languages slice — see that table's "Source module"
column (`python-dataclass.ts`, `rust-serde.ts`, `java-jackson.ts`,
`csharp-systemtextjson.ts`, `swift-codable.ts`, `kotlin-kotlinx.ts`).
This section is kept for history; treat the slice below as the current
source of truth for what remains open (additional libraries per
language, constraint-validation libraries like Jakarta Bean Validation
or FluentValidation layered on top of the serialization projector, etc).

Acceptance criteria for green:
- Folded into the acceptance criteria of "Per-Language Serialization
  Library Variants" below.

---

### Per-Language Serialization Library Variants

**Status: NOT GREEN**

The expansion beyond quicktype-style parity (one library per language):
for each general-purpose target language, support multiple serialization
ecosystems rather than a single fixed one, since real codebases in every
one of these languages routinely standardize on a library other than the
one fractal happens to have implemented first.

What exists today (one projector per language, named for its library
under the `{language}-{library}` convention):
- Python — `dataclasses` (`python-dataclass.ts`)
- Rust — `serde` (`rust-serde.ts`) — serde is the dominant/near-universal
  choice in Rust, so this alone may already satisfy the language's
  practical need
- Java — Jackson (`java-jackson.ts`)
- C# — `System.Text.Json` (`csharp-systemtextjson.ts`)
- Swift — `Codable` (`swift-codable.ts`) — also the dominant/native
  choice in Swift
- Kotlin — kotlinx.serialization (`kotlin-kotlinx.ts`)
- Go — `encoding/json` (`go-encoding-json.ts`)
- Ruby — Sorbet (`ruby-sorbet.ts`); RBS is scoped as a future variant
  below but has **not** been started — no `ruby-rbs.ts` module exists
  as of this audit, despite being an earlier candidate for "already
  covered"
- Dart — `json_serializable` (`dart-json-serializable.ts`)
- PHP — native (`php-native.ts`)
- C++ — nlohmann/json (`cpp-nlohmann.ts`)
- Crystal, Objective-C, Haskell, Elm, Flow — each has exactly one
  projector today (`crystal-json-serializable.ts`, `objc-foundation.ts`,
  `haskell-aeson.ts`, `elm-json.ts`, `flow-native.ts`); no additional
  variants scoped yet for these five

What's planned / open — additional variants per language:

**Completed (2026-07-22):**
- Java — Gson (`java-gson.ts`)
- Python — attrs (`python-attrs.ts`)
- C# — Newtonsoft.Json (`csharp-newtonsoft.ts`)

Remaining variants still planned:
- C++ — RapidJSON, simdjson, Boost.JSON, glaze
- Java — Gson, Moshi, Jakarta JSON-B
- C# — Newtonsoft.Json, ServiceStack.Text
- Python — Pydantic, attrs/cattrs, msgspec
- Kotlin — Jackson, Moshi, Gson
- Swift — SwiftyJSON, ObjectMapper
- Go — easyjson, jsoniter, sonic
- Ruby — RBS, dry-types
- Dart — freezed, built_value
- PHP — Symfony Serializer, JMS Serializer
- Elixir — Ecto (note: Elixir is not currently a 1.0-scope
  general-purpose language target at all — this would need a first
  Elixir projector, not just an additional variant on an existing one;
  scope call on whether Elixir enters the language list belongs to the
  project owner)
- Go — validator libraries beyond the `encoding/json`-adjacent baseline
  (e.g. `go-playground/validator`, `ozzo-validation`) for constraint
  validation on top of the existing `go-encoding-json.ts` serialization
  projector

Acceptance criteria for green:
- At least one additional serialization-library variant implemented and
  tested for each language listed above, beyond the existing default.
- Each new variant follows the same "verify against the real runtime"
  bar as the TypeScript validation library slice, not just structural
  assertions on generated code.
- A decision on whether the bare `{language}` `exports` alias should
  keep pointing at the original/default library once a second variant
  exists, or whether the bare alias should be deprecated in favor of
  always requiring the qualified `{language}-{library}` path — currently
  open, belongs to the project owner (see the note on this in the
  General-Purpose Languages slice above).
- Scope call on which languages' single existing library (Rust/serde,
  Swift/Codable) are exempted as "already the de facto standard" versus
  which need real breadth.

---

### Standard Schema Integration

**Status: NOT GREEN**

[Standard Schema](https://standardschema.dev/) is a vendor-neutral
interface (`~standard.validate`, and the JSON-Schema-emitting
`~standard.jsonSchema` extension) that Zod, Valibot, ArkType, and others
implement natively.

All three pieces of this integration — ingestion, emission (with
runtime validator), and the fractal `http.validate()` boundary directive
— are now implemented.

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

The intended shape of this slice is broader than its current name: a
library for state-of-the-art inference of type structure from limited
sample data, across structured data formats generally — not only JSON.
YAML, KDL, and other structured formats are in scope for the same
inference approach; only the JSON path has been started.

What exists (`packages/type-ir/src/from-json.ts`,
`from-json-corpus.ts`): single-value inference (`fromJson`) and
corpus-level inference (`fromJsonCorpus`, split into an evidence-collection
phase and a configurable resolution phase), full integer-width kind
narrowing, property-based (fast-check) fuzz tests, and adversarial tests
targeting enum-detection heuristics. This is JSON-only; no YAML, KDL, or
other format has an inference path yet.

This work is intentionally parked rather than actively driven toward
1.0 — it surfaces a set of difficult design decisions (around clustering,
union splitting, and confidence scaling at low sample counts) that need
a dedicated design pass before further building on top of the current
heuristics, and needs substantial further work even within JSON alone
before the broader multi-format library shape is worth starting. This
roadmap does not attempt to enumerate those decisions here; see
`TODO.md`'s "Low Priority" section and the module's own tests for the
specifics.

Acceptance criteria for green:
- The parked design decisions revisited and settled (or explicitly
  scoped out of 1.0) by the project owner.
- A decision on whether multi-format inference (YAML, KDL, etc.) is
  1.0-scope, a post-1.0 direction, or a separate package entirely —
  currently open, belongs to the project owner.

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

### Documentation Generation

**Status: NOT GREEN — planned**

Not yet started. Auto-generated API documentation, distinct from the
"Documentation Site" slice above (which covers fractal's *own* docs) —
this slice is about projectors emitting documentation *for the types and
operations fractal converts*, in each target language's native doc
comment format, so that ecosystem-standard doc site generators can
consume it.

The approach: descriptions, examples, and other documentation-shaped
metadata already live in TypeRef's open `meta` bag. Each projector would
emit that metadata as the target language's native doc comment
convention alongside the type/operation definitions it already
generates (e.g. `/** ... */` JSDoc-style for TypeScript, `///` for Rust,
docstrings for Python, XML doc comments for C#, etc.) — no new ingestion
or IR work, just an additional emission concern per projector. The doc
site generators themselves are downstream consumers of that output, not
something fractal builds.

Doc site generators to target, by language ecosystem:
- JS/TS — TypeDoc, JSDoc, Docusaurus, VitePress, Starlight
- Python — Sphinx (autodoc), MkDocs (mkdocstrings), pdoc
- Rust — rustdoc
- Java — Javadoc
- Go — godoc / pkg.go.dev
- C# — DocFX, XML doc comments
- Ruby — YARD, RDoc
- Swift — DocC (Apple's)
- Kotlin — Dokka (KDoc)
- Haskell — Haddock
- C++ — Doxygen
- PHP — phpDocumentor
- Dart — dartdoc
- Elm — elm-doc-preview
- Cross-language — Material for MkDocs (squidfunk), Zensical
  (squidfunk's newer Rust-based doc generator)

What's planned / open:
- Everything — no projector currently emits native doc comments from
  `meta` bag content; this is a net-new emission concern across all
  general-purpose-language projectors (see "Output: General-Purpose
  Languages" above) plus the TypeScript validation-library and
  schema/IDL projectors where doc comments are idiomatic.
- A decision on scope: whether every projector needs doc-comment
  emission for 1.0, or a representative subset (e.g. the languages with
  the most-used doc site generators — TypeDoc, Sphinx, rustdoc, Javadoc)
  ships first — open, belongs to the project owner.
- No investigation yet into which `meta` bag fields map to which doc
  comment conventions (e.g. `@param`/`@returns`-style tags vs. Rust's
  freeform `///` prose vs. Python docstring conventions like
  Google/NumPy/Sphinx style) — this needs a design pass before
  implementation starts.

Acceptance criteria for green:
- Doc comment emission implemented for every general-purpose-language
  projector in 1.0 scope (or an explicit, documented subset decision by
  the project owner).
- At least one representative doc site generator per major ecosystem
  (TypeDoc for JS/TS, Sphinx or MkDocs for Python, rustdoc for Rust,
  Javadoc for Java) verified to successfully build a docs site from
  fractal-generated output.
- `meta`-bag-to-doc-comment field mapping documented as a stable
  convention other projector authors can follow.

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

**Battle testing** — every projector and ingester currently has unit-test
coverage, but none has been exercised against real-world corpora at
scale. This is a distinct, larger category of open work, not yet
started:
- Round-trip testing against real schemas: ingest → project → ingest,
  verifying the second ingest is equivalent to the first, rather than
  the current practice of hand-written fixtures per module.
- Real-world schema corpora as test input — OpenAPI specs from
  APIs.guru, JSON Schemas from SchemaStore, `.proto` files from
  googleapis, and equivalents for the other ingested formats (SQL DDL,
  CQL, Cap'n Proto, FlatBuffers, GraphQL SDL).
- Fuzz testing specifically targeted at the text/binary parsers
  (protobuf, Cap'n Proto, FlatBuffers, SQL, CQL) as a category distinct
  from the property-based fuzzing already in place for JSON inference —
  these are hand-written parsers, not heuristic inference, and need
  malformed-input robustness testing.
- Cross-language compilation testing: generated Go actually compiles
  with `go build`, generated Rust with `cargo build`, etc. — this is the
  concrete, testable form of "adding target languages to the Nix flake"
  above; the flake work is the prerequisite, this is the test suite that
  uses it.

Acceptance criteria for green:
- CI pipeline running typecheck + test on every push/PR.
- At least the general-purpose-language emit targets have flake-provided
  toolchains and a compile-check step exercising generated output.
- Cross-format round-trip tests exist as a named, discoverable category.
- Battle-testing suite in place: real-world corpora wired into round-trip
  tests, parser fuzz tests running, and cross-language compilation
  checks passing for every general-purpose-language target with a
  flake-provided toolchain.

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
  `http.source()` (per-param store overrides — a type-safe `sourceMap`
  built via declaration-merging into a store registry, so a param's
  origin — query, body, path, header — is checked at the type level
  rather than a bare string union), `http.validate()` (Standard Schema
  boundary validation: attaches any Standard-Schema-compliant validator
  to a route, `runRoute` runs it against the decoded input bag before
  the handler executes and short-circuits to a 422 with the validator's
  own `issues` on failure — both directives confirmed present in
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
- A JSON-RPC projector — no `packages/json-rpc-api-projector` (or
  equivalent) exists yet. Would follow the same `api()`/`op()` tree
  projection pattern as the HTTP/CLI/MCP/GraphQL projectors, surfacing
  operations as JSON-RPC methods (request/response/error framing per the
  JSON-RPC 2.0 spec). Not started.
- Provider-specific auth packages (Clerk, Auth0, Supabase, Firebase,
  Cognito) as thin wrappers over the existing `AuthAdapter`/
  `AuthClientAdapter` contract — none built yet; the generic OIDC/JWT
  package is the only implementation today.
- WebSocket / additional transport kits beyond GraphQL's existing
  WebSocket subscription support, following the same projection pattern
  as HTTP/MCP/CLI/GraphQL — not started for HTTP/MCP/CLI.
- A canonical reactive/streaming substrate — live queries and reactive
  client bindings on top of the existing `stream`/`page` kinds and
  GraphQL subscriptions. Not started.
- Production-grade codegen extras as HTTP client extensions —
  OpenTelemetry tracing, idempotency keys, webhook validation. Not
  started; the client-extension system (retry, timeout, interceptors,
  errors, logging, streaming, pagination) is the mechanism these would
  extend.
- Automatic strategy selection for compiled HTTP routers — the routing
  benchmark work (`docs/design/routing-benchmarks.md`) identified
  crossover points between `radixRouter`/`compiledCharRouter`/
  `mapCharRouter` but never tuned them into automatic selection
  constants; `createFetch` still requires an explicit opt-in today.

Acceptance criteria for green:
- HTTP, MCP, CLI, GraphQL, and JSON-RPC projectors demonstrated
  end-to-end against a real example app (as `examples/library-api`
  already does for HTTP).
- MCP Tier 2 complete; Tier 3 either complete or explicitly deferred
  with a documented reason (currently "speculative until concrete use
  case").
- `stream`/`page` kind propagation consistent across all projectors, not
  just GraphQL.
- JSON-RPC projector implemented and tested to the same bar as the
  existing four (HTTP, CLI, MCP, GraphQL).
- Scope call from the project owner on which of the auth
  packages/transport kits/reactive substrate/codegen extras/router
  auto-selection items above are genuinely 1.0-blocking versus
  reasonable to ship incrementally after — all are now listed as open
  1.0 items rather than deferred "beyond 1.0" stretch goals, but relative
  priority among them is still open.

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
- **Codegen quality — Arborium evaluation.** Every projector currently
  builds output via string concatenation/template literals rather than
  an AST. `@arborium/javascript` (by Amos Wenger / fasterthanlime) has
  been raised as a candidate for generating code through an actual AST
  instead, to improve correctness of generated output — indentation,
  string/identifier escaping, and comment placement are all currently
  the projector author's manual responsibility per-language. Not yet
  evaluated: whether Arborium's model (JavaScript-shaped, per its
  package name) generalizes usefully across fractal's sixteen
  general-purpose-language targets, or whether it's JS/TS-projector-only
  in scope. No spike has been done.
- **Competitive landscape.** quicktype (sample-data-driven, broad
  language coverage, narrower per-language depth) and 1Password's
  typeshare (Rust-first entry point, narrower target-language set) are
  both noted as comparison points with overlapping output targets to
  fractal's, despite different entry points (format-agnostic ingestion
  for fractal vs. a single source language for typeshare). No structured
  comparison has been written up yet.

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
