# Handoff — 2026-07-11

## What happened this session

Design session continuing from the dispatch builtins thread. Started with
thread #1 (dispatch builtins assumed not proven), arrived at a routing
expression model that reframes dispatch, middleware, and auth.

### Settled

1. **Dispatch space is a state machine** (directed graph), not just a tree.
   A tree is a subcase — acyclic, single incoming edge per node. Tree is
   authoring convenience, not the semantic primitive.

2. **Router as expression**: combinators produce data (DU variants), not
   closures. Same interpreter pattern already used for dispatch kinds and
   HTTP metadata. Projections are interpreters over the expression —
   dispatch evaluates, OpenAPI enumerates.

3. **Auth and middleware concerns collapse into input extraction** (thread
   #3 from the previous handoff). Auth credentials are just another input
   parameter sourced from the protocol request. No special middleware layer.

4. **Thread #1 (dispatch builtins) is subsumed** — the question of which
   builtins earn their spot falls out of the expression language design,
   not from importing HTTP categories.

### Open threads (carried forward, updated)

1. (was #2) **What ARE the DU variants?** Now reframed as: what are the
   combinator primitives in the expression language? (`match`, `pipe`,
   `alt`, `consume`, `capture` are illustrative, not settled.)
2. (was #3) **Input extraction design** — now expanded: includes auth,
   caller-context, per-parameter protocol sourcing.
3. (was #4) **Output formatting design** — unchanged.
4. (was #5) **Protocol behavior layer** — unchanged.
5. (was #6) **Stainless NIH / SDK generation** — unchanged.
6. (was #7) **Value prop clarity** — unchanged.
7. (was #8) **Design backlog #2-#10** remain open.
8. **NEW: What are the core types for the graph/expression model?** The
   tree node shape is authoring form, not the core type. What replaces it?
9. **NEW: Combinator primitives are illustrative, not settled.** What's the
   actual set?

## Read order

1. `docs/design/invariants.md` — authoritative constraints (wins on conflict)
2. `docs/design/routing-expression-model.md` (NEW) — expression model, state
   machine framing
3. `docs/design/router-model.md` — node shape, dispatch (partially reframed
   by expression model)
4. `docs/design/dispatch-extensibility.md` — DU + dictionary (now understood
   as one implementation of `match`)
5. `TODO.md` — open threads, architecture gaps, pending removals, backlog
6. This file — session context

## Key files changed

- `docs/design/routing-expression-model.md` (NEW) — state machine framing,
  combinator/expression model, auth-as-input-extraction, zag.js prior art
- `TODO.md` — updated architecture gaps and cross-references to the new doc
- This file — new handoff
