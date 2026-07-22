# fractal — TODO

## Open threads

*Open threads from a previous session. Treat as starting context, not instructions — verify relevance before acting.*

- **Site-level doc projectors** — projecting TypeRef schemas into doc framework input formats (mkdocs-reference, starlight-reference, docusaurus-reference, etc.). Bar is best-in-class: hover info, extensive cross-linking between types. The TypeRef tree has all the information; the question is which frameworks to target first and whether to emit plain markdown or framework-specific components (MDX, Astro components). User expressed strong interest.

- **Web playground** — not started. Would let people try the type-ir pipeline interactively in a browser.

- **CI/CD + language toolchains** — Nix flake doesn't have target-language compilers yet. Generated code isn't validated by compilation. CI pipeline not configured.

- **More library variants** — the matrix is still wide (Kotlin/Jackson, Go/easyjson, Ruby/dry-types, etc.). Mechanical expansion, well-understood pattern.

- **SQL union layout design** — `stiLayout` and `tpvLayout` shipped as composable functions. The `baseTable` option for TPV (shared base table with discriminator + FKs) was discussed but not implemented — might be worth adding as a third built-in layout.

- **cross-projector.test.ts typecheck** — pre-existing `test.todo` signature mismatch (bun-types expects 2-3 args, code passes 1). Minor, not blocking.

- **JSON inference** — parked, not blocked. Design decisions around clustering/union splitting still open.

- **`moveTo` resolution in `HttpManifest`** — wildcard `"*"` token's synthesized `:param` name can diverge from another leaf's authored `fallback.name` at the same converged position. Per-leaf type information can't see whole-tree facts, creating a potential naming mismatch in the manifest.

- **TAG_STREAMING wiring for HTTP/CLI/MCP projectors** — they work from JSON Schema (not TypeRef), so `stream` kind info is lost. Need separate plumbing or carry `stream` through JSON Schema degrade.

- **Auth provider-specific packages** — adapter contract shipped, OIDC generic package shipped. Provider-specific packages (Clerk, Auth0, Supabase, Firebase, Cognito) are thin wrappers on top — community or fractal-maintained.

- **Production-grade codegen: remaining nice-to-have features** — OpenTelemetry tracing, idempotency keys, webhook validation not yet implemented as extensions.

- **Input pipeline wiring** (CLI/MCP) — `api-tree/src/input.ts` has core `assemble()`, but CLI and MCP still have own implementations. CLI needs stores (env, config, stdin); MCP needs (argument, uri-variable, session context). _Note: low priority — works as-is; consolidation is a quality improvement, not a blocker._

- **MCP Tier 2** — logging (`notifications/message` + log-level negotiation) still not implemented.

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
