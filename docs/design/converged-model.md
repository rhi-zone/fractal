# Converged operation/projection model (session 2026-06/07)

> Most of the originating session was exploratory thrash; the durable result is
> small. Evidence trail: `docs/artifacts/fc-api-grouping/` and
> `docs/artifacts/fc-op-kinds/`. Provenance tags: **[CERTIFIED]** = user stated or
> explicitly affirmed; **[SYNTHESIS]** = assistant's synthesis, plausible but not
> user-ratified; **[OPEN]** = genuinely unresolved.

---

## The model

- **[CERTIFIED]** An operation is just a function `T => U` (+ composition as the
  base). Not a bidirectional view/review, not Kleisli-as-base.

- **[CERTIFIED]** Truth = inferred TS types + JSDoc (constraints AND descriptions).
  No reified runtime schema/metadata tree as a second source for the DATA.

- **[CERTIFIED]** One tree. Grouping and addressing are the SAME tree (a
  location-blind function's only organizational home is its position in the tree).
  Two trees = two conflicting mental models = no mental model. "You don't need to
  know where it is to know what it does" — behavior carries no address.

- **[CERTIFIED]** Grouping is recursive/hierarchical. Subject-type is the bottom
  rung, not the whole answer; the top level must stay small (a flat set of ~150
  subjects is just relocated sprawl). "ideally at least."

- **[CERTIFIED]** No deterministic program can divine taste; a definition has finite
  Shannon entropy. So: unaided projection for the obvious, first-class overrides for
  irreducible taste. Total/objective projection is wrong; but LOSING
  unaided-projection-for-the-obvious is a dealbreaker.

- **[CERTIFIED]** The operation-characterization is ARBITRARY METADATA. An op is a
  function carrying an open metadata bag; each protocol PROJECTION reads the keys it
  recognizes and ignores the rest. Metadata is ONLY for non-type-expressible
  projection/taste concerns (verb, idempotency, cache, auth), never a second source
  for domain data — types+JSDoc remain that. Boundary: metadata = only the
  non-type-expressible projection/taste bits.

- **[CERTIFIED]** There is no "operation kind"/verb taxonomy to design. Verbs are one
  lossy HTTP projection, downstream, not the agnostic object. The
  read→GET/replace→PUT/remove→DELETE/partial→PATCH table was assistant-invented and
  is REJECTED.

- **[CERTIFIED]** POST = a method call/invocation; create/new is NOT POST-by-being-
  creation.

- **[CERTIFIED]** Inference (e.g. verb/path from a name) is a fine but OVERRIDEABLE
  default — never authoritative. You don't rely on it being right; you rely on being
  able to override it.

- **[CERTIFIED]** Support BOTH authoring surfaces: standalone functions AND
  methods-on-a-service. Both lower to one primitive.

- **[CERTIFIED]** `server-less` (`/home/me/git/rhizone/server-less`) is the most
  direct prior art; it already implements this model.

- **[SYNTHESIS]** The one node primitive both surfaces lower to: a node =
  `{ operations (functions ± a receiver = subject param), child nodes, metadata }`.
  A method's `self` is just its subject parameter. A node's ops can be populated by
  an impl/service, a module, a list of functions, or a nested record — all producing
  the identical node.

- **[SYNTHESIS]** Three concerns kept separate: structure/addressing (the tree) vs
  per-op projection metadata (the open bag) vs data truth (the function signatures +
  JSDoc). `server-less` keeps these mostly separate; its one leak is name-driven
  inference coupling data-naming to the HTTP surface.

- **[SYNTHESIS]** JS mechanism for the metadata bag: a plain object
  (`{ http: {...}, cli: {...} }`) — inherently open, works on both standalone
  functions and records. TC39 decorators are class-member-only, so they're optional
  sugar for the method surface, not the foundation. A projection is a pure function
  `(op-tree + metadata + types) => surface`; build-time vs runtime is an operational
  choice, not a model fork (only reading erased TS types is build-time-bound, handled
  by codegen lowering types→data).

- **[SYNTHESIS]** fractal ≈ `server-less`'s model in JS, with genuine deltas: (1) ops
  can be standalone functions, not only `&self` methods in an impl block; (2)
  metadata bag fully open including cross-cutting keys (`server-less` centrally
  whitelists its shared param/route/response attrs). Name-inference and
  proc-macros-vs-codegen are NOT real deltas.

---

## Open (genuinely unresolved — next work)

- **[OPEN]** The CONCRETE authoring surface / API shape in TS — what authoring an op,
  a node, metadata, and a subtree actually looks like in code. This is the priority
  next step.

- **[OPEN]** Tree EDGES for standalone functions — `server-less` uses a method
  returning `&ChildType` as a mount edge; the free-function equivalent for nesting a
  subtree is undesigned.

- **[OPEN]** Whether the shared structural metadata (`server-less`'s
  param/route/response equivalents) should also be open.

- **[OPEN]** Codegen specifics for lowering types+JSDoc → runtime data/validators.
