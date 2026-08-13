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
_between_ representations that were never designed to talk to each other
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

- **General-purpose source-language ingestion beyond TypeScript
  (no `from-python`, `from-rust`, `from-go`, etc.) — decided out of
  scope for fractal itself, deferred indefinitely (2026-07-25).** Not a
  gap awaiting work; a scope decision. A session-long investigation
  found no viable general path fractal should own directly: native
  per-language parsers (WASM or prebuilt binaries) exist for some
  languages (Rust via `syn`, Python via `ruff_python_parser`) but many
  have no lightweight option (JVM/CLR-hosted Java/C#/Kotlin, PHP's
  self-hosted parser, immature/absent wasm story for Haskell/Elm/
  Crystal, no parser lighter than clang for C++/Objective-C); SCIP was
  ruled out against its actual proto spec (symbol occurrences/hover
  text only, no structured field/enum/generic data, and requires the
  target project to fully build); LSP was inferred to share SCIP's
  structural-fidelity ceiling with heavier operational cost. This
  problem — turning a tree-sitter CST into structured type data across
  many languages — is being left to sibling project
  **rhi-zone/normalize** (https://github.com/rhi-zone/normalize), which
  already builds AST-based structural analysis across 98+ languages via
  tree-sitter. Fractal will consume normalize's semantic layer as an
  ingestion source once/if it matures there, rather than duplicating
  the effort. **Exception**: parsers already published on npm as
  ready-to-use WASM/JS packages (e.g. `flow-parser` for Flow) remain
  fair game to adopt opportunistically — near-zero integration effort,
  no need to wait for normalize. Full rationale and effort-tier notes:
  `TODO.md`, "Decisions (2026-07-25)".
- `from-json`/`from-json-corpus` are parked (see "JSON Inference" below).
- No `from-json-rpc` yet — parsing JSON-RPC service/method definitions
  (method name, params shape, result shape, error shape) into
  `TypeRef`/`TypeRefDocument`. Not started; mirrors the emission-side gap
  noted in "Output: Schema & IDL Formats" below.

Acceptance criteria for green:

- Every format fractal emits also has a matching ingester where that
  makes conceptual sense (round-trip coverage), or an explicit
  documented reason it doesn't — general-purpose source-language
  ingestion satisfies this via the deferral decision above, not by
  being built.
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

All seventeen general-purpose target languages now have an implemented,
tested projector — Elixir (`elixir-jason.ts`) joined the list on
2026-07-25, the first Elixir projector in this package (previously
scoped as "not currently a 1.0-scope language" pending an owner
decision — see "Per-Language Serialization Library Variants" below for
that decision's history; the owner has now approved Elixir entering the
list). Current state, audited directly against
`packages/type-ir/src/` and each package's `package.json` `exports` map:

| Language    | Source module                  | Tests | Test count | Published export |
| ----------- | ------------------------------ | ----- | ---------- | ---------------- |
| TypeScript  | `typescript-native.ts`         | yes   | —          | yes              |
| Python      | `python-dataclass.ts`          | yes   | 28         | yes              |
| Go          | `go-encoding-json.ts`          | yes   | 27         | yes              |
| Rust        | `rust-serde.ts`                | yes   | 27         | yes              |
| Java        | `java-jackson.ts`              | yes   | 35         | yes              |
| C#          | `csharp-systemtextjson.ts`     | yes   | 19         | yes              |
| Swift       | `swift-codable.ts`             | yes   | 24         | yes              |
| Kotlin      | `kotlin-kotlinx.ts`            | yes   | 29         | yes              |
| Dart        | `dart-json-serializable.ts`    | yes   | 21         | yes              |
| Elm         | `elm-json.ts`                  | yes   | 24         | yes              |
| Haskell     | `haskell-aeson.ts`             | yes   | 41         | yes              |
| Ruby        | `ruby-sorbet.ts`               | yes   | 75         | yes              |
| C++         | `cpp-nlohmann.ts`              | yes   | 27         | yes              |
| PHP         | `php-native.ts`                | yes   | 31         | yes              |
| Crystal     | `crystal-json-serializable.ts` | yes   | 43         | yes              |
| Objective-C | `objc-foundation.ts`           | yes   | 26         | yes              |
| Flow        | `flow-native.ts`               | yes   | 36         | yes              |
| Elixir      | `elixir-jason.ts`              | yes   | 42         | yes              |

Test counts are `it(`/`test(` occurrences in each module's `.test.ts`
file, as a rough size signal, not a quality measure. Every module here
has cleared the bar this project uses elsewhere (a test file, and a
subpath entry in `package.json`'s `exports` map).

Note — projector naming convention: modules now follow a
`{language}-{library}.ts` naming scheme (e.g. `typescript-zod.ts`,
`rust-serde.ts`, `python-dataclass.ts`) instead of a bare language name.
Decided (2026-07-25): a bare `./{language}` `exports` alias is kept
**only** for languages with exactly one serialization-library
projector, where it is unambiguous — Rust (`serde`), Haskell (`aeson`),
Elm (`elm-json`), Crystal (`json_serializable`), Objective-C
(`Foundation`), Flow (native), Elixir (`jason`), and TypeScript
(source-ingestion native). For every language with more than one
variant — C++, C#,
Dart, Go, Java, Kotlin, PHP, Python, Ruby, Swift — the bare alias has
been removed; consumers must import the explicit
`./{language}-{library}` path (e.g. `./java-jackson`, `./python-dataclass`).
No unqualified path silently "wins" for a multi-variant language.

Acceptance criteria for green:

- Every language in the 1.0 scope list has a source module, a test
  suite, and a published export subpath — all seventeen of seventeen
  now complete (Java's `exports` entry was added in a prior session;
  Elixir added 2026-07-25).
- Bare-language `exports` aliases removed for every language with more
  than one serialization-library variant — done (2026-07-25); see the
  "Per-Language Serialization Library Variants" slice below for the
  bare-alias decision itself.
- A decision on whether all seventeen are truly 1.0-blocking, or
  whether a subset ships in 1.0 with the rest following after, is open
  and belongs to the project owner.

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
- Crystal, Objective-C, Haskell, Elm, Flow, Elixir — each has exactly
  one projector today (`crystal-json-serializable.ts`,
  `objc-foundation.ts`, `haskell-aeson.ts`, `elm-json.ts`,
  `flow-native.ts`, `elixir-jason.ts`); no additional variants scoped
  yet for these six

What's planned / open — additional variants per language:

**Completed (2026-07-22) — Battle-tested and union-root capable:**

- Java — Gson (`java-gson.ts`) — 35 tests
- Python — attrs (`python-attrs.ts`) — 32 tests
- C# — Newtonsoft.Json (`csharp-newtonsoft.ts`) — 32 tests

All three verified against cross-projector smoke test suite (171 tests, 4 fixture schemas). Struct-only projector union handling fixed; all three now handle union-rooted schemas.

**Completed (2026-07-22, earlier pass):**

- Java — Moshi (`java-moshi.ts`)
- Dart — freezed (`dart-freezed.ts`)

**Completed (2026-07-22, this session):**

- Kotlin — Jackson (`kotlin-jackson.ts`) — `@JsonProperty`, `@JsonTypeInfo`/`@JsonSubTypes` for unions
- Go — easyjson (`go-easyjson.ts`) — `//easyjson:json` directives, `json.RawMessage` unions, 29 tests
- Ruby — dry-types (`ruby-dry-types.ts`) — `Dry::Struct` classes with `Types::*` constructors

Remaining variants still planned:

- C++ — RapidJSON, simdjson, Boost.JSON, glaze
- Java — Jakarta JSON-B
- C# — ServiceStack.Text
- Python — Pydantic, attrs/cattrs, msgspec
- Kotlin — Gson
- Swift — SwiftyJSON, ObjectMapper
- Go — jsoniter, sonic
- Ruby — RBS
- Dart — built_value
- PHP — Symfony Serializer, JMS Serializer
- Elixir — Ecto (note: as of 2026-07-25 Elixir now has its first
  projector, `elixir-jason.ts`, plain `defstruct`/typespec structs with
  Jason for JSON, matching every other language's default-library
  convention — see the General-Purpose Languages slice above. An
  `Ecto.Schema`-backed variant, analogous to a hypothetical Django-models
  Python variant, is a genuinely separate additional-variant scope item,
  not a blocker for Elixir's default projector)
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
- Decided (2026-07-25): the bare `{language}` `exports` alias is
  removed once a language has more than one serialization-library
  variant — no default library "wins" the unqualified path. Consumers
  of a multi-variant language always import the qualified
  `{language}-{library}` path. Closed for C++, C#, Dart, Go, Java,
  Kotlin, PHP, Python, Ruby, Swift (see the note on this in the
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

Since the "parked" call above, an evaluation harness (`inference-eval.ts`)
was built and used to drive further work on the hardest open design
question — union splitting: a CFD-style discriminant-discovery pass
(`tryDetectCfdDiscriminant`, Tagger-paper-style unary constant conditional
functional dependency search over all scalar sibling fields, not just
already-enum-typed ones) and three clustering strategies for the
discriminant-free case (`clusteringMethod`: `single-linkage` (default,
back-compat), `complete-linkage`, `key-signature`) now exist in
`from-json-corpus.ts`. Measured against the harness on targeted synthetic
corpora, no single clustering strategy dominates across corpus shapes
(each wins on a different constructed scenario — chaining vs.
near-identical polymorphic shapes), so all three ship as a caller-facing
option rather than a fixed default; picking one default (or keeping the
choice) needs further generated-distribution analytics, not yet done.
This is incremental progress within JSON, not a resolution of the parked
status below — clustering-default selection and confidence scaling at low
sample counts remain open design questions.

This work is intentionally parked rather than actively driven toward
1.0 — it surfaces a set of difficult design decisions (around clustering,
union splitting, and confidence scaling at low sample counts) that need
a dedicated design pass before further building on top of the current
heuristics, and needs substantial further work even within JSON alone
before the broader multi-format library shape is worth starting. This
roadmap does not attempt to enumerate those decisions here; see
`TODO.md`'s "Low Priority" section and the module's own tests for the
specifics.

**The dedicated design pass now exists**: `docs/design/json-inference-model.md`
(2026-07-25) proposes replacing the pass-ordering cascade with a single
model-comparison primitive (Bayesian/MDL, argued to be the same procedure
in two notations) scored consistently across all hypotheses at a tree
position, checks it against the four concrete failure modes the eval
harness surfaced this session, and resolves the P0 decisions blocking
further work: current heuristic behavior is not treated as a contract
(correctness over behavior preservation), a confidence surface (chosen
hypothesis/runner-up/margin) ships additively on `meta`, `clusteringMethod`'s
fate is deferred to the P4 phase that would subsume it, small-N corpora
resolve to the coarser hypothesis rather than abstaining, and Bayesian
vocabulary is preferred for user-facing surfaces (MDL internally). A
phased plan (P1 cost calculus through P6 flipping the default) is ready
to start whenever picked up — see the design doc for phase-by-phase
acceptance gates against the realistic-corpora harness baselines.

Acceptance criteria for green:

- The phased plan in `docs/design/json-inference-model.md` (P1–P6)
  executed and landed, or explicitly re-scoped by the project owner.
- A decision on whether multi-format inference (YAML, KDL, etc.) is
  1.0-scope, a post-1.0 direction, or a separate package entirely —
  currently open, belongs to the project owner.

---

### Web Playground

**Status: NOT GREEN — basic version implemented (2026-07-22)**

`packages/playground/` (Vite + Solid + CodeMirror 6) — an interactive,
browser-based converter in the spirit of quicktype.io. Paste/edit a
schema/type/sample in one of 13 browser-safe input formats, pick any of
45 output formats, see the converted output live. All 585 input×output
combinations verified working.

A Postman-like interactive-playground mode (use case 1 in
`docs/design/mocked-fetch-backend.md`) is scoped, not yet built. The
doc's other use case — a live, in-page request/response demo embedded
INSIDE generated documentation (use case 2) — **is now built (2026-08-13)**:
`packages/http-api-projector/src/http-route-reference.ts`
(`toDocusaurusRouteReference`/`toStarlightRouteReference`) projects an
`OpenApiDoc` to one MDX page per route, each embedding a
`<ApiExplorer/>` tag; `packages/api-explorer/` ships that component
(a real companion React package, following the same "projector emits a
bare component reference, the consuming site wires the runtime" shape
`docusaurus-reference.ts`'s `<TypeRef>` already established) plus an
`ApiExplorerFetchProvider` context a site wires once, site-wide, to a
real `toDropInFetch(createFetch(tree))` instance (or the ambient global
`fetch` by default). MkDocs was excluded per the doc's own verified
finding (no MDX/component-import mechanism). See that file's and
`packages/api-explorer/src/*.tsx`'s doc comments, and
`docs/design/mocked-fetch-backend.md`'s "resolved" section, for the full
design. A related but architecturally distinct fabricated-data (not
real-handler) capability for the playground, plus runnable doc snippets,
is scoped separately in `docs/design/relational-mock-data-generator.md`.

What's left:

- Not yet deployed to a public URL — runs locally today.
- 13 input formats is a subset of the full ingester list (browser-safe
  only — formats requiring Node-only parsing are excluded); could grow
  as ingesters are audited for browser-safety.

Acceptance criteria for green:

- Deployed, publicly reachable, covering a representative slice of
  ingesters and projectors (not necessarily every single one at launch)
  — **coverage done, deployment still open**.
- No server-side execution of untrusted input beyond what's needed to
  run the conversion (fractal itself does not execute generated code)
  — satisfied; conversion runs client-side in the browser.

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

**Status: PARTIALLY COMPLETE (2026-08-12)**

Code-level doc comment emission complete; six site-level doc projectors are
now implemented (Docusaurus, Starlight, MkDocs (vanilla), Material for
MkDocs, Sphinx, plus a generator-agnostic plain Markdown target added
2026-08-13 — see "Plain Markdown (generator-agnostic) target, added
(2026-08-13)" below). MkDocs and Material for MkDocs were previously
conflated under one file (`mkdocs-reference.ts`, which turned out to
already be Material-flavored despite its name); they are now two
genuinely separate built targets — see "MkDocs vs. Material for MkDocs
target-identity ambiguity, resolved (2026-08-13)" below.

**Completed (2026-07-22)**: Doc comment emission across all 25 projectors.
Every projector now emits native doc comments from `meta.description` and
`meta.deprecated` in its target language's native format: JSDoc-style
`/** ... */` for TypeScript, `///` for Rust, docstrings for Python, XML
doc comments for C#, etc. No new ingestion or IR work — metadata already
lives in TypeRef's open `meta` bag; this was a pure emission concern.

**Completed (2026-07-22, second pass)**: Site-level doc projectors —
`docusaurus-reference.ts`, `starlight-reference.ts`,
`mkdocs-reference.ts` — projecting TypeRef schemas into MDX/Markdown for
their respective doc-site frameworks, with hover info and cross-linking
between types (see acceptance criteria below for details).

**Completed (2026-08-12)**: `sphinx-reference.ts` — the #1-ranked
not-yet-built target per the popularity research below. First projector
built against this section's basics bars (A/B/D, C explicitly out of
scope — see "Candidate basics bars" below), and the first of the four
site-level doc projectors overall to clear bar B and get a real (ad hoc,
not CI-gated) bar-D visual check. Status against the bars:

- **(A) Structural smoke test** — clears via `registry.test.ts`'s
  generic loop (same as the other three built targets) plus RST-specific
  structural assertions in `sphinx-reference.test.ts` (title-underline
  length matching, well-formed `.. list-table::` blocks) that the
  generic loop can't check and the other three targets' Markdown/MDX
  output doesn't need.
- **(B) Dedicated fixture + reviewed output** — `sphinx-reference.test.ts`
  has its own fixture (a small GitHub-API-flavored `Repository`/`Owner`/
  `Visibility`/`WebhookEvent`/`IssueTracker` document exercising nested
  objects, an enum, a deprecated field, a discriminated union with both
  `ref` and inline-object variants, an interface method, and a
  documented example) plus hand-reviewed explicit-string assertions per
  section kind (this codebase doesn't use snapshot testing anywhere
  under `packages/type-ir/src`, so this follows the same
  explicit-assertion convention as `compile-check.test.ts` and sibling
  `*.test.ts` files rather than introducing one). Bar B is not yet
  retrofitted onto Docusaurus/Starlight/MkDocs — they still only clear
  what "What the three built targets currently clear" below describes.
- **(D) Verified correct, not just accepted** — see the dedicated note
  below; done as one-time, ad hoc, local verification only, per the
  bar-C-is-out-of-scope framing.

**The D-presupposes-C tension, encountered and resolved for this first
target (read before the next target goes through this same process)**:
bar D's own text ("Beyond the real tool accepting the output, a human ...
confirms the rendered result actually looks right") presupposes bar C
(verified against the real tool) already passed — but C is explicitly
out of scope for this initiative, redirected to a separate heavier
pre-release/RC workflow. The resolution used here: bar D's _intent_ (a
human actually looked at rendered output and confirmed it isn't broken)
was satisfied without adopting C's _scope_ (an automated, CI-gated,
always-required `sphinx-build` step) by running the real `sphinx-build`
tool locally, once, ad hoc, purely to render this target's dedicated
fixture to HTML for direct visual review — not committed as a CI gate,
not added as a required test assertion that shells out to `sphinx-build`,
and not left as a persisted script or fixture under `packages/type-ir/src`
(nixpkgs' `python3Packages.sphinx` was added to `flake.nix`'s Python
toolchain for this purpose only, following the same precedent as the
pydantic/attrs entry already there for `compile-check.test.ts`). **This
is a judgment call bridging an ambiguity in this doc's own bar
definitions, not a decision belonging to whoever implements the next
target by default — the project owner should confirm or correct this
reading before it becomes the unstated precedent every subsequent target
follows.**

What the ad hoc bar-D check actually found and fixed (recorded here
because it demonstrates _why_ D's real-tool step earns its cost even
when scoped down to one-time/local rather than C's full CI-gated form —
none of these three defects were structurally invalid RST, so bar A's
smoke test could not have caught any of them; only feeding the output to
a real `sphinx-build` did):

1. `.. deprecated:: <reason>` — the directive's own argument grammar
   (`sphinx.domains.changeset.VersionChange`, `optional_arguments = 1`,
   `final_argument_whitespace = True`) silently splits a multi-word
   single-line argument into a bogus "version" (first word) plus a
   truncated inline explanation, garbling any deprecation reason longer
   than one word. Fixed by moving the reason to the directive's
   _body_ (an indented paragraph) with a fixed, explicitly-non-data
   `N/A` placeholder standing in for the version slot the directive
   requires but this projector has no real data for.
2. A cross-linked method signature's `.. list-table::` cell wrapped the
   _entire_ signature — including an embedded `:ref:` role — in a
   ` ` ``-delimited literal span; docutils does not parse inline markup
   inside a literal span, so the role rendered as dead literal text
   instead of a working hyperlink. Fixed by leaving the signature cell
   unwrapped (matching how the Fields table's type cell already worked).
3. A cross-linked `ref`-typed array field (`X[]` shorthand) placed the
   `:ref:` role's closing backtick directly against `[`; docutils
   requires whitespace or a fixed closing-punctuation set immediately
   after an inline-markup end-string, and `[` (an opening bracket) isn't
   in that set, producing a real docutils warning. Fixed with docutils'
   documented adjacent-inline-markup escape (`\ `, an escaped space that
   renders invisibly but satisfies the boundary rule).

All three are fixed in the committed `sphinx-reference.ts`, re-verified
against a fresh `sphinx-build -W` (warnings-as-errors) run after each
fix, and covered by dedicated assertions in `sphinx-reference.test.ts`.
The scratch Sphinx project used for the visual check (minimal `conf.py`

- the dedicated fixture's five generated `.rst` pages) was not committed,
  per the instruction not to persist bar-C-shaped tooling into the repo.

**MkDocs vs. Material for MkDocs target-identity ambiguity, resolved
(2026-08-13).** The ranked list below treats "MkDocs" (#2) and "Material
for MkDocs" (#3) as two separate targets, but the single `mkdocs-
reference.ts` built on 2026-07-22 turned out to already be Material-
flavored — its own header comment named Material's `pymdownx` extension
set (admonitions, content tabs) as what it targets, not vanilla MkDocs,
despite the file/function names saying plain "MkDocs". Project owner's
call: support both, as genuinely separate targets, rather than picking
one. Resolved by:

- Adding `mkdocs-vanilla-reference.ts` (`toMkdocsVanillaReference`) as a
  new, independent projector for plain MkDocs — CommonMark plus only
  what MkDocs enables by default (`toc`, `tables`, `fenced_code_blocks`,
  native `---` frontmatter), with none of Material's `pymdownx` syntax.
  Self-contained (its own copies of `kebabCase`/`renderTypeExpr`/etc.,
  not importing from `mkdocs-reference.ts`), matching the convention
  `sphinx-reference.ts` already established for keeping doc-projector
  targets decoupled from each other.
- Renaming the existing `mkdocs-reference.ts` file's _identity_ (not its
  filename/export name, to avoid a breaking rename) to "Material for
  MkDocs" in every doc/comment that describes it, and closing the
  feature-surface gap the ambiguity had left implicit: a real
  `toMkdocsYaml()` emitting `mkdocs.yml` (theme features, palette
  toggle, the `markdown_extensions` every syntax feature below actually
  needs, an auto-generated `nav:`, and an optional `social` plugin
  entry), a Type-Signature content tab showing both the TypeScript-like
  expression and the def's real JSON Schema side by side (icon-prefixed
  tab labels), Material grid-cards (`<div class="grid cards" markdown>`)
  for a new "## Related Types" section, and icon-prefixed content tabs
  for multiple `meta.examples`. Every icon shortcode used
  (`:material-language-typescript:`, `:material-code-json:`,
  `:material-file-code-outline:`, `:material-cube-outline:`) was checked
  against Material's actual bundled icon set
  (`squidfunk/mkdocs-material`'s `.icons/material/*.svg` files), not
  assumed to exist; every `mkdocs.yml` config block was reproduced from
  Material's own "Setup" reference pages (grids, content tabs, icons/
  emojis, social cards, navigation, changing the colors), fetched and
  read directly rather than recalled from memory.
- Both targets' generated output (pages +, for Material, the emitted
  `mkdocs.yml`) were verified against real `mkdocs build --strict` runs
  — `mkdocs` alone for the vanilla target, `mkdocs` + `mkdocs-material`
  for the Material target — both installed via `flake.nix` (same
  ad hoc/local, not-CI-gated precedent `sphinx-reference.ts` set for bar
  D; `mkdocs`/`mkdocs-material` added to the same `python3.withPackages`
  entry the `sphinx` package already lives in). The Material build was
  additionally spot-checked in the rendered HTML output: content tabs
  render as real `tabbed-set` markup, icon shortcodes resolve to actual
  `twemoji` SVGs (zero raw `:material-...:` shortcode text left
  unresolved), grid cards render with the `grid cards` class, the
  deprecation admonition renders with the `admonition warning` class,
  and abbreviations render as real `<abbr title="...">` tooltips — not
  just "the build didn't fail," but each new feature's actual rendered
  shape confirmed.
- Both targets are registered in `registry.ts` (`mkdocs-reference` and
  `mkdocs-vanilla-reference`) and have their own `packages/type-ir/`
  subpath exports, same convention as every other target.

**Completed (2026-08-13)**: `mkdocs-vanilla-reference.ts` (plain MkDocs)
built as a new target, and `mkdocs-reference.ts` (Material for MkDocs)
extended with the feature surface above — see the resolution note
immediately above for the full breakdown. Both now clear the same bars
`sphinx-reference.ts` cleared first:

- **(A) Structural smoke test** — both clear via `registry.test.ts`'s
  generic loop plus their own dedicated structural assertions (frontmatter
  well-formedness, trailing-newline discipline, and — specific to the
  vanilla target — assertions that no `!!!`/`=== "`/`*[...]:` Material
  syntax leaks in anywhere across its whole fixture's output).
- **(B) Dedicated fixture + reviewed output** — `mkdocs-vanilla-
reference.test.ts` has its own blog/CMS-flavored fixture (`Post`/
  `Author`/`Status`/`CommentEvent`/`Moderator`, distinct from Sphinx's
  GitHub-flavored one and Material's e-commerce-flavored one below) and
  `mkdocs-reference.test.ts` has its own e-commerce-flavored fixture
  (`Product`/`Category`/`Availability`/`OrderEvent`/`InventoryManager`,
  the latter with 2 documented examples to exercise the tabbed Examples
  section) — both with hand-reviewed explicit-string assertions per
  section kind, same convention as `sphinx-reference.test.ts`.
- **(D) Verified correct, not just accepted** — see the resolution note
  above for the real-`mkdocs build --strict` + rendered-HTML spot-check
  detail.

Docusaurus and Starlight are not yet retrofitted to these bars — they
still only clear what "What the three built targets currently clear"
below describes (that description now predates Sphinx and both MkDocs
targets, all three of which have since moved past it).

**Plain Markdown (generator-agnostic) target, added (2026-08-13)**:
`markdown-reference.ts` (`toMarkdownReference`) — a new target distinct in
kind from the five above, not just another entry in the same family. Every
other target on this page is built for one specific consuming tool
(a doc-site generator) and leans on that tool's own syntax extensions;
this one has no consuming tool at all — output is plain CommonMark plus
only the GFM table extension, meant to render correctly wherever a
generic CommonMark/GFM renderer is used (a repository file viewer, a
Markdown previewer, a static site with no special Markdown config), never
assuming any admonition/content-tab/frontmatter convention a specific tool
would need to opt into. See docs/reference/type-ir/doc-projectors.md's
"Plain Markdown (generator-agnostic)" section for the full syntax
breakdown. Status against the same bars the other three retrofitted
targets clear:

- **(A) Structural smoke test** — clears via `registry.test.ts`'s generic
  loop plus `markdown-reference.test.ts`'s own structural assertions
  (correct filenames, no leaked frontmatter/admonition/content-tab/
  abbreviation/MDX-component syntax across its whole fixture's output).
- **(B) Dedicated fixture + reviewed output** — `markdown-reference.test.ts`
  has its own task-tracker-flavored fixture (`Task`/`Assignee`/`Priority`/
  `ActivityEvent`/`ProjectBoard`, distinct from the four existing targets'
  fixtures) exercising a nested object, an enum with a deprecation reason,
  a deprecated leaf field, an optional field, a discriminated union with
  both `ref` and inline-object variants, an interface method, and a
  documented example — with hand-reviewed explicit-string assertions per
  section kind, same convention as the other four targets' test files.
- **(D) Verified correct, not just accepted** — this target has no single
  real tool to build against the way MkDocs/Sphinx do, since it isn't tied
  to any doc-site generator; a real-tool build step (bar C) has no
  candidate tool to name here at all, not just an out-of-scope one. The
  nearest equivalent to the other targets' "human confirms rendered output
  isn't broken" bar-D intent, chosen as the best fit for a target with no
  consuming tool: every generated page is parsed with a real,
  spec-compliant GFM parser (`remark` + `remark-gfm`, the same parser
  powering MDX/Next.js/Gatsby Markdown pipelines — added as a
  `packages/type-ir` devDependency for this purpose) and asserted to parse
  cleanly (no parser messages) into the expected AST node types — a table
  as a real `table` node, a fenced code block as a real `code` node, a
  cross-link as a real `link` node — rather than silently degrading into
  literal text on a syntax mistake bar A's substring checks wouldn't
  catch. This is a judgment call reading bar D's intent onto a target
  shape the bar's own text (written with a real build tool in mind) didn't
  anticipate — flagged the same way the Sphinx D-presupposes-C tension
  above was flagged, for the project owner to confirm or correct before it
  becomes the unstated precedent for any future generator-agnostic target.

While building this target, a pre-existing gap was also found and fixed
in passing: `sphinx-reference.ts` had a working `registry.ts` entry and is
documented as importable from
`@rhi-zone/fractal-type-ir/sphinx-reference` in
docs/reference/type-ir/doc-projectors.md, but `packages/type-ir/package.json`
had no matching `./sphinx-reference` subpath export — the import shown in
its own documentation would not actually have resolved. Added alongside
the new `./markdown-reference` export, same shape as every sibling
target's entry.

**Still planned**: The remaining site-level generators listed below
(VitePress for JS/TS beyond Docusaurus/Starlight, mdBook for Rust, DocFX
for C#, and Zensical/GitBook cross-language) — none of these
ecosystem-native generators have a fractal projector yet; five
cross-ecosystem/ecosystem-native doc-site frameworks (Docusaurus,
Starlight, MkDocs, Material for MkDocs, Sphinx) are done. The plain
Markdown target above is a sixth built projector but isn't one of the
original "10 in-scope targets" this count and the popularity-ranked list
below were built around — it isn't tied to any one ecosystem/generator, so
it was never a candidate answer to that list's "what order do the
remaining ecosystem-native targets ship in?" sequencing question. It's
still recorded in the popularity-ranking section below, unranked, with
that mismatch flagged explicitly — see the note there.

Site-level generators to target, by language ecosystem:

- JS/TS — Docusaurus, VitePress, Starlight
- Python — Sphinx (autodoc), MkDocs (mkdocstrings)
- Rust — mdBook
- C# — DocFX (conceptual-Markdown mode — see scope note below)
- Cross-language — Zensical (squidfunk's newer Rust-based doc
  generator), GitBook (hosted docs-as-product platform)

**Explicitly out of scope: API-reference extractors.** The project
owner has scoped this initiative to _documentation site generators_ —
tools that consume a tree of hand-authored (or otherwise pre-generated)
content pages and build/render them into a doc site, the way
Docusaurus/Starlight/MkDocs/Sphinx/VitePress/GitBook/mdBook/Material for
MkDocs/Zensical all do — and explicitly excluded _API-reference
extractors_: tools whose core job is parsing source code and inline doc
comments (docstrings, `///`, `/** */`, XML doc comments, etc.) directly
into reference docs, with no real concept of ingesting a separate
hand-authored page tree. TypeDoc was the first confirmed example
(fractal's analogue of Stainless — that whole API-reference-extraction
niche is out of scope here), and the same distinction was then applied
across the full planned-target list. Removed on that basis, each
verified against its own docs/homepage rather than assumed by
name/language rhyme with TypeDoc (2026-08-13 pass): **JSDoc** (JS),
**pdoc** (Python), **rustdoc** (Rust), **Javadoc** (Java), **godoc /
pkg.go.dev** (Go), **YARD** and **RDoc** (Ruby), **DocC** (Swift —
supports Markdown articles, but only inside a `.docc` catalog tightly
bound to one framework's symbol graph, not an independent authored-page
tree; core identity is still API-reference compilation from code),
**Dokka** (Kotlin), **Haddock** (Haskell), **Doxygen** (C++),
**phpDocumentor** (PHP), **dartdoc** (Dart), and **elm-doc-preview**
(Elm) — all confirmed pure source/doc-comment extractors with no
hand-authored-page-tree capability.

**DocFX (C#) checked specifically and kept, not removed.** Its own docs
(`docs.basic-concepts`) describe two genuinely separate pipelines: an
optional API-extraction step (XML doc comments → YAML → HTML) and a
"Conceptual Documentation" pipeline that builds a themed site from a
tree of hand-authored Markdown pages with its own TOC/navigation — the
API step can be omitted entirely and DocFX still builds a full site from
Markdown alone, the same shape as Sphinx/MkDocs. That page-consuming
capability is substantial, not a thin bolt-on, so DocFX stays in scope
— targeted specifically for its conceptual-docs mode, not its optional
API-extraction mode.

#### Popularity-descending ranking of all 10 targets (research pass, 2026-08-12; trimmed 2026-08-13)

A general-popularity check across the 10 in-scope targets (4 already
built plus 6 planned at the time of this research pass — updated
2026-08-13 to 5 built plus 5 planned, per the "MkDocs vs. Material for
MkDocs target-identity ambiguity, resolved" note above; the numbering
below is left as originally researched — see "Explicitly out of scope: API-reference
extractors" above for the 15 tools originally included in this research
pass and then removed as out of scope; their entries below were deleted
rather than kept and re-numbered, since their placement no longer
informs anything this initiative sequences), run to inform sequencing
for the "what order do the targets ship in?" question below — signals
gathered live via npm/PyPI/
RubyGems/Packagist/pub.dev/crates.io/NuGet registry APIs, GitHub star
counts, and current comparison writeups, not estimated from memory. Per
this doc's own "not a rigorous audit" framing (mirroring
`docs/design/framework-router-codegen.md`'s "Framework scope and priority
order" section, which this list follows in tone/rigor), this is a
**first-pass ordering to be revised against real numbers at
implementation time, not a locked decision**. Where the metric behind
adjacent items is close enough that the order is close to a coin flip,
that's flagged explicitly below rather than smoothed over — and cross-
ecosystem comparisons throughout (npm/PyPI download counts vs. GitHub
stars vs. built-in-toolchain reasoning with no download metric at all) are
inherently apples-to-oranges; false precision is not implied by the
numbering.

1. **Sphinx** (Python — **built**) — ~18.8M PyPI downloads/week
   (pypistats.org, 2026-08-12); powers CPython, Django, NumPy, pandas,
   SciPy, and Flask's own docs.
2. **MkDocs** (Python — **built**, `mkdocs-vanilla-reference.ts` as of
   2026-08-13; the pre-existing `mkdocs-reference.ts` this "built" tag
   originally pointed to turned out to already be Material-flavored, not
   this target — see the resolution note above) — ~3.87M PyPI
   downloads/week (pypistats.org). _Coin flip vs. #3_: Material for
   MkDocs' own weekly figure (~3.76M) is close enough that the relative
   order between these two is not a confident call from this signal
   alone.
3. **Material for MkDocs** (cross-language, squidfunk — **built**,
   `mkdocs-reference.ts`, extended 2026-08-13 per the resolution note
   above) — ~3.76M PyPI downloads/week (pypistats.org); note squidfunk's
   own blog (2025-11-05) announces this project's end-of-life for
   2026-11-05 in favor of Zensical (#10 below) — high current usage
   running alongside an active sunset.
4. **Docusaurus** (JS — **built**) — ~1.41M npm downloads/week; 65.9k
   GitHub stars, the highest star count of any tool in this list, used
   by React/Jest/Prettier docs.
5. **GitBook** (cross-language, hosted/commercial) — no clean package-
   download metric since it's SaaS, not a downloadable tool; w3techs.com
   (August 2026) puts it at 21.0% share among sites it classifies as
   documentation platforms, and its open-source frontend repo
   (`GitbookIO/gitbook`) has 29.0k GitHub stars — both well above most
   single-language tools in this list, but the underlying signal
   (site-classification share, vendor-claimed "2M+ users") is
   structurally different from every download-count comparison
   elsewhere here. **Placement is low-confidence** given how different
   the signal type is from its neighbors.
6. **VitePress** (JS) — ~768k npm downloads/week.
7. **Starlight** (JS — **built**) — ~708k npm downloads/week. _Coin
   flip vs. #6_: close enough to VitePress's figure that the relative
   order between these two is near a toss-up on this signal alone.
8. **DocFX** (C#/.NET) — ~5.8M all-time NuGet downloads (nuget.org
   package page and the NuGet search API agree on this figure); scoped
   here for its conceptual-Markdown-site mode specifically, not its
   optional API-extraction mode — see the out-of-scope note above.
9. **mdBook** (Rust) — crates.io shows ~9.87M all-time downloads / ~837k
   "recent" downloads (a secondary search-derived figure of ~7.7M
   all-time didn't reconcile with the direct API read; the direct API
   figure is treated as more reliable here).
10. **Zensical** (cross-language, squidfunk's newer Rust-based successor
    to Material for MkDocs) — ~321k PyPI downloads/week is a real,
    substantial number for a project only ~9 months old (created May
    2025, still pre-1.0 at v0.0.53 as of this research) — flagged as
    possibly inflated by CI/bot traffic (a general caveat on PyPI/npm
    download counts industry-wide, called out with particular emphasis
    here given the project's very early release stage), and its true
    standing will likely rise further once Material for MkDocs sunsets
    in November 2026.

**Caveats on this whole list, restated:** this was a general-popularity
check (registry download APIs, GitHub star counts, current comparison
writeups), not a rigorous download-count audit — treat both the ordering
and any specific placement above as a first pass to be checked against
real numbers when a given target's projector is actually about to be
built, the same framing `framework-router-codegen.md`'s candidate list
uses. GitBook (SaaS, no package-download metric) is flagged individually
above for that reason. Coin-flip-close pairs called out above: MkDocs
vs. Material for MkDocs (#2/#3), VitePress vs. Starlight (#6/#7).

**Plain Markdown (generator-agnostic) — deliberately left unranked, not
just missing a metric.** Built 2026-08-13 (see the "Plain Markdown
(generator-agnostic) target, added" note above). Every entry in the
ranked list above, including GitBook's SaaS-market-share substitute
signal, measures adoption of one specific installable tool or product;
this target isn't a tool or product at all — it's an output format
(CommonMark + the GFM table extension) with no install step, no package
registry listing, and no natural adoption metric to stand in for one.
Assigning it a numbered rank next to Sphinx/MkDocs/Docusaurus would imply
a popularity comparison that doesn't actually make sense category-wise,
not just one this research pass happened not to measure — the way
"GitBook has no clean download metric" still does, since GitBook is a
real product other signals (market share, stars) can stand in for. This
is a genuine ambiguity in how to represent it here, not a decision the
implementer should make unilaterally: **the project owner should confirm
whether "unranked, listed separately" is the right call, or whether some
other representation (e.g. folding it into the sequencing question
differently, or treating "no installable tool" itself as a placement
signal) is preferred instead.**

### Production-grade initiative across all doc-generation targets — open

The project owner wants to push all doc-generator targets — the five
ecosystem-native built targets (Docusaurus, Starlight, MkDocs, Material
for MkDocs, Sphinx) plus every planned target above (10 targets total as
of this writing: 5 built, 5 planned, after the 2026-08-13 trim removing
the 15 API-reference-extractor tools listed as out of scope above, and
the same-day resolution of the MkDocs/Material-for-MkDocs target-identity
ambiguity, see above) — to "production grade" together, as one
initiative. The generator-agnostic plain Markdown target (also built
2026-08-13, see above) sits outside this ten-target count, per the same
"not one of the original in-scope targets" framing given where it's
introduced above; whether it's meant to be pulled into this
production-grade push too is left to the project owner alongside the two
open questions below, not assumed either way here. No
definition of "production grade" exists yet for this repo's doc
projectors, and none is proposed here; both of the following are open
questions belonging to the project owner:

- **What bar does each target need to clear?** Candidate dimensions
  that have come up in adjacent discussion elsewhere in this doc but
  have not been decided for this initiative: automated test coverage
  per projector, verification against a real-world fixture (does the
  generated output actually build/render in that ecosystem's real
  tooling, not just structurally resemble valid output), a
  cross-target parity checklist (which features — cross-linking,
  hover info, deprecation markers, etc. — every target is expected to
  support vs. which are ecosystem-specific), documentation of the
  `meta`-bag-to-native-doc-comment mapping per target, and/or something
  else not listed here.
- **What order do the remaining targets ship in?** No sequencing or
  prioritization is assumed here (e.g. by ecosystem popularity, by
  reuse of already-built code-level doc-comment emission, by which
  ecosystems fractal already has strong projector coverage for). This
  needs deciding before work is scheduled. A first-pass
  popularity-descending ordering of all 10 in-scope targets, built from
  real research rather than assumed, is now recorded above in
  "Popularity-descending ranking of all 10 targets (research pass,
  2026-08-12; trimmed 2026-08-13)" —
  offered as one candidate input to this sequencing question, not a
  settled answer to it; the project owner may weight sequencing by a
  different factor entirely (reuse, existing coverage strength, etc.),
  per the alternatives named in this bullet.

#### Candidate "basics" bars — options for the project owner to choose from

The project owner has said they want "the basics done for all our
targets first" before going deeper on any one target, but has not yet
defined what "basics" means for this initiative. That definition is not
invented here — below are several distinct candidate bars, laid out with
their tradeoffs, for the project owner to pick from (or combine, or
reject in favor of something else not listed). None of these is
recommended over another.

**What the two not-yet-retrofitted built targets (Docusaurus, Starlight)
currently clear, as one data point (not the answer).** Checked against
actual repo state rather than assumed: `docusaurus-reference.ts`/
`starlight-reference.ts` type-check and are covered by
`registry.test.ts`'s generic "universal projector" loop, which asserts
non-empty output for a shared synthetic `sample`/`multi`
`TypeRefDocument` fixture used identically across _every_ projector in
the registry (not a fixture specific to any one doc target) — plus one
hand-written illustrative example per target in
`docs/reference/type-ir/doc-projectors.md` (prose documentation, not an
automated/CI-checked test). No target's output has been fed into the
real Docusaurus/Starlight build tooling and confirmed to actually build
or render; no visual check of the rendered result exists. That places
the current bar closest to candidate (A) below, arguably touching (B)
via the reference-doc examples, but not reaching (C) or (D).

**Sphinx (2026-08-12), and both MkDocs targets (2026-08-13), by
contrast, clear (A), (B), and an ad hoc/local form of (D)** — see the
"Documentation Generation" status callout above for the full breakdown
(Sphinx's D-presupposes-C tension, and both MkDocs targets' matching
real-`mkdocs build --strict` verification). These three are the only
built targets with a dedicated fixture, a reviewed/structural-assertion
test file, and any real-tool visual verification at all; Docusaurus/
Starlight have not been retrofitted to the same bars as part of this
work — doing so, if wanted, is a separate follow-up the project owner
would need to schedule.

- **(A) Structural smoke test.** The projector runs against a fixture
  without throwing, and produces non-empty output that's at least
  syntactically valid for its target format (parseable MDX/Markdown,
  valid frontmatter) — but the output is never fed into the real target
  tool. Cheapest bar; closest to what broad-coverage codegen tools like
  `quicktype` or OpenAPI Generator often ship as "supports language X"
  across a long tail of targets — structural validity per target, not
  per-target tool verification. Risk: a target can pass this bar while
  producing output that would fail to build in the real tool (a
  MkDocs-Material-specific admonition syntax typo'd wrong, for
  instance) — this bar wouldn't catch it. This is closest to the
  current bar the two not-yet-retrofitted built targets clear, per
  above.
- **(B) Dedicated fixture + reviewed/snapshotted output per target.**
  Adds a fixture representative of that target's real use (not the
  generic synthetic sample every projector currently shares) and a
  snapshot or reviewed-output test asserting the _shape_ of that
  target's output stays stable and was at least once looked at by a
  human — closer to how `TypeDoc`'s own test suite pairs fixtures with
  snapshot output. Catches regressions and gives one human-verified
  reference point per target, but still never runs the target
  ecosystem's actual tooling — a plausible-looking snapshot can still
  fail a real build.
- **(C) Verified against the real tool.** Generated output is actually
  run through its target ecosystem's real tooling as an automated CI
  step — `docusaurus build`, `mkdocs build --strict`, `sphinx-build`,
  `cargo doc`, `javadoc`, etc. — and the step must succeed. This is the
  same shape of verification this roadmap's "Testing & Quality"
  section already proposes for the _code-level_ general-purpose-
  language projectors (`go build`, `cargo build` against generated
  code, see "Battle testing" above) — applying it to doc projectors
  would extend an already-chosen pattern rather than introduce a new
  one. Cost: needs each target ecosystem's real toolchain available
  (the flake already carries many target-language toolchains for the
  code-projector case; doc-site tooling like a real Docusaurus/MkDocs/
  Sphinx install is a separate, not-yet-present dependency footprint
  per target).
- **(D) Verified correct, not just accepted.** Beyond the real tool
  accepting the output, a human (or an automated visual-regression
  step, e.g. screenshot-diffing the rendered site the way some
  TypeDoc/Docusaurus-adjacent projects use Percy/Chromatic-style
  tooling) confirms the _rendered result_ actually looks right —
  cross-links resolve, hover cards populate, admonitions render
  styled, nothing is visually broken. Highest-cost bar by a wide
  margin: needs a working rendered instance of each target site
  framework per target, and either sustained human review or a visual-
  regression pipeline maintained across 10 targets. Catches the
  broadest class of real defects (a build can succeed while still
  rendering wrong) but is likely impractical to apply uniformly across
  all 10 targets at once, versus being reserved for a smaller
  representative subset.

Two further dimensions, orthogonal to the above and separately
stackable onto whichever bar is chosen — not bars on their own:

- **Cross-target parity checklist.** A fixed list of features (cross-
  linking between types, hover info, deprecation markers, etc.) every
  target is expected to support, checked off per target, versus an
  explicit allowance for ecosystem-specific gaps (e.g. a target whose
  native tooling has no hover-card equivalent isn't penalized for
  lacking one). Already named as an open dimension earlier in this
  section; restated here because it composes with any of (A)-(D) rather
  than substituting for one.
- **`meta`-bag-to-native-doc-comment mapping documentation.** Already
  listed as an existing (not-yet-closed) acceptance-criteria item below
  — whether this is folded into the "basics" bar for every target or
  kept as a separate, later-stage deliverable is itself part of what's
  undecided here.

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
  projector in 1.0 scope — **DONE (2026-07-22)**, all 25 projectors
  emitting code-level doc comments.
- Site-level doc projectors (docusaurus-reference, starlight-reference,
  mkdocs-reference, mkdocs-vanilla-reference) built and verified with at
  least one representative per major ecosystem to successfully generate
  a docs site from fractal-generated code — **DONE (2026-07-22, extended
  2026-08-13)**: `docusaurus-reference.ts` (MDX + frontmatter,
  cross-links, `<TypeRef>` hover component, fields tables, union
  variants), `starlight-reference.ts` (`<Aside>`/`<LinkCard>`/`<Tabs>`/
  `<Code>`, TypeScript + JSON Schema signature tabs), `mkdocs-
reference.ts` — now explicitly the **Material for MkDocs** target
  (MkDocs-Material admonitions, abbreviation-based hover tooltips,
  icon-labeled content tabs for both the TypeScript/JSON-Schema
  signature and multi-example sections, Material grid-cards for a
  "Related Types" section, and a real `toMkdocsYaml()` `mkdocs.yml`
  emitter; fixed a pipe-escaping bug for enums in tables along the way),
  and `mkdocs-vanilla-reference.ts` — the genuinely separate **plain
  MkDocs** target added 2026-08-13 (CommonMark + only MkDocs' own
  default extensions, no Material syntax; blockquote deprecation
  notices, numbered example subsections). See "MkDocs vs. Material for
  MkDocs target-identity ambiguity, resolved" above for why these two
  are separate files/targets rather than one.
- `meta`-bag-to-doc-comment field mapping documented as a stable
  convention other projector authors can follow — already implicit in
  the 25 implemented projectors; explicit docs on the pattern TBD.

---

### Testing & Quality

**Status: NOT GREEN**

What exists: per-module unit tests (`*.test.ts` alongside most source
modules), property-based fuzz tests for JSON inference (fast-check),
adversarial test suites for enum-detection heuristics, a routing
benchmark harness (`packages/http-api-projector/src/route.bench.ts`)
with measured results documented in `docs/design/routing-benchmarks.md`,
and battle-test suites added 2026-07-22:

- Round-trip fidelity tests (22 tests) — JSON Schema and OpenAPI schemas
  survive ingestion → projection → re-ingestion.
- Cross-projector smoke tests (171 tests across 41 projectors, 4 fixture
  schemas) — comprehensive coverage exercising all projectors against
  realistic API/schema fixtures, identifying and driving fixes for
  struct-only union handling and metadata passthrough gaps.

What's planned / open:

- Fuzz testing and property-based testing beyond the JSON-inference
  modules — extending the same approach to ingesters/projectors
  generally.
- Cross-format round-trip validation as a first-class, systematic test
  category (format A → TypeRef → format B → TypeRef → compare), rather
  than the current per-module round-trip tests.
- ~~A CI pipeline~~ — **DONE (2026-07-22)**: GitHub Actions now runs a
  Nix-based pipeline (typecheck, test, build across all packages via the
  flake devShell), replacing the previously broken workflow (commit
  `bb38011`).
- ~~Adding target languages to the Nix flake~~ — **DONE (2026-07-22)**:
  `flake.nix` now provides 19 target-language toolchains (Python, Go,
  Rust, Java, Kotlin, C#/.NET, Ruby, PHP, Haskell, C++/nlohmann, Dart,
  Elm, Crystal, Swift, Flow, GNUstep/Obj-C, protobuf, capnproto,
  flatbuffers), all verified working (commit `27510c6`). Wiring these
  into an actual compile-check step in the test suite (as opposed to the
  toolchains merely being present in the devShell) is still open — see
  "Battle testing" below.
- ~~All 9 `compile-check.test.ts` `test.todo` items~~ — **DONE (2026-07-25)**:
  Rust-serde keyword escaping, C++ nlohmann/Haskell-aeson union name
  collisions, TypeScript-typebox recursive types, Obj-C Foundation
  primitive boxing, Cap'n Proto tuples, Python-attrs field ordering,
  FlatBuffers nested vectors, and Java/Kotlin enum unions all fixed.
  Compile-check step is significantly closer to complete.

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

- CI pipeline running typecheck + test on every push/PR — **DONE
  (2026-07-22)**, GitHub Actions Nix-based pipeline (commit `bb38011`).
- At least the general-purpose-language emit targets have flake-provided
  toolchains — **DONE (2026-07-22)**, 19 toolchains added (commit
  `27510c6`) — and a compile-check step exercising generated output
  — still open, toolchains are present but not yet wired into an
  automated compile-check step in the test suite.
- Cross-format round-trip tests exist as a named, discoverable category
  — **DONE (2026-07-22)**, 22 round-trip fidelity tests added.
- Battle-testing suite in place: real-world corpora wired into round-trip
  tests, parser fuzz tests running, and cross-language compilation
  checks passing — **Partially DONE (2026-07-22)**: 171 cross-projector
  smoke tests (4 fixture schemas through 41 projectors) verify all
  projectors compile successfully; CI pipeline and target-language
  toolchains in the Nix flake are now both in place (see above).
  Remaining: an automated compile-check step that actually runs the
  flake's toolchains against generated output as part of the test suite
  (`go build`, `cargo build`, etc.), and real-world schema corpora wired
  into round-trip tests.

---

### Fractal Framework

**Status: NOT GREEN**

The `api()`/`op()` tree and its projectors — a separate, composable
layer built on top of type-ir.

What exists:

- Core tree model (`packages/api-tree`) — `api`, `op`, `Node`, `Meta`,
  `mergeMeta`, tags lattice, extraction from TypeScript source
  (`extract.ts`), build orchestration (`build.ts`), and a
  `fractal-api-tree` CLI (`build`/`watch`/`check`). Also the
  shared input-assembly core (`assemble()`/`Stores`/`SourceMap` in
  `input.ts`) — HTTP, CLI, and MCP projectors all build their own named
  stores and primary-store convention, then resolve params through this
  one function rather than each re-implementing the merge.
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
  prompts (MCP Tier 1 and Tier 2 — logging, progress notifications —
  complete; Tier 3 sampling is also done (`stores.caller.createMessage`);
  roots/subscriptions open, see `TODO.md`).
- CLI projector (`packages/cli-api-projector`).
- GraphQL projector (`packages/graphql-api-projector`) — server
  (schema/resolve/server), WebSocket subscriptions, and a client with
  typed codegen.
- Auth (`packages/auth-oidc`) — `AuthAdapter`/`AuthClientAdapter`
  contract plus a generic OIDC/JWT package; provider-specific packages
  (Clerk, Auth0, Supabase, Firebase, Cognito) not yet built.

What's planned / open (per `TODO.md`):

- MCP Tier 1 and Tier 2 (logging, streaming/progress notifications)
  complete; sampling also done. MCP roots/subscriptions still open.
- `stream`/`page` kind propagation (2026-07-24 session): corrected a
  stale claim below — `stream` (an `AsyncIterable<T>` return) was
  already propagated at RUNTIME across every projector, not just
  GraphQL: HTTP (`route.ts`'s `isAsyncIterable` → SSE), CLI (`cli.ts`'s
  same check → push JSONL), MCP (`server.ts`'s
  `collectStreamedToolContent`/`collectStreamedResourceContents`/
  `collectStreamedMessages`), and JSON-RPC (`server.ts`'s
  `streamViaNotifications`/`drainToArray`) all detect a handler's
  `AsyncIterable` return structurally, same "conventions over
  contracts" split GraphQL's tag-derived subscription inference uses.
  `page` (a `CursorPage<T>`/`OffsetPage<T>` return, `api-tree/src/page.ts`)
  had a real gap, now closed: HTTP already had client-side
  auto-pagination (`extensions/pagination.ts`) but no server-side
  discoverability signal — `route.ts`'s `defaultEncode` now attaches a
  `Link: <url>; rel="next"` header (RFC 8288) to a page-shaped response
  when `hasMore` is true. CLI had no page-aware output at all — `cli.ts`
  now detects a page-shaped result (`isPageShape`) and adds `--all-pages`
  (walks every following page in-process, streaming every item as JSONL)
  plus a stderr `# more results available --cursor/--offset ...` hint on
  the un-flagged path. MCP and JSON-RPC's own task scope was streaming
  only (already done, above) — pagination wasn't asked of them and
  neither has a protocol-level "next page" construct beyond the JSON
  body itself, so no changes were needed there. GraphQL still degrades
  `page` to a plain list in SDL (`type-ir/src/graphql.ts`) with no
  framework-level auto-pagination of its own — unchanged, out of this
  session's scope.
- CLI and MCP still walk the raw `Node` tree directly rather than
  through the `Node ⇒ ProtocolType` projection pattern HTTP/type-ir use.
- Generating idiomatic router code for existing frameworks (Express, Fastify,
  Hono, Elysia, ...) as an alternative or companion to `http-api-projector`'s
  own router output is underway: `@rhi-zone/fractal-http-framework-projector`
  (`packages/http-framework-projector`) now has two targets — Express
  (`generateExpressRouter`/`generateExpressRouterFromNode`, no generated
  validator per Express having no dominant convention) and Fastify
  (`generateFastifyRoutes`/`generateFastifyRoutesFromNode`, WITH a generated
  native JSON-Schema `schema` option per-route, split from `SchemaMap`'s
  combined input schema into Fastify's separate `params`/`querystring`/
  `body`/`response` positions — real requests are validated by Fastify's own
  `ajv` against it) — both eject model, both with real end-to-end tests
  mounting generated code into a real running server and driving it with real
  HTTP requests (see `docs/design/framework-router-codegen.md`). Remaining
  targets (NestJS, Koa, Hono, Elysia, ...) per that doc's popularity-descending
  list are not yet started; the drift-detecting `regen` command (refuse/
  force/diff modes) the design doc scopes is also not yet built.
- No dedicated declaration for an operation's possible error kinds in
  the tree/meta itself (error mapping is projector-level config today).
- A JSON-RPC projector (2026-07-24 session): corrected a stale claim
  below — `packages/json-rpc-api-projector` already exists (commit
  `eea69a2`, predating this roadmap edit), implemented to the same bar
  as HTTP/CLI/MCP/GraphQL (project.ts/server.ts/client.ts/wire.ts, plus
  `type-ir/src/json-rpc.ts`'s schema layer), including the streaming
  notification pattern described in the Acceptance Criteria below.
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
  OpenTelemetry tracing. Not started; the client-extension system (retry,
  timeout, interceptors, errors, logging, streaming, pagination,
  idempotency) is the mechanism it would extend.
  Webhook validation shipped (`packages/http-api-projector/src/webhook.ts`,
  `webhookSignatureLayer`/`replayPreventionLayer`) as server-side HTTP
  layers instead — inbound webhook verification isn't a client concern,
  so it followed `layers.ts`'s composable-`Fetch`-wrapper pattern rather
  than the client-extension system.
  Idempotency keys shipped (`packages/http-api-projector/src/extensions/idempotency.ts`'s
  `idempotencyKey()` client extension + `packages/http-api-projector/src/idempotency.ts`'s
  `idempotencyMiddleware()`/`IdempotencyStore` server middleware) — HTTP only;
  CLI/MCP/GraphQL have no header-equivalent channel to key off of.
- Automatic strategy selection for compiled HTTP routers — the routing
  benchmark work (`docs/design/routing-benchmarks.md`) identified
  crossover points between `radixRouter`/`compiledCharRouter`/
  `mapCharRouter` but never tuned them into automatic selection
  constants; `createFetch` still requires an explicit opt-in today.

Acceptance criteria for green:

- HTTP, MCP, CLI, GraphQL, and JSON-RPC projectors demonstrated
  end-to-end against a real example app (as `examples/library-api`
  already does for HTTP).
- MCP Tier 2 complete (done); MCP roots/subscriptions either complete
  or explicitly deferred with a documented reason (currently
  "speculative until concrete use case").
- `stream`/`page` kind propagation consistent across all projectors —
  done (2026-07-24 session), see the "Fractal Framework" section above
  for what was already in place (runtime `stream` detection everywhere)
  versus what was closed this session (HTTP `Link` header, CLI
  `--all-pages`).
- JSON-RPC projector implemented and tested to the same bar as the
  existing four (HTTP, CLI, MCP, GraphQL) — done, see above (was already
  present; this bullet was stale).
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
  dev shell, plus (as of 2026-07-22) 19 target-language toolchains —
  Python, Go, Rust, Java, Kotlin, C#/.NET, Ruby, PHP, Haskell,
  C++/nlohmann, Dart, Elm, Crystal, Swift, Flow, GNUstep (Obj-C),
  protobuf, capnproto, flatbuffers — all verified working (commit
  `27510c6`).
- A GitHub Actions CI pipeline (2026-07-22) — Nix-based, running
  typecheck/test/build across all packages via the flake devShell
  (commit `bb38011`).
- Per-package `exports` maps in each `package.json` for granular subpath
  imports (e.g. `@rhi-zone/fractal-type-ir/zod`).
- All packages currently at `0.1.0-alpha.0` — none published to npm yet.

What's planned / open:

- npm publishing — no package has been published; versioning strategy
  for the jump to 1.0 across eight interdependent workspace packages is
  undecided.
- The flake now has the toolchains (see "Testing & Quality" above), but
  no compile-check step in the test suite actually exercises them
  against generated output yet — that wiring is still open.
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
  every 1.0-scope target language — **DONE (2026-07-22)**, 19 toolchains
  added and verified (commit `27510c6`); an automated compile-check step
  using them is still open.
- A contributor guide exists covering monorepo layout, test/typecheck
  commands, and the project's own conventions (open metadata bags,
  subtyping over taxonomy, three-layer separation) at a level a new
  external contributor can act on without reading the full design
  archive.

---
