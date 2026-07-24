# fractal — TODO

## Completed this session (2026-07-25)

- **compile-check.test.ts: all 9 `test.todo` items resolved** — The real projector bugs surfaced by compilation have been fixed: Rust-serde keyword escaping (r#type), C++ nlohmann union name collisions, Haskell-aeson union name collisions + ByteString → Text, TypeScript-typebox recursive type (Type.Recursive), Obj-C Foundation primitive boxing (NSNumber *), Cap'n Proto tuple positional structs, Python-attrs field ordering (kw_only=True), FlatBuffers nested vectors (wrapper tables) + union scalar wrapping, and Java/Kotlin enum union handling. Compile-check step is now significantly closer to complete.

- **Package names renamed** — `fractal-*` scoped packages now published as `@rhi-zone/fractal-*` for ecosystem consistency. Root `package.json` `comment` field removed.

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

- **Several serialization variant compile checks are skipped** (Java/Kotlin/C#/Dart/Elm) because they need package registries (Maven, NuGet, pub.dev) — might need a different CI approach or containerized builds.

- **cross-projector.test.ts typecheck** — pre-existing `test.todo` line has an arg-count mismatch (bun-types expects 2-3 args, code passes 1). Looks like a minor fixable issue, not blocking.

- **Roadmap completion estimate might need verification** — a subagent-run roadmap audit (saved to scratchpad) estimated ~87% overall completion; that number may be generous and hasn't been independently checked. All 15 roadmap slices are still marked NOT GREEN by the user, who noted the project is "NOT remotely close to 1.0-ready."

- **SQL union layout design** — `stiLayout` and `tpvLayout` shipped as composable functions. The `baseTable` option for TPV (shared base table with discriminator + FKs) was discussed but not implemented — might be worth adding as a third built-in layout.

- **JSON inference** — parked, not blocked. Design decisions around clustering/union splitting still open.

- **Ecosystem-native doc generators** — TypeDoc, Sphinx, rustdoc, Javadoc, etc. Scope still open.

- **Language source ingestion** — TypeScript source → TypeRef, Python source → TypeRef, and similar for other languages. Still open, not started.

- **`moveTo` resolution in `HttpManifest`** — wildcard `"*"` token's synthesized `:param` name can diverge from another leaf's authored `fallback.name` at the same converged position. Per-leaf type information can't see whole-tree facts, creating a potential naming mismatch in the manifest.

- **TAG_STREAMING wiring for MCP projector** — HTTP and CLI got stream/page kind propagation this session; MCP still works from JSON Schema (not TypeRef), so `stream` kind info may still be lost there. Might need the same plumbing, or a way to carry `stream` through the JSON Schema degrade.

- **Auth provider-specific packages** — adapter contract shipped, OIDC generic package shipped. Provider-specific packages (Clerk, Auth0, Supabase, Firebase, Cognito) not started — thin wrappers on top, could be community or fractal-maintained.

- **6 unpushed commits on master** — local branch is ahead of `origin/master`; might be worth pushing before further work builds on top.

- **Production-grade codegen: remaining nice-to-have features** — OpenTelemetry tracing, idempotency keys, webhook validation not yet implemented as extensions.

- **MCP Tier 3** — Subscriptions, roots (speculative until concrete use case).

- **Type-ir semantic types cleanup** — current kind groupings work but designed quickly; revisit for composition/orthogonality once extension API gets broader consumers.

- **Coercion placement specifics** — currently handled in `parse()` (transform+validate single pass). Broader story for store-level coercion and pre-input coercion TBD.

- **GraphQL resolver wrapper overhead** — measured ~0.28µs/call vs ~0.055µs for a raw graphql-js resolver (~5x, ~0.22µs absolute), dominated by `assemble()` and Result-shape detection. <1% of query latency for single-field queries; worth profiling if deep queries with hundreds of resolved fields become a real workload.

- **Structured error types are projector-level config, not a tree-level declaration** — `ErrorEncoder<E,R>` (`packages/api-tree/src/index.ts`) and each projector's `httpErrors`/`cliErrors`/`mcpErrors` combinators let a handler's `Result.err()` values get mapped to transport responses, but this is all consumer-supplied config passed to the projector at wire-up time. There is still no way to *declare* an operation's possible error kinds in the tree/meta itself.

- **Stores typing via declaration merging could go further** — `StoreRegistry` makes accessing an undeclared *store name* a compile error, but doesn't type individual *values* within a store. Worth a follow-up pass if store misuse ever shows up in practice.

- **Opt-in detection config for Result/streaming defaults to on** — `detection: { result?, streaming? }` lets a projector turn off automatic `Result`-unwrapping or `AsyncIterable`-streaming, but both default to `true` for backwards compatibility. Worth reconsidering whether on-by-default is the right long-term default or just the safe migration default.

- **Root tsconfig investigation** — workspace root `tsconfig.json` needs a full audit for strictness/consistency across packages.

---

## Design backlog

- **`readOnly` vs `safe`** — tag naming question
- **`openWorld` tag** — meta field or tag? What does it control?
- **Versioning patterns** — composition with dispatch model
- **Decorator / metadata layer** — cross-cutting metadata pattern needed?

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
