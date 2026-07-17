# Router model (reframe)

> **Provenance:** Settled design from working session 2026-07-09. Supersedes the node/dispatch
> shape in `converged-model.md` and the built `packages/api-tree` node shape and
> `packages/http-api-projector` `buildRoutes`. Tags/metadata/projection principles in `converged-model.md`
> still hold — only the node shape and dispatch change.

> **Extended:** Dispatch extensibility model in [`dispatch-extensibility.md`](dispatch-extensibility.md)
> settles how dispatch kinds are added and wired (augmentable interface, dictionary of matchers,
> declaration merging next to the tree).

---

## Node Shape

A tree node is `{ handler?, children?, fallback?, meta }`.

- **Leaf**: a node with a `handler` and no `children`.
- **Branch**: a node with `children` (a `Record<string, Node>`) and no `handler`.
- **Fallback**: `{ name: string, subtree: Node }` — optional on any node. When
  keyed dispatch finds no matching child, the fallback consumes the value, binds
  it as a named parameter, and continues into `subtree`. Replaces `ParamNode`.

There is no `ops` map. Each operation is a leaf node; children are keyed by
agnostic lowercase names (`list`, `read`, `replace`, `remove`, …). The name is
what the author calls the operation — not a verb set, not a fixed vocabulary.

---

## Dispatch

Every internal node dispatches its children by **one attribute of the request**
(path-segment, method, header value, …). Path-segment is the default, not
privileged.

Dispatch data on the node is a **discriminated union** (DU) tagged by `kind`.
The projector interprets each variant — this is the **interpreter pattern**
applied as a degenerate (non-nested) case: the DU is the "AST", the projector
does case analysis on the `kind` tag and calls the corresponding matcher.

The DU is extensible (augmentable `DispatchKinds` interface). New variants are
added by batteries; corresponding interpreters (matchers) are plain functions
provided in a dictionary at the projector call site. See
[dispatch-extensibility.md](dispatch-extensibility.md).

### No compilation step

The projector dispatches **directly on the tree** at runtime — tree walk is
O(depth) via keyed child lookup at each node. There is no flattening to a
flat route table; the tree structure IS the efficient dispatch structure.

Enumeration projections (OpenAPI, CLI help) walk the tree collecting leaves.

---

## Verb derivation

The verb helper **bundle** (e.g. `methods({ read, replace, remove })`) applies
the tag-to-verb mapping at tree-build time. The mapping itself:

| tags | verb |
| --- | --- |
| `readOnly` | GET |
| `idempotent ∧ ¬readOnly ∧ ¬destructive` | PUT |
| `idempotent ∧ destructive` | DELETE |
| *(else)* | POST |

Verb is derived from tags at projection time — never stored as a separate key.

## HTTP metadata — interpreter pattern, not named keys

`meta.http` is NOT a fixed record of named keys (`verb`, `segment`, `when`).
It is a **DU** (or collection of DU values) interpreted by the projector.

Each piece of HTTP-specific data on a node is a tagged variant. The projector
has an interpreter (function) for each variant kind. Adding a new concern =
adding a new DU variant (augment the interface) + adding an interpreter
(dictionary entry). This is the same extensibility mechanism as dispatch kinds.

Specific keys like `verb`, `segment`, `when` are retired — they were
protocol-specific keys that should instead be DU variants with interpreters.

### Escape hatches

A DU variant MAY contain a closure (arbitrary function) for truly one-off
cases. This is allowed but discouraged — closures are opaque (can't be
inspected by enumeration projections). If an escape hatch recurs, it should
graduate to a proper DU variant.

## Meta composition

Composition = **deep-merge of `meta`** (child wins on conflict).

---

## Tags (unchanged from converged-model, restated)

> **CHANGED (2026-07-10):** Tag inheritance (closest-wins tree-walk / `effectiveTags`) is removed.
> `(tree) => tree` transforms are the general modification primitive — tags, dispatch defaults,
> metadata processing are all transforms. A node's tags are exactly what's on the node; they
> don't depend on ancestors. See [`dispatch-extensibility.md`](dispatch-extensibility.md).

- `meta.tags`: open, three-valued (`true`/`false`/`undefined`=unknown) behavioral markers —
  `readOnly`, `idempotent`, `destructive`, `openWorld`, `streaming`, + custom. Each projection
  reads them (HTTP→verb, MCP→hints, CLI→confirm, gRPC→idempotency).

---

## Projections

- Dispatching projections (HTTP, CLI): route one request → one leaf, via the compiled tree.
  Enumerating projections (MCP, OpenAPI, GraphQL): flatten all leaves → a surface. "Which attribute
  a node dispatches by" is meaningful only for dispatching projections; enumerators name
  method-dispatched children by their derived verb/role.

---

## What this supersedes

- `packages/api-tree` node shape: `{ops, children, meta}` → `{handler?, children?, meta}` (ops removed).
- `packages/http-api-projector` `buildRoutes`: per-op segments + flat table → the tree compiled as the router
  with attribute-dispatch; verb from tags at build.
- Tag storage/merge: ad hoc → `meta.tags` sub-bag composed by deep-merge-with-precedence.
- Adds: verb-helper bundles (`http.*`).
