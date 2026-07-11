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

## Tree vs. state machine: cycles and corecursion

The tree representation cannot express cycles. Corecursive API structures
(e.g., `/nodes/a/children/b/children/c/...` where each node has the same
operations — read, delete, list children, create child, descend into child)
require a routing state machine with cycles. This is not contrived —
path-based resource traversal, nested comment threads, org hierarchies all
have this shape.

Mutual recursion (e.g., a `node` shape and a `collection` shape that reference
each other) also requires cycles.

Simple path traversal (unbounded depth with no per-level structure) can be
handled by a rest/splat parameter. But if each level has its own operations,
properties, and dispatch (method dispatch, property access, recursive descent),
a rest param pushes the entire router into the handler.

Cycles in the expression use `lazy(() => expr)` — a thunk that defers
evaluation until dispatch time, when all definitions are bound (same approach
as Zod's `z.lazy()` for recursive schemas). No formal fixpoint or letrec
needed. Enumeration projections (OpenAPI) detect cycles via reference identity
and emit `$ref` instead of expanding.

---

## Transition names vs. dispatch data

In the tree authoring form, keys serve double duty: they are both the
transition name (structural identifier) and the dispatch value (the path
segment to match). These are separate concepts that happen to coincide for
path segments.

A transition named `"byId"` might dispatch on a path capture. A transition
named `"getOrCreate"` might dispatch on method. The name is for the author
and the structure; the dispatch data says what input drives it. The tree
form's convenience is that the default dispatch data is "match a path segment
equal to this name."

---

## Flat state/transition maps are the right mental model, not the authoring form

The flat state machine (states + transitions as an adjacency list) is the
correct mental model for what routing does — named states, input-driven
transitions, terminal states with handlers. But as an authoring form it's
verbose and loses the composability that combinators provide.

Combinators as authoring, expression (DU) as the data they produce,
projections as interpreters. The state machine is the execution model, not
something you write directly.

---

## Combinators are the product

The extensible DU + interpreter pattern is the mechanism. Anyone can apply it.
The value of the framework is the **shipped combinators** — they encode
opinions about how APIs should be structured. Composed, they give you a
well-structured API that projects correctly to every surface (HTTP, OpenAPI,
CLI, SDK, MCP).

The combinators embody design taste (what a good API shape looks like); the
projections make it real. The extensibility exists so users can add
domain-specific combinators, but the shipped set is the product.

The initial set of combinators is therefore the product question, not just a
technical question.

---

## Open: principled capability boundary

How capable does the composition of shipped combinators need to be? The
question is not "what combinators exist" but "what API shapes can you express
by composing them, and where are the edges?" A principled way to determine
coverage — including edge cases — is needed before settling the initial set.

---

## What this reframes

- The DU + matcher model from `dispatch-extensibility.md` is one
  implementation of the `match` combinator.
- The tree node shape `{ handler?, children?, fallback?, meta }` is the tree
  authoring form, not the core type.
- Thread #1 (dispatch builtins assumed not proven) collapses — "which
  builtins earn their spot" falls out of understanding the full expression
  language, not from importing HTTP categories.
- The value prop question (thread #6) has a partial answer: the value is
  the shipped combinators, not the extensibility mechanism.
