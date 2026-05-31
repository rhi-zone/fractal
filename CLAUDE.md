# CLAUDE.md

## Origin

fractal is an HTTP/RPC/IPC API library where endpoints are plain data composed from a small set of primitives. Transports, validation, and static types are opt-in layers composed onto the core via combinators — not built into the core itself. Many interpreters walk one structure to produce artifacts: an HTTP server, a typed client proxy, an OpenAPI document, a test harness. End-to-end types are derived structurally from one definition.

The library exists because , the ecosystem app this is built for, runs on Hono — an imperative route/middleware HTTP framework whose API surface is not a reflectable value. Routes and middleware are registered procedurally; the shape cannot be traversed, transformed, or shared across transports without rewriting. This forces per-surface re-description and hand-synced types. fractal makes the API an inert-data structure interpreted into multiple surfaces.

**Design constraint (load-bearing):** The primitive set must be small and uniform, and composed presets must ship alongside the primitives. Composability alone does not yield a small mental model. A maximally-composable core without presets shifts assembly burden to the user — the failure mode visible in Effect. A deliberately tiny primitive set plus presets makes the common cases tractable without foreclosing the general case.

The node/combinator algebra is not yet designed. This repository is skeleton and tooling only. The next phase defines the primitive set and composition model.

<!-- BEGIN ECOSYSTEM RULES -->

## Ecosystem Design Principles

Cross-cutting principles distilled from the ecosystem's own decisions (synthesized in `docs/decisions/throughlines.md`). Apply them when building new repos and recording decisions. (Already-encoded principles — independent-tools / no-path-deps, the delegation model, CLAUDE.md-as-control-surface — live in their own sections and are not repeated here.)

- **Prefer data over code at every seam.** Serializable AST / struct / JSON over closures, embedded DSLs, or source text — so artifacts cache, replay, transport, and diff.
- **Library-first; projection-from-one-definition.** The typed library is the source of truth; CLI / HTTP / MCP / WebSocket / JSON surfaces are generated projections, never hand-rolled per surface.
- **Capability security.** Hosts grant pre-opened handles; code only attenuates what it is given; nothing forges authority; allow-list over deny-list.
- **The LLM is an oracle at the leaves, never the control loop.** Determinism is a hard invariant: seeded RNG, event-log replay, build-time-only inference. Per-query LLM in the hot loop is a defect.
- **Trust comes from verifiable evidence, not authority.** Verbatim snippets, pinned-commit permalinks, claim→node citation — never a bare reference.
- **Retire, don't deprecate; collapse asymmetries to primitives.** Remove backward-compat aliases rather than carry them; reduce N special cases to their irreducible primitives.
- **Validate against reality; tests are the spec.** Load-bearing substrates are validated against real corpora; fixtures and tests define correctness, not aspirational specs.

## Hard Constraints

- No `--no-verify`. Fix the issue or fix the hook.
- No path dependencies in `Cargo.toml` — they couple repos and break independent publishing.
- No interactive git (no `git rebase -i`, no `git add -i`, no `--no-edit` on rebase).
- No suggesting project names. LLMs are bad at this; refine the conceptual space only.
- No tracking cross-project issues in conversation — they go in TODO.md in the affected repo.
- No ecosystem changes without checking all affected repos.
- No assuming a tool is missing without checking `nix develop`.
- Commit completed work in the same turn it finishes. Uncommitted work is lost work.

## Meta

- Something unexpected is a signal. Stop and find out why. Do not accept the anomaly and proceed.
- Corrections from the user are conversation, not material for new rules. Rules are added when a failure mode is observed repeatedly.

<!-- END ECOSYSTEM RULES -->
