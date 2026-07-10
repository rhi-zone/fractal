# Router model (reframe)

> **Provenance:** Settled design from working session 2026-07-09. Supersedes the node/dispatch
> shape in `converged-model.md` and the built `packages/core` node shape and
> `packages/http` `buildRoutes`. Tags/metadata/projection principles in `converged-model.md`
> still hold — only the node shape and dispatch change.

> **Extended:** Dispatch extensibility model in [`dispatch-extensibility.md`](dispatch-extensibility.md)
> settles how dispatch kinds are added and wired (augmentable interface, dictionary of matchers,
> declaration merging next to the tree).

---

## Core insight

The tree IS the entire router. It is a uniform, nested dispatch structure — not a `{ops, children}`
node plus a separate flat route table. Dispatch = walking the tree; each internal node dispatches
its children by *one attribute of the request*.

---

## Node

- A node is `{ handler?, children?, meta }`. It may be callable (carries a bare handler fn
  `T => U`) and/or a branch (has children). A leaf = a node with a handler and no children.
- There is NO `ops` map. The previous `ops` was a mistake: it put callables on the path-segment
  axis (op-key = segment), colliding with `children` and unable to co-locate. Callables are just
  nodes.
- `children` is `Record<string, Node>`, keyed by an AGNOSTIC name (lowercase). The name is
  identity — a path segment for segment-dispatch; for method-dispatch HTTP ignores the name and
  uses the derived verb; CLI/MCP use the name as an identity. Names are the ONLY keyed namespace.

---

## Dispatch is by attribute; path is not special

- Every node dispatches its children by ONE attribute of the request. Path-segment is just the
  DEFAULT attribute, not a privileged one; method, header, content-type, query are peers.
- WHICH attribute a node dispatches its children on is a PROJECTION concern (projection meta,
  default = path-segment). Mark a node to dispatch its children by method → those children
  co-locate at the node's own path (a REST resource), HTTP picking among them by verb. A
  header-dispatch is the same mechanism with a different attribute.
- Multi-verb-same-path = a node whose children are method-dispatched: `read`/`replace`/`remove`
  share `/books/{id}`, distinguished by verb. It adds nothing to the tree shape — it's just a
  different dispatch attribute at that node.

---

## Verbs are never in the tree

- Verbs (`GET`/`POST`/…) never appear in the tree — they're uppercase HTTP vocabulary, meaningless
  to non-HTTP projections. The tree's keys are agnostic names.
- A handler's verb is DERIVED from its tags at BUILD time, used only by HTTP. Lattice:
  `readOnly→GET`, `idempotent∧¬readOnly∧¬destructive→PUT`, `idempotent∧destructive→DELETE`,
  else `POST`. Overrideable via `meta.http.verb`.
- Dispatch is COMPILED: at build, tags→verb resolved and the tree compiled into a lookup (path trie
  + a small method map at terminals, or method folded in as a final level). Runtime dispatch is a
  precomputed lookup — no tags touched, method as fast as path (tiny fixed keyspace).

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

## Verb helpers are verb+implied-tags BUNDLES

- `http.get`/`put`/`post`/`patch`/`delete` are NOT fn-wrappers and NOT bare verb-pins. Each is a
  metadata VALUE bundling the verb pin AND the behavioral tags that verb implies: `get`→`{readOnly}`,
  `put`→`{idempotent}`, `delete`→`{destructive, idempotent}`, `patch`/`post`→`{}` (plain mutation).
  Attached to a handler declaratively, next to the bare fn — the fn is never wrapped.
- Rationale: a bare verb-pin would be useless (equal to writing `verb:'patch'` yourself). Bundling
  the implied tags means picking a verb still lights up MCP hints / CLI confirm / gRPC idempotency
  — the reverse (verb→implied-tags) direction, as a convenience. Tags remain the source of truth;
  the helper sets both at once.

---

## Meta composition = deep-merge-with-precedence, never spread

- `meta` has nested sub-bags (`tags`, `http`, …). Composing metas (a verb-bundle + explicit tags +
  overrides; or inherited node tags + op tags) is a DEEP merge per sub-bag (union `tags`, union
  `http`), NOT object spread — spread shallow-clobbers nested sub-bags and silently drops tags.
- Precedence: later/explicit wins; `undefined` defers. This is the SAME three-valued closest-wins
  primitive as node tag-inheritance — one merge function reused for both inheritance-down-the-tree
  and helper-bundle composition.

---

## Projections

- Dispatching projections (HTTP, CLI): route one request → one leaf, via the compiled tree.
  Enumerating projections (MCP, OpenAPI, GraphQL): flatten all leaves → a surface. "Which attribute
  a node dispatches by" is meaningful only for dispatching projections; enumerators name
  method-dispatched children by their derived verb/role.

---

## What this supersedes

- `packages/core` node shape: `{ops, children, meta}` → `{handler?, children?, meta}` (ops removed).
- `packages/http` `buildRoutes`: per-op segments + flat table → the tree compiled as the router
  with attribute-dispatch; verb from tags at build.
- Tag storage/merge: ad hoc → `meta.tags` sub-bag composed by deep-merge-with-precedence.
- Adds: verb-helper bundles (`http.*`).
