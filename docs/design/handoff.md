# Handoff — 2026-07-11

## What happened this session

Design session on the dispatch/projection model. Settled several structural
questions; identified large architecture gaps between the abstract tree and
complete API projections.

### Settled

1. **Fallback field** replaces `ParamNode`. Node shape is now
   `{ handler?, children?, fallback?, meta }` where
   `fallback: { name: string, subtree: Node }`. Separates wildcard capture
   from keyed dispatch. Children stays `Record<string, Node>`.

2. **Interpreter pattern for HTTP metadata**. `meta.http` is a discriminated
   union (DU) interpreted by the projector, not a fixed record of named keys.
   Dispatchers/matchers are interpreters — degenerate (non-nested) case of the
   interpreter pattern because the DU has no recursive structure.

3. **verb/segment/when retired** as separate keys. Each concern becomes a DU
   variant with a corresponding interpreter function in the projector.

4. **No compilation step**. The projector dispatches directly on the tree at
   runtime via tree walk (O(depth), keyed child lookup). No flattening to a
   flat route table — the tree IS the dispatch structure.

5. **Escape hatches** (closures in DU variants) are allowed but discouraged.
   Common patterns should graduate to proper DU variants.

6. **Projection-specific metadata co-located on nodes**. External tree
   transforms targeting specific nodes are impractical (fragile path strings
   or heavy lens machinery). `meta.http`, `meta.cli`, etc. live on the node;
   each projection reads what it needs, ignores the rest.

7. **Dispatch builtins are extensions**, not a separate category. Method
   dispatch, header dispatch, etc. use the same DU + dictionary mechanism as
   user-added kinds. The architecture is uniform.

### Open threads (from this session)

1. **Dispatch builtins assumed, not proven**. Method dispatch and header
   dispatch were assumed from HTTP convention. Whether this is problematic
   hasn't been decided — needs thinking.

2. **What ARE the DU variants?** We retired verb/segment/when as named keys
   and said they become DU variants, but haven't designed the actual variant
   shapes. What variants does the DU ship with? What do they look like?

3. **Input extraction design**. Currently hardcoded (merge path + query +
   body). Should be pluggable with reasonable defaults. All strategies are
   extensions (same mechanism as dispatch). Reasonable defaults first,
   decomposition into primitives later.

4. **Output formatting design**. Currently hardcoded (JSON + 200). Same
   approach as input extraction.

5. **Protocol behavior layer**. HEAD, OPTIONS, 405 (currently autoMethodLayer)
   and CORS (separate concern) need design attention.

6. **Stainless NIH / SDK generation**. Generate typed client SDKs directly
   from the tree. `packages/client` is a rough version. Natural projection.

7. **Value prop clarity**. Fractal's value isn't "inspectable data" — it's
   that APIs shouldn't be different concepts for different protocols. Typed
   functions + composition, projected to any surface. Composability is real
   value; multi-protocol is a side effect of the right abstraction.

8. **Design backlog #2-#10** from the 2026-07-10 audit remain open.

## Read order

1. `docs/design/invariants.md` — authoritative constraints (wins on conflict)
2. `docs/design/router-model.md` — node shape, dispatch, interpreter pattern
3. `docs/design/dispatch-extensibility.md` — DU + dictionary + matchers
4. `TODO.md` — open threads, architecture gaps, pending removals, backlog
5. This file — session context

## Key files changed

- `docs/design/router-model.md` — fallback field, dispatch DU, no compilation,
  interpreter pattern for HTTP metadata, escape hatches
- `TODO.md` — architecture gaps section, backlog #1 settled, pending removals
  for ParamNode/buildRoutes/verb/segment/when
