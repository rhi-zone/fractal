# Handoff — 2026-07-11

## What happened this session

Continued design session. Worked through expression types, metadata
boundary, protocol-agnostic expressions, tag-to-verb validation, and audited
code vs design to identify and begin closing gaps.

### Settled

1. **Dispatch space is a state machine** (directed graph), not just a tree.
   A tree is a subcase — acyclic, single incoming edge per node. Tree is
   authoring convenience, not the semantic primitive.

2. **Router as expression**: combinators produce data (DU variants), not
   closures. Same interpreter pattern already used for dispatch kinds and
   HTTP metadata. Projections are interpreters over the expression —
   dispatch evaluates, OpenAPI enumerates.

3. **Auth and middleware concerns collapse into input extraction**. Auth
   credentials are just another input parameter sourced from the protocol
   request. No special middleware layer.

4. **Thread #1 (dispatch builtins) is subsumed** — the question of which
   builtins earn their spot falls out of the expression language design,
   not from importing HTTP categories.

5. **Cycles/corecursion use `lazy(() => expr)`** (Zod-style thunks) — a
   thunk that defers evaluation until dispatch time, when all definitions are
   bound. No formal fixpoint or letrec needed. Enumeration projections
   (OpenAPI) detect cycles via reference identity and emit `$ref` instead of
   expanding.

6. **Transition names and dispatch data are separate concepts** that
   coincide for path segments in the common case. A transition's name is
   structural (for the author); its dispatch data says what input drives the
   transition (path capture, method, header, etc.).

7. **Flat state/transition maps are the right mental model, not the
   authoring form.** Combinators as authoring, DU as data, projections as
   interpreters. The state machine is the execution model, not something you
   write directly.

8. **Combinators are the product.** The extensible DU + interpreter pattern
   is the mechanism — anyone can apply it. The value of the framework is the
   shipped combinators, which encode design taste about API structure. The
   extensibility exists so users can add domain-specific combinators, but
   the shipped set is the product.

9. **NEW: Expression step type is `T => T | undefined`.** NoMatch is
   `undefined`. `choice` with a total last branch is total. 404 is a regular
   handler, not a framework concept.

10. **NEW: Principled metadata vs expression boundary** — expression =
    affects handler selection; metadata = affects rendering/documentation.

11. **NEW: Protocol-specific dispatch (method, header) belongs in the
    projection, not the agnostic expression.** Operations have names and
    tags; projections derive protocol dispatch.

### Open threads (carried forward, updated)

1. **What are the combinator primitives?** Carried forward, now understood
   as the product question — not just "what exists" but what design taste
   the shipped set should encode.
2. **Input extraction design** — carried forward, expanded with
   auth/caller-context.
3. **Output formatting design** — carried forward.
4. **Protocol behavior layer** — carried forward.
5. **Stainless NIH / SDK generation** — carried forward.
6. **Value prop clarity** — partially answered: the value is the shipped
   combinators, not the extensibility mechanism. Remaining: articulate what
   design taste they encode.
7. **Design backlog #2-#10** remain open.
8. **Core types for the expression model** — carried forward.
9. **Principled capability boundary.** How to determine how capable the
   composition of shipped combinators needs to be, including edge cases.
   Needed before settling the initial set.
10. **NEW: Tag-to-verb derivation soundness.** The mapping is leaky for
    common cases (search-as-POST, login/logout, PATCH). Validate against
    real APIs or decouple tags from verb selection.
11. **NEW: Code-to-design sync.** Coordinated refactor in progress
    (ParamNode→fallback, effectiveTags removal, by→kind, named keys→DU,
    buildRoutes→tree walk, core dispatch() removal). Results pending.

## Read order

1. `docs/design/invariants.md` — authoritative constraints (wins on conflict)
2. `docs/design/routing-expression-model.md` — expression types, metadata
   boundary, protocol-agnostic expressions, tag-to-verb validation
3. `docs/design/router-model.md` — node shape, dispatch (partially reframed)
4. `docs/design/dispatch-extensibility.md` — DU + dictionary (one
   implementation of `match`)
5. `TODO.md` — open threads, architecture gaps, pending removals, backlog
6. This file — session context

## Key files changed

- `docs/design/routing-expression-model.md` — expression types, metadata
  boundary, protocol-agnostic expressions, tag-to-verb validation
- `docs/design/handoff.md` — new handoff
