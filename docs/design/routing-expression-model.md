# Routing expression model

> **Provenance:** Design session 2026-07-11.

---

## Dispatch space is a state machine

The full dispatch space is a directed graph (state machine): nodes are states,
edges are `Request → (Request', Bindings) | NoMatch` — each edge examines the
request, possibly consumes part of it, possibly extracts bindings, and
transitions to the next state. Terminal states (no outgoing edges) have
handlers.

A tree is a subcase: acyclic, every node has at most one incoming edge. Trees
are the common authoring form and a good mental model, but not the semantic
primitive.

Core types should be graph-shaped; the tree authoring form compiles down to
them.

---

## Router as expression (combinator model)

Combinators are more general than graphs — a combinator expression can
represent anything a graph can (and more: transforms like `pipe` have no
clean graph equivalent).

But combinators that produce opaque closures lose inspectability (can't
enumerate for OpenAPI, CLI help, etc.).

Solution: combinators produce an **expression** — data, not closures. Each
combinator is a DU variant in an extensible discriminated union (same
interpreter pattern already used for dispatch kinds). Constructor functions
restore type safety at the authoring site.

Projections are interpreters over the expression language. Dispatch
interprets by evaluating; OpenAPI interprets by enumerating. Each interpreter
handles each variant in its own way (e.g., dispatch evaluates `match`; OpenAPI
enumerates its cases; dispatch runs `pipe`'s transform; OpenAPI passes through
it).

Generality and inspectability aren't in tension: every combinator added to
the DU is automatically both evaluable and enumerable.

---

## Candidate combinator primitives (not settled — illustrative)

- `match(accessor, cases)` — extract a value, dispatch by key
- `pipe(f, g)` — sequence/transform
- `alt(f, g)` — try f, if no match try g
- `consume(segment, next)` — match a path segment, continue
- `capture(name, next)` — consume a segment, bind it, continue

These are illustrative, not a settled set. What the expression language's
actual primitives are is an open question (see TODO.md).

---

## Auth and middleware collapse into input extraction

Auth credentials are just another input parameter. "Where does the auth
token come from" is the same question as "where does the `id` come from" —
path, query, header, body, env var, CLI flag.

No special middleware layer is needed for auth — it's an instance of the
general input extraction problem (open thread #3 in the previous handoff).

Caller-context (the who/where from an invocation surface) is also input
extraction: the projection extracts surface-specific values into the
handler's input type.

---

## Prior art: zag.js

zag.js (state machine library for UI components) confirmed the structural
parallel: states, guarded transitions, context accumulation, named
implementation-separated guards/actions/effects (dictionary of functions,
same pattern as fractal's "projector takes a dictionary of matchers").

Key difference: zag machines are long-lived (persist state across events);
routing machines are ephemeral (one request, run to completion).

zag's `choose` (try guards in order, first match wins) is a generalization
of node dispatch.

---

## What this reframes

- The DU + matcher model from `dispatch-extensibility.md` is one
  implementation of the `match` combinator.
- The tree node shape `{ handler?, children?, fallback?, meta }` is the tree
  authoring form, not the core type.
- Thread #1 (dispatch builtins assumed not proven) collapses — "which
  builtins earn their spot" falls out of understanding the full expression
  language, not from importing HTTP categories.
