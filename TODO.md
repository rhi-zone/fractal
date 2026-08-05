# fractal — TODO

## Completed this session (2026-07-25)

- **First Elixir projector** (`packages/type-ir/src/elixir-jason.ts`) — project owner approved bringing Elixir into the general-purpose language target list (previously deferred only pending an owner scope call, not a technical blocker — see `docs/roadmap.md`'s "Per-Language Serialization Library Variants" slice). Plain `defstruct` + Dialyzer-style `@type t :: %__MODULE__{...}` typespecs (NOT `Ecto.Schema`, matching every other struct-like projector's non-ORM default), Jason for JSON (`@derive Jason.Encoder`) as the ecosystem's long-standing de facto default over the newer 1.18 stdlib `JSON` module. Design choices worth flagging: (1) encode-only — Jason has no decode-into-struct API, and hand-rolling one would be wrong for nested structs, so none is emitted (matches every projector except `ruby-sorbet.ts`, whose `from_json` wrapper is only safe because `T::Struct` genuinely provides correct recursive deserialization already); (2) struct fields keep the IR's field name verbatim (`:firstName`, not `:first_name`) since `@derive Jason.Encoder` has no per-field rename hook the way Rust's serde derive does — an idiom-vs-wire-fidelity tradeoff resolved in favor of fidelity; (3) discriminated unions lower to one struct module per variant (named from its discriminant tag) plus an inline `@type t :: Circle.t() | Square.t()` typespec union — no wrapper struct needed, since Elixir typespecs support inline `|` unions directly (unlike Kotlin/Ruby, which need a named declaration site) — the discriminant field itself is KEPT on each variant (unlike `kotlin-kotlinx.ts`'s sealed-class encoding, which drops it via `@SerialName`), since Jason has no equivalent out-of-band reconstruction mechanism; (4) enums need no member-name sanitization (unlike Python's `enumMemberName`) — Elixir atom literals can carry the original string byte-for-byte via `:"quoted form"`. 42 tests (`elixir-jason.test.ts`), added to `cross-projector.test.ts`'s smoke matrix (union-root capable, not struct-only). `package.json` exports both `./elixir` (bare alias — Elixir has exactly one variant, matching the policy for Rust/Haskell/Elm/Crystal/Objective-C/Flow) and `./elixir-jason`. `beamPackages.elixir` staged in `flake.nix` for a future real compile-check; not wired into `compile-check.test.ts` yet because `@derive Jason.Encoder` is a compile-time macro requiring the actual `jason` Hex package on the code path (unlike Ruby's `ruby -c`, Elixir has no true syntax-only compile mode) — `test.skip`'d with the exact reasoning documented inline, matching the existing Java/Kotlin/C#/Dart/Elm pattern for libraries that aren't plain offline nixpkgs derivations. `docs/roadmap.md`'s General-Purpose Languages table and "Per-Language Serialization Library Variants" slice updated (sixteen → seventeen languages).

- **Idempotency keys** — client half: `packages/http-api-projector/src/extensions/idempotency.ts`'s `idempotencyKey()` `ClientExtension` attaches an `Idempotency-Key` header (caller-overridable name/methods/key-generator) to mutating requests (POST/PUT/PATCH/DELETE) that don't already carry one; both `wrapFetch` (runtime) and `codegen.wrap` (emits `__withIdempotencyKey` helper source) implement the same policy. Server half: `packages/http-api-projector/src/idempotency.ts`'s `idempotencyMiddleware()` (an `HttpHandlerMiddleware`) + pluggable `IdempotencyStore` interface (`get`/`set` with optional TTL) + default `InMemoryIdempotencyStore` — caches a handler's result per key, short-circuiting `next` on replay. Scoped to HTTP only: both `HttpHandlerMiddleware` (`(input, stores) => result`) and `ClientExtension.wrapFetch` (`(req) => Response`) never receive the leaf's `meta`, so neither hook can consult `meta.tags.idempotent` directly — the client instead proxies on HTTP method (matching `tags.ts`'s `verbFromTags` derivation) and the server proxies on the header's mere presence (matching how `Idempotency-Key` is used in practice — client opts in per-request). CLI/MCP/GraphQL have no header-equivalent transport channel to key off of, so idempotency-key support was not extended there — would require inventing a new per-projector convention (e.g. a `--idempotency-key` CLI flag), which is a design decision, not a mechanical port. 23 new tests (`extensions/idempotency.test.ts`, `idempotency.test.ts`). OTel tracing remains open (see decision below).

- **Webhook validation** — `packages/http-api-projector/src/webhook.ts`: `webhookSignatureLayer` (HMAC-SHA256/1/384/512 over the raw request body, auto-detecting raw-hex/`sha256=<hex>`/base64 signature encodings, optional timestamp-bound signed payload with a configurable tolerance window, constant-time comparison, 401 on any failure) and `replayPreventionLayer` (delivery-id dedup against a pluggable `{ has, add }` store, lazy-TTL in-memory default, 409 on duplicate). Same `Fetch => Fetch` composable-layer shape as `layers.ts`'s `corsLayer` — droppable, order-composable. Payload shape validation deliberately NOT duplicated here — an inbound webhook is a normal operation, so the existing `opts.validators`/`wrapValidators` input-schema path already covers it. New `./webhook` package subpath export. 23 new tests in `webhook.test.ts`.

- **compile-check.test.ts: all 9 `test.todo` items resolved** — The real projector bugs surfaced by compilation have been fixed: Rust-serde keyword escaping (r#type), C++ nlohmann union name collisions, Haskell-aeson union name collisions + ByteString → Text, TypeScript-typebox recursive type (Type.Recursive), Obj-C Foundation primitive boxing (NSNumber *), Cap'n Proto tuple positional structs, Python-attrs field ordering (kw_only=True), FlatBuffers nested vectors (wrapper tables) + union scalar wrapping, and Java/Kotlin enum union handling. Compile-check step is now significantly closer to complete.

- **Package names renamed** — `fractal-*` scoped packages now published as `@rhi-zone/fractal-*` for ecosystem consistency. Root `package.json` `comment` field removed.

- **JSON inference clustering algorithm candidates, implemented and measured** — `packages/type-ir/src/from-json-corpus.ts`'s `trySplitDissimilarObjects` (general, discriminant-free union splitting) now takes a `ResolveStrategy.clusteringMethod` option: `"single-linkage"` (existing default, unchanged), `"complete-linkage"` (agglomerative clustering; a merge requires ALL cross-pairs between two clusters within `objectSplitThreshold`, not just the nearest one — avoids the "chaining" failure where a bridging sample pulls two otherwise-dissimilar clusters together), and `"key-signature"` (groups by exact key-set signature, ignoring the distance threshold entirely — simpler and more aggressive, targets the "polymorphic API response" pattern of a few exact recurring shapes). Measured against `inference-eval.ts`'s harness on three targeted synthetic schemas (`inference-eval.test.ts`'s new "clustering method comparison" suite): all three recover a corpus of fully disjoint object shapes equally (`overallF1`/`unionFidelity.f1` = 1). On a constructed chaining scenario (three shapes A-B-C where only adjacent pairs overlap), single-linkage collapses the whole union into one merged object (`unionFidelity.f1` = 0) while complete-linkage and key-signature both recover it (`f1` = 1; complete-linkage still merges A+B into one variant since their own distance clears the threshold, landing on 2 recovered variants vs. the original 3). On near-identical polymorphic-API-response shapes (Jaccard distance 1/3, under the default 0.5 threshold), both threshold-based methods (single- and complete-linkage) merge them (`unionFidelity.f1` = 0); only key-signature recovers the split (`f1` = 1) — its trade-off, not measured here, is over-splitting ordinary records with a few sparsely-present optional fields, since it treats every distinct signature as a separate population. `complete-linkage`'s initial O(n^3) implementation (full pairwise-Set recomputation per merge round) took ~6.9s at n=500; rewritten to precompute the base distance matrix once and agglomerate via array-lookup + the standard complete-linkage merge-update rule, cutting that to ~52ms. Default remains `"single-linkage"` (back-compat); no single "best" method was crowned — the eval results show each is the right tool for a different corpus shape, so `clusteringMethod` stays a caller-facing choice rather than a fixed heuristic. 12 new unit tests (`from-json-corpus.test.ts`) + 6 new eval-harness tests (`inference-eval.test.ts`).

- **CFD-style discriminant discovery implemented** (commit `5d56bbf`) — `tryDetectCfdDiscriminant`/`scoreCfdCandidate`/`CfdCandidate` in `packages/type-ir/src/from-json-corpus.ts` add a second discriminant-search pass distinct from clustering, matching the Tagger paper's unary constant conditional functional dependency (ucCFD) search: examines every scalar sibling field directly against raw evidence (not just fields already typed enum/literal-union by the earlier enum-detection pass) and scores each candidate on cardinality, cohesion, and separation, picking the best-scoring candidate above a threshold. Unary-only (one field at a time), matching the paper's own tractability restriction. Configurable via `ResolveStrategy.detectCfdDiscriminants`/`cfdMinSamples`/`cfdMaxCardinalityRatio`/`cfdMinGroupSize`/`cfdMinScore`.

- **Two harness-surfaced JSON-inference gaps fixed**: top-level discriminated-union detection at the schema root (commit `522e48f` — discriminated unions now detected at any object-typed position, not just array elements) and empty-array/null-only absorption (commit `b355513` — `unknown` now treated as unification bottom rather than top, so a lone `[]` sample no longer collapses an otherwise-concrete element type to `unknown`).

- **npm publishing metadata filled in** (commit `1473c66`) — package.json publishing metadata completed for alpha readiness across packages.

- **Six new docs pages added** (commit `ecf06e8`) — type-ir core concepts, ingestion, projection, inference, framework guides, and a kind reference added to the docs tree.

- **Missing package READMEs added** (commit `b36d302`) — `packages/auth-oidc/README.md` and `packages/json-rpc-api-projector/README.md`, matching the style of the other six publishable packages' READMEs (what it does, key exports, usage example, install).

- **Stale test expectations fixed** (commit `bd4704e`) — `capnp.test.ts`, `haskell-aeson.test.ts`, `objc-foundation.test.ts` updated to match projector bug fixes (ObjC primitives now boxed as `NSNumber *`, Cap'n Proto tuples synthesize positional structs, Haskell aeson bytes map to `Text`).

## Decisions (2026-07-25)

- **npm publishing**: alpha, all packages together. HARD BLOCKER: do not publish until user manually approves everything.
- **Version strategy**: targeting 0.1.0 (not 1.0) after comprehensive QC + ecosystem comparisons.
- **Documentation site**: GitHub Pages (matching other rhi-zone projects). Content not ready — needs best-in-class docs before going public. Library being public is a prerequisite for docs being public.
- **SQL union layout**: `baseTable` option for table-per-variant — proceed with implementation (no downside identified).
- **JSON inference**: clustering/union splitting design is a blocker for release but no explicit ordering in roadmap. Clustering algorithm candidates now implemented and measured (see below) — remaining open question is whether to keep `clusteringMethod` as a caller-facing choice (current state) or pick one default via further real-corpus validation. **Design and plan live in the design docs; deliberately not summarised here, because a summary in this file went stale against them.** Read newest first: `docs/design/inference-theory.md` — current theory, supersedes both below where they conflict; `docs/design/inference-from-first-principles.md` — superseded, retained for its cleanroom provenance record; `docs/design/json-inference-model.md` (2026-07-25) — holds the phased implementation plan (§192-208), **which predates the current theory and conflicts with it in several places**: its "don't abstain" small-N policy, its treatment of MDL/Bayesian as interchangeable notation, and its P3-P6 scoring approach are each contradicted by `inference-theory.md` (§14 retractions, §12.2, §6.1, §17 real-corpus findings). P1-P2 remain executable as written; do not start P3+ without reconciling first.
- **Auth providers**: not discussed — remains parked.
- **General-purpose source-language ingestion (beyond TypeScript) — deferred indefinitely.** Arbitrary/general-purpose source-language ingestion (parsing Rust/Go/Java/C#/etc. source as a *source* of truth for type definitions, matching what typeshare does for Rust) is deferred indefinitely in fractal itself. Fractal currently only has TypeScript source ingestion (via the real TS compiler API). A session-long investigation weighed three approaches: (1) native per-language parser libraries compiled to WASM or shipped as prebuilt native binaries — works for some languages (Rust via `syn`, Python via `ruff_python_parser`) but many have no lightweight option (Java/C#/Kotlin are JVM/CLR-hosted; PHP's parser is itself PHP; Haskell/Elm/Crystal have immature or no wasm story; C++/Objective-C have no parser lighter than clang); (2) SCIP (Sourcegraph's code-intelligence protocol) — ruled out, verified against the actual proto spec: it carries symbol occurrences/hover text, not structured type data (no field-type/enum-variant/generic structure), and every real indexer requires the target project to fully build; (3) LSP — inferred (not independently spec-verified) to have the same structural-fidelity ceiling as SCIP (hover text, symbol names/kinds, not structured types) plus heavier operational cost (stateful per-session protocol, needs a running language server + resolvable project per language). Decision: the semantic-layer-on-top-of-tree-sitter problem (turning a tree-sitter CST into structured type data across many languages) is being treated as the responsibility of a sibling project, **rhi-zone/normalize** (https://github.com/rhi-zone/normalize) — a separate, active, substantial project (3,570+ commits) already building structural awareness of codebases via AST-based analysis across 98+ languages via tree-sitter, with MCP/HTTP/LSP server modes. Fractal will consume normalize's semantic layer as an ingestion source once/if that capability matures there, rather than building it independently inside fractal. Cross-repo dependency: this item cannot proceed without normalize's semantic layer maturing — tracked here per this repo's CLAUDE.md convention of not leaving cross-project issues in conversation. **Exception**: parsers already published on npm as ready-to-use WASM/JS packages (e.g. `flow-parser`, which already ships Flow's OCaml parser compiled to WASM) are fine to accept opportunistically — near-zero integration effort, no need to wait for normalize. Effort tiers found during investigation, for reference if revisited: near-zero (Flow via `flow-parser` on npm); cheap/proven wasm path (Rust via `syn`, Python via `ruff_python_parser`); moderate subprocess+native-AOT route (Go, Java, C#, Kotlin via GraalVM native-image/.NET NativeAOT); uncertain, needs a spike (Dart, Swift); hard, needs tree-sitter i.e. depends on normalize (Ruby, PHP, Haskell, Elm, Crystal, C++, Objective-C).
- **Production codegen extras** (OTel tracing, idempotency keys, webhook validation): investigate feasibility; if tractable, pull into release scope. Aim for comprehensive coverage. Webhook validation done (2026-07-25) as HTTP-projector server-side layers (`webhook.ts`), not a client extension — see above. Idempotency keys done (2026-07-25) as an HTTP client extension (`extensions/idempotency.ts`) + HTTP server middleware (`idempotency.ts`) — see above; not extended to CLI/MCP/GraphQL (no natural header-equivalent channel). OTel tracing done (2026-07-25) — see below.

- **tsconfig.base.json centralization + strict settings** — workspace root `tsconfig.base.json` rewritten to enforce uniform strictness across all packages: `noUnusedLocals`, `noUnusedParameters`, `exactOptionalPropertyType` enabled. All packages now extend from this base. Improves type safety and catches dead code earlier.

- **Type-ir semantic types audit** — comprehensive audit of kind groupings and composition orthogonality. Found no unused kinds. No consolidation changes needed — current design remains sound.

- **Type-ir structural fixes** — two breaking fixes to match invariants: (1) `meta.additionalProperties` split into `boolean` + optional `additionalPropertyType` for clarity (was conflating the boolean flag with the type); (2) `instance.source` renamed to `instance.declarationFile` (source is ambiguous; declarationFile is explicit about the file source).

- **SQL baseTablePerVariantSqlLayout** — implemented the base-table-per-variant SQL layout (approved per decision above). Postgres and MSSQL backends now emit a single base table with discriminator column + FKs to per-variant tables. Enables efficient queries across all variants.

- **OpenTelemetry tracing** — comprehensive production-grade codegen extra. Core protocol-neutral implementation in `packages/api-tree/src/otel.ts` (`TracingContext`, `span()`, `currentSpan()`, async-local-store integration). HTTP projector client extension (`packages/http-api-projector/src/extensions/otel.ts`): auto-instruments all HTTP calls with trace/parent-span propagation, span creation per-call, semantic conventions for HTTP. Server-layer tracing in `packages/http-api-projector/src/otel.ts` with middleware integration. 32 new tests covering context propagation, span creation, carrier encoding/decoding, server-side middleware. Fully integrated with tree handler wrapping.

- **Cross-projector test.ts arity fix** — resolved the pre-existing `test.todo` line with arg-count mismatch in `cross-projector.test.ts` (bun-types expects 2-3 args, code was passing 1). Fixed type signature.

- **JSON inference K=1 string/integer asymmetry** — fixed confidence scaling issue where K=1 samples behaved differently for string vs integer literals. Standardized confidence via `literalMinSamples` config parameter, enabling tunable behavior.

- **JSON inference evaluation harness** — built comprehensive evaluation tooling: schema-to-corpus generator (synthesizes random JSON for a given schema), comparison scorer (measures schema quality across multiple metrics), evaluation runner (test-harness-style validation of clustering/splitting decisions). Enables quantitative validation of algorithm changes.

- **JSON inference generalized Jaccard union splitting** — extended union-splitting algorithm beyond discriminated-union patterns to field-set similarity clustering. Uses Jaccard distance to cluster objects by shared field presence, improving inference on semi-structured schemas.

- **Serialization compile-check survey** — Java/Kotlin/C#/Dart/Elm variant compile checks are currently skipped because they require external package registries (Maven, NuGet, pub.dev). Documented as a constraint, not a bug; CI uses containerized builds or registry mocking for future coverage.

## Completed this session (2026-07-24)

- **MCP Tier 2 (logging)** — `packages/mcp-api-projector`: `CreateMcpServerOptions.logging` advertises the `logging` server capability and exposes `stores.caller.sendLog` (MCP's `notifications/message`) to tool/resource/prompt handlers, wired to the SDK's own `Server.sendLoggingMessage`. Log-level negotiation (`logging/setLevel`) needed no new code — the SDK's `Server` constructor already registers that handler once the capability is declared and `sendLoggingMessage` already filters against the negotiated per-session minimum. 6 new tests in `server.test.ts` (capability advertisement, field gating, ALS-bridged emission, and a `logging/setLevel` negotiation test proving a below-minimum message is dropped).

## Completed this session (2026-07-22)

- **Web playground** — `packages/playground/` (Vite + Solid + CodeMirror 6). 13 browser-safe input formats × 45 output formats, all 585 combinations verified. Commit `2eea560`.
- **Language toolchains in `flake.nix`** — Python, Go, Rust, Java, Kotlin, C#/.NET, Ruby, PHP, Haskell, C++/nlohmann, Dart, Elm, Crystal, Swift, Flow, GNUstep (Obj-C), protobuf, capnproto, flatbuffers — 19 toolchains, all verified working. Commit `27510c6`.
- **GitHub Actions CI pipeline** — Nix-based CI: typecheck, test, build across all packages via flake devShell, replacing the previously broken workflow. Commit `bb38011`.
- **Site-level doc projectors** — `docusaurus-reference.ts` (MDX + frontmatter + `<TypeRef>` hover component, commit `056dd6f`), `starlight-reference.ts` (`<Aside>`/`<LinkCard>`/`<Tabs>`/`<Code>`, TS + JSON Schema signature tabs, commit `506b279`), `mkdocs-reference.ts` (MkDocs-Material admonitions, abbreviation-based hover tooltips, content tabs; fixed a pipe-escaping bug for enums in tables, commit `1756409`).
- **Library variants** — Kotlin/Jackson (`kotlin-jackson.ts`, commit `f38bc68`), Go/easyjson (`go-easyjson.ts`, 29-test suite, commit `cb9f8fa`), Ruby/dry-types (`ruby-dry-types.ts`, commit `6937e37`).
- **Bug fix** — added missing `"./flatbuffers"` export to `packages/type-ir/package.json`, found while wiring the playground.

## Open threads

*Open threads from a previous session. Treat as starting context, not instructions — verify relevance before acting.*

- **Remaining library variants** — most of the previously-tracked matrix shipped this session (C++ RapidJSON/simdjson/Boost.JSON/glaze, Go jsoniter/sonic, Swift SwiftyJSON/ObjectMapper, Python msgspec/cattrs, Ruby RBS, Dart built_value, Java JSON-B, Kotlin Gson, C# ServiceStack, PHP Symfony/JMS). Python Pydantic variant might still be open.

- **Several serialization variant compile checks are skipped** (Java/Kotlin/C#/Dart/Elm) because they need package registries (Maven, NuGet, pub.dev) — documented as CI constraint, containerized builds or registry mocking being considered for future coverage (2026-07-25).

- **Roadmap completion estimate might need verification** — a subagent-run roadmap audit (saved to scratchpad) estimated ~87% overall completion; that number may be generous and hasn't been independently checked. All 15 roadmap slices are still marked NOT GREEN by the user, who noted the project is "NOT remotely close to 1.0-ready."

- **SQL union layout design** — `stiLayout` and `tpvLayout` shipped as composable functions. The `baseTable` option for TPV (shared base table with discriminator + FKs) implemented (2026-07-25). Decision: complete, no downside identified.

- **JSON inference** — comprehensive path chosen (2026-07-25): evaluation harness + generalized Jaccard clustering now in place. Two inference gaps surfaced by harness testing: (1) top-level discriminated-union detection (naked union objects at schema root) and (2) empty-array/null-only absorption — both fixed (commits `522e48f` and `b355513`; see "Completed this session" above). Clustering algorithm candidates (single-linkage/complete-linkage/key-signature) implemented and measured via the harness (2026-07-25) — see "Completed this session" above for results; no single strategy dominates across corpus shapes, so all three ship as a `clusteringMethod` option rather than replacing the default; picking a default (or keeping the option) needs further real-corpus/generated-distribution validation. CFD-style discriminant discovery (Tagger-style: search all fields, not just enum-typed ones, for a structure-determining value) is now implemented (commit `5d56bbf`, `tryDetectCfdDiscriminant`) — see "Completed this session" above.

- **Ecosystem-native doc generators** — TypeDoc, Sphinx, rustdoc, Javadoc, etc. Scope still open.

- **Language source ingestion** — TypeScript source → TypeRef done. General-purpose source-language ingestion beyond TypeScript (Python, Rust, Go, etc.) deferred indefinitely (decision, 2026-07-25) — see "Decisions (2026-07-25)" above; depends on cross-repo rhi-zone/normalize maturing, with an exception carved out for npm-published WASM/JS parsers (e.g. Flow via `flow-parser`).

- **`moveTo` resolution in `HttpManifest`** — fixed (2026-07-25): `CollectEntries` now threads the whole-tree `Root` through its recursion, and a new `ResolveWildcardSegments` (`packages/http-api-projector/src/http-manifest.ts`) re-walks a `moveTo`-resolved path's segments against `Root` after `ApplyTokens`, substituting a synthesized `:param` wildcard for whatever `fallback.name` is actually authored at that position when one exists — mirroring `insertAt`'s (route.ts) runtime preference for a pre-existing fallback name. Covers the documented common case (a `"*"` target landing on a position `Root` already has real `children`/`fallback` structure for); does not reproduce `insertAt`'s full picture of two `moveTo`s converging with each other via the runtime's progressively-mutated tree, which is inherently outside a per-leaf, non-sequential type computation. New test: "moveTo's `*` wildcard reconciles against a co-located fallback's authored name, not the synthesized default" (`http-manifest.test.ts`).

- **Typed HTTP client relies on `unknown`/generics, not codegen** — `packages/http-api-projector/src/client.ts:58`'s inline TODO: the enumerating proxy client's leaf shapes are `unknown`/generic-typed rather than carrying real per-leaf input/output types; a typed surface needs codegen'd types from source and is noted there as "a future milestone," not yet started.

- **TAG_STREAMING wiring for MCP projector** — HTTP and CLI got stream/page kind propagation this session; MCP still works from JSON Schema (not TypeRef), so `stream` kind info may still be lost there. Might need the same plumbing, or a way to carry `stream` through the JSON Schema degrade.

- **Auth provider-specific packages** — adapter contract shipped, OIDC generic package shipped. Provider-specific packages (Clerk, Auth0, Supabase, Firebase, Cognito) not started — thin wrappers on top, could be community or fractal-maintained.

- **Production-grade codegen extras completed** — Webhook validation implemented 2026-07-25 as HTTP-projector server-side layers (`webhook.ts`), not a client codegen extension. Idempotency keys implemented 2026-07-25 as an HTTP client extension (`extensions/idempotency.ts`) + HTTP server middleware (`idempotency.ts`). OpenTelemetry tracing implemented 2026-07-25: protocol-neutral core in `packages/api-tree/src/otel.ts`, HTTP client extension, HTTP server middleware, comprehensive test coverage (32 tests). See main completion list above.

- **MCP Tier 3** — Subscriptions, roots (speculative until concrete use case).

- **Coercion placement specifics** — currently handled in `parse()` (transform+validate single pass). Broader story for store-level coercion and pre-input coercion TBD.

- **GraphQL resolver wrapper overhead** — measured ~0.28µs/call vs ~0.055µs for a raw graphql-js resolver (~5x, ~0.22µs absolute), dominated by `assemble()` and Result-shape detection. <1% of query latency for single-field queries; worth profiling if deep queries with hundreds of resolved fields become a real workload.

- **Structured error types are projector-level config, not a tree-level declaration** — `ErrorEncoder<E,R>` (`packages/api-tree/src/index.ts`) and each projector's `httpErrors`/`cliErrors`/`mcpErrors` combinators let a handler's `Result.err()` values get mapped to transport responses, but this is all consumer-supplied config passed to the projector at wire-up time. There is still no way to *declare* an operation's possible error kinds in the tree/meta itself.

- **RESOLVED for HTTP — service-store threading landed for `http-api-projector`, driven by the sibling codebase's real `tabularSource` consumer (ingestion.ts).** `HttpStoreBag` widened back to `Stores & HttpStores` (`ProjectorStores` no longer used by this package); `httpStores`/`defaultDecode`/`runRoute`/`toRouter`/`radixRouter`/`compiledCharRouter`/`mapCharRouter`/`makeRouterFromRoute` all take a trailing optional `serviceStores: ServiceStores = {} as ServiceStores` (the cast is load-bearing — see `httpStores`'s doc, decode.ts — because `StoreRegistry` merging is GLOBAL to a `ts.Program`, so a plain `{}` default fails whenever api-tree's own `deployment-store.fixture.ts` is in the same compilation) and thread it down to where `httpStores` spreads it into the per-request bag. `PresetOptions.serviceStores` (preset.ts) is the option a deployment supplies. **Found and rejected the `HasRequiredKeys`-conditional-required design TODO's prior text suggested**: making `serviceStores` conditionally required on `PresetOptions` forces EVERY `createFetch` call in a deployment's compilation to supply it (declaration merging is global — verified directly: it broke api-tree's own unrelated `auth.test.ts`/`context.test.ts`), not just the mounted sub-app whose handler actually reads it — wrong for the sibling codebase's 20-separate-`createThe sibling codebaseFetch`-calls shape, where only `ingestion.ts` needs `tabularSource`. `serviceStores` is instead ALWAYS optional on `PresetOptions`; the "one registration object... checked once" completeness guarantee (spec §4) is satisfied by the deployment's own single `const serviceStores: ServiceStores = {...}` assignment at its composition root (spec's own §4 example), which a deployment then passes only into the `createFetch`/`createThe sibling codebaseFetch` calls that need it. CLI/MCP/JSON-RPC/GraphQL projectors are UNCHANGED (still `ProjectorStores & XStores`) — the sibling codebase composes only HTTP, so threading the other four was out of scope; still open whenever a real consumer needs one.

- **Opt-in detection config for Result/streaming defaults to on** — `detection: { result?, streaming? }` lets a projector turn off automatic `Result`-unwrapping or `AsyncIterable`-streaming, but both default to `true` for backwards compatibility. Worth reconsidering whether on-by-default is the right long-term default or just the safe migration default.

- **Root tsconfig investigation** — workspace root `tsconfig.json` needs a full audit for strictness/consistency across packages.

- **RESOLVED (phase 2, 2026-08): `http-api-projector`'s `toOpenApi(n, { sourceFile })` auto-discovery key mismatch.** `extractRouteSchemas` keys every entry `${treeId}/${path}`; `openapi.ts`'s `buildPathMap`/`pathLeaves` used to build bare, unprefixed keys, so every auto-discovered schema silently missed and degraded to the `{ type: "object" }` placeholder. Fixed via `resolveTreeId` (openapi.ts): a new `OpenApiOpts.treeId` lets a caller supply the matching prefix explicitly (mirrors `wrapValidators`'s own initial-`path` convention); when omitted, the sole `treeId` present in the extracted schema map is inferred automatically (the common single-tree-per-file case) — a `sourceFile` exporting MORE than one tree throws (naming every candidate) rather than silently guessing which export the runtime `Node` value came from, since guessing risks correlating against a DIFFERENT tree's schema (the exact failure `treeId`-prefixing was introduced to prevent). New coverage: `openapi.test.ts`'s "toOpenApi(n, { sourceFile }) — auto-discovery treeId resolution" suite, backed by two new fixtures (`__fixtures__/openapi-single-tree.fixture.ts`, `__fixtures__/openapi-two-trees.fixture.ts`).

- **RESOLVED (phase 3, 2026-08): `applyValidation` migration — cli/mcp/graphql + `wrapValidators` deletion.** Phase 1 (commit `cf89fd0`) added the keyed, call-site-anchored `applyValidation(key, projectedTree)` mechanism (`packages/api-tree/src/apply-validation.ts`/`apply-validation-build.ts`) alongside the old `wrapValidators` (`build.ts`), consumed by nothing. Phase 2 (2026-08) migrated `http-api-projector` onto it via `PresetOptions.rewriters`. Phase 3 migrated `createMcpServer` (`mcp-api-projector/src/server.ts`), `runCli` (`cli-api-projector/src/cli.ts`), and `createGraphQLServer` (`graphql-api-projector/src/server.ts` — found mid-phase-3 to also depend on `wrapValidators`, not originally in scope) the same way: each lost its `validators` option and gained a `rewriters?: ReadonlyArray<(tree: Node) => Node>` option (mirroring HTTP's, but applied to the raw `Node` each of these three dispatches off directly, since none of them has a separate projected shape the way HTTP has `HttpRoute`). CLI's/MCP's fallback coercion/validation steps now check `isApplyValidationWrapped` (`apply-validation.ts`) instead of the deleted `isValidatorWrapped`. `wrapValidators`/`isValidatorWrapped`/`wrappedHandlerBrand`/`UnvalidatedLeafError` and the codegen entry points that existed only to serve them (`buildValidatorModuleSource`/`writeValidatorModule` + cached/incremental variants) are deleted from `build.ts`, which now exports only `GeneratedEntry` (shared infrastructure — the type-ir compiler's own output contract). `examples/library-api/src/tree.ts` migrated fully: `validatedApi = applyValidation("books", api)`, codegen's entry point now `apply-validation-build.ts` (package.json's `codegen`/`codegen:check` scripts point at `src/generated/apply-validation.ts`). `docs/design/routing-and-transforms.md`'s "Dispatch is not an interceptable multi-stage pipeline" section and `docs/guide/codegen-cli.md` updated to describe `applyValidation` as the current (and only) mechanism.

- **`graphql-api-projector/src/codegen.ts`'s `buildTree` doesn't handle a bare-leaf `fallback.subtree`** (found 2026-08-01 while fixing the MCP/JSON-RPC/CLI/GraphQL/HTTP walk-blind-spot family — see aa28952/its sibling fixes this session). `client.ts`'s runtime `buildClientNode` was fixed so a bare-`op()` `fallback.subtree` (Node model explicitly allows this) resolves to the leaf's own caller directly instead of an empty nested client object (no further tree position to descend into). `codegen.ts`'s STATIC client generator has the identical gap — `buildTree`'s `ClientTreeNode.param` field always wraps a full nested `subtree: ClientTreeNode`, with no way to represent "this fallback position IS the operation, not a container of operations" — so generated TypeScript for this shape would render an empty object type / no member, silently drifting from the (now-fixed) runtime behavior it's supposed to mirror. Left unfixed this session: fixing it correctly needs `ClientTreeNode.param` to become a union (`{ subtree: ClientTreeNode } | { operation: OperationEntry }`) plus matching changes to the type-rendering path (`render`/whatever consumes `ClientTreeNode`, not yet audited) — a real but separate lift from the mechanical walk-recursion fixes, deferred rather than rushed.

---

## Design backlog

- **OPEN (parked, 2026-08): semantic/effectful resolution as a possible
  distinct *resolve* stage** — surfaced while settling
  `docs/design/wire-profiles-and-staged-validation.md`'s open questions.
  Turning a validated field into a looked-up domain value (e.g. `uid` → a
  `User` lookup) is explicitly NOT an encoding-decode concern — wire profiles
  stay pure (no I/O in `validateEncoding`/`decode`). If ever built, this would
  be a distinct stage after `validateConstraints`, anchored on branded types.
  Three shapes were on the table: (1) effectful decoders inside profiles —
  rejected, breaks decode's totality-by-construction guarantee and profile
  purity; (2) a separate resolve stage — the favored shape IF this is ever
  built; (3) handler-level (status quo) — simplest, already how every handler
  works today, tradeoff is whether centralizing the pattern is worth a new
  stage. Not scheduled; no owner call made on whether to build it at all.
- **RESOLVED: `readOnly` vs `safe`** — `readOnly` is the canonical, final tag
  name. `safe` was rejected as too ambiguous (conflates "no side effects"
  with type safety, memory safety, safe-to-retry). See `tags.ts`'s
  `TAG_READ_ONLY` doc comment and `docs/design/converged-model.md`.
- **RESOLVED: `openWorld` tag** — MCP-only, not a general tree-level tag. Its
  only defined effect is being forwarded to MCP's `openWorldHint` by
  `mcp-api-projector`; no other projector reads it, and it has no HTTP
  projection. See `tags.ts`'s `TAG_OPEN_WORLD` doc comment,
  `docs/design/converged-model.md`, and `docs/design/directive-contract.md`.
- **RESOLVED: Versioning patterns / composition with dispatch model** — out
  of scope for the tree/dispatch model itself, which is finalized and does
  not include versioning. Versioning is handled via helper functions at the
  handler layer, not the core model.
- **OPEN: `docs/design/tree-lint-spec.md` — spec-only, not implemented.** No
  `tree-lint` package/script exists yet on any branch. §8 names several
  explicit non-decisions the eventual implementation will have to make: the
  exact source-text-fingerprint normalization function (naive whitespace-
  strip vs. full AST-normalize, a real cost/coverage tradeoff); whether
  `openapi.operationId` (or a new dedicated field) becomes a REQUIRED,
  lint-enforced leaf identity going forward, once a first pass exists and
  there's real corpus evidence to pose the authoring-discipline question
  against; whether tree-lint gains rules beyond collision detection (an
  orphaned-descriptor rule, a cross-tree auth-drift rule — both named as
  live candidates, neither designed); how `MountedTree.basePath` pairing
  stays in sync with a deployment's actual `app.mount()` calls without hand-
  maintenance; and CI severity/exit-code/output-format conventions (left to
  the consumer's own lint-script conventions, not re-derived here). the sibling codebase
  is the named consumer (§7) but hasn't started building against this spec.
- **OPEN: workspace robustness against foreign-root installs** — detection and
  recovery are done (`tooling/check-workspace.sh`, see Troubleshooting). Two
  bun-level knobs could reduce the chance of the corruption occurring at all;
  both are real changes with real costs, so they are an owner call, not a
  mechanical fix:
  - `[install] linker = "hoisted"` in a `bunfig.toml` (currently unset, so bun
    uses `isolated`). Hoisting removes the per-package symlink-into-a-store
    layer entirely, which is the layer that can be pointed at a foreign root —
    it would make this failure mode structurally impossible. Cost: hoisted
    resolution has different (looser) semantics — packages can resolve deps
    they never declared — and this repo currently gets strict isolation for
    free. Also changes disk layout and install behaviour repo-wide.
  - `[install] auto = "fallback"` (or `"disable"`). Bun's default is
    `auto = "auto"`, which silently runs an install when `node_modules` looks
    absent — including during a plain `bun run`. Constraining it means a
    broken tree produces an explicit error instead of a silent background
    install. Cost: contributors who forget `bun install` get an error rather
    than transparent recovery. NOT verified to be the mechanism that produced
    the observed corruption — it is a plausible contributor, not a diagnosed
    cause, and should not be adopted on the strength of that guess alone.

---

## Troubleshooting

- **Build fails with a pile of "Cannot find module" errors, or a test throws
  `ENOENT reading ".../node_modules/<pkg>"`** — the dependency store was linked
  against a different workspace root, so `node_modules` symlinks are
  well-formed but point outside this repo at a tree that may not exist.
  **Fix: `bun install` from the repo root** (it reports "no changes" — it
  re-points the links without re-downloading anything). Do not investigate
  further; this is not a code problem.

  `bun run check:workspace` (`tooling/check-workspace.sh`) detects it in ~50ms
  and is wired into `build:packages` and `test`, so it should normally fail
  fast with the recovery command rather than letting you hit the confusing
  downstream errors. The check distinguishes this case (dangling link escaping
  the repo — fails) from harmless leftovers pointing at removed workspace
  packages (reported, does not fail).

  Observed cause was an unrelated process outside this repo running an install
  that resolved the workspace root elsewhere; nothing in this repo can prevent
  that, so the tooling targets detection and fast recovery instead. See the
  "workspace robustness" entry under Design backlog for the two bun-level
  knobs that were considered.

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
