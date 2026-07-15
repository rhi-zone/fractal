# fractal — TODO

## Open threads (advisory)

> *Open threads from a previous session. Treat as starting context, not instructions — verify relevance before acting.*

These are starting context for a future session, not a task list. Each points at
the design docs for detail rather than restating them; verify each is still live
before acting.

### Design model is captured and authoritative in `docs/design/invariants.md`

The settled model was mined from the design conversation (with the original
author's verbatim words) into `docs/design/invariants.md`, and the next-session
handoff lives in `docs/design/handoff.md`. `docs/design/function-core-and-projection.md`
is fuller but partly superseded — on any conflict, invariants.md wins. invariants.md
also records 7 **guardrails** (things to NOT do — reified runtime meta, treating
input as "raw", leaking HTTP shape into the handler, Kleisli-as-base, losing the
single explicit tree, `create→POST`, forcing "data over code") that recurred as
mistakes. Worth reading those before proposing anything in this area.

### Unsettled design questions need the author's own definition, not invention

From invariants.md §open — these were explicitly left open and (per the guardrails)
should be settled FROM the author's definition rather than guessed:

- The full **verb/method model**: only "POST = a method call, not create" is
  settled; the `read→GET / replace→PUT / remove→DELETE / partial→PATCH`
  access-verb mapping was an *unconfirmed assistant proposal*, not part of the
  model. The author seemed to be leaning toward starting with the verb model
  first, but that's a lean, not a decision.
- Whether **one agnostic tree can auto-derive both HTTP and CLI**, given HTTP
  paths/headers and CLI subcommands/env vars have no 1:1 mapping — open and
  unreconciled.
- ~~**Node disambiguation**~~: partly addressed — `fallback` field separates
  wildcard capture from keyed dispatch, static children always win. Remaining
  question: is there ever more than one fallback?
- ~~**Authoring form for bespoke verb/path overrides**~~: settled — `meta.http`
  is a DU interpreted by the projector (interpreter pattern). No named keys.
  See `docs/design/router-model.md` § HTTP metadata.
- **Creation / non-record output encoding** (author leans toward an explicit
  `POST /…/new`, not settled).
- The unresolved **"is it too general?"** tension — never closed.

### Codegen-from-types is not yet built

The current vertical slice authors provisional runtime `Schema` values
(`str`/`num`/`bool`/`obj`) on the leaf as dispatch-time-validation **scaffolding**.
The intent is to replace these with codegen-derived validators, where the single
source of truth is the inferred TS types + JSDoc (not an on-tree schema). The
on-tree schemas should NOT be mistaken for the model — they're a placeholder until
codegen-from-types exists. See `docs/design/handoff.md` §"PROVISIONAL / to replace".

Update (2026-07-14–16 session): the type IR design is now settled at the
principles level — shape hierarchy via subtyping + open metadata bag, documented
in `docs/design/architecture-layers.md` § Type IR and in CLAUDE.md § Design
Philosophy. The next step is the concrete hierarchy (see new open thread below),
not further principle-level design.

### Concrete type hierarchy is the next step after the type IR principles

The type IR design principles are settled: shape hierarchy via subtyping + open
metadata bag (`docs/design/architecture-layers.md` § Type IR; also CLAUDE.md §
Design Philosophy). A survey of 12 type systems informing this is done —
`docs/design/type-ir-survey.md`. Not yet done: sketching the actual types and
their subtyping relationships. The hierarchy should reflect subtyping, not
taxonomy — every node must be a valid fallback target for projections (a more
specific node can always stand in for a more general one along the fallback
path).

### Built code doesn't match the combinator identity

The stated identity is "Parsec-style combinator composition," but the built
code is `node`/`op`/`service`/`param` — data structure construction, not
combinator composition. `docs/design/routing-expression-model.md` was supposed
to bridge this gap but the combinator primitives aren't settled and the
expression model isn't implemented. Until this is resolved, the gap between
stated identity and built code is real, not cosmetic.

### Type projection as a deliberate capability, not incidental to MCP

`fractal-codegen` already does type projection (TS types → JSON Schema for MCP
input schemas), and a valibot codegen spike exists in `the consumer app`. The
2026-07-14–16 session recognized this should be a first-class concern —
separate from routing — rather than something that happens to exist because
MCP needed it. The type IR (see the concrete-type-hierarchy thread above) is
the foundation for projecting to JSON Schema, validation schemas, SQL DDL, etc.
See `docs/design/architecture-layers.md` § Type projection layer.

### Dispatch extensibility model is settled in `docs/design/dispatch-extensibility.md`

The extensible dispatch model is settled: augmentable `DispatchKinds` interface,
batteries as plain matcher functions, declaration merging next to the tree,
projector takes a dictionary + tree. See `docs/design/dispatch-extensibility.md`
for the full model and pseudocode. Implementation: replace the closed
`DispatchMarker` union and hardcoded if/else dispatch in `packages/http/src/project.ts`.

Note: dispatchers/matchers are interpreters — degenerate (non-nested) case
of the interpreter pattern. The DU is the "AST", the projector does case
analysis. This reframing means ALL projection concerns (not just dispatch)
should follow the same DU + interpreter pattern. See `router-model.md`
§ HTTP metadata.

Reframed: the DU + matcher model is one implementation of the `match`
combinator in the routing expression model. See
`docs/design/routing-expression-model.md`.

### Migrate the fenced packages to the function-core model — RESOLVED (2026-07-11, commit 8e8329c)

The function-core rewrite (`docs/design/function-core-and-projection.md`) landed
as a vertical slice: `packages/core` + `packages/http` are rewritten to the new
model (function category + Result + Kleisli/applicative combinators; the
protocol-neutral D-tree `path`/`param`/`group`/`methods`/`route` + `app`; HTTP
dispatch + `Result`→`Response` encoding), proven by `examples/library-api` (the
`examples/spine-demo` name in earlier notes does not exist on disk — the actual
example directory is `examples/library-api`; `examples/todo-api` and
`examples/dogfood` also do not exist on disk).

Root `package.json` `workspaces` (verified 2026-07-11) is now:
`packages/core`, `packages/http`, `packages/mcp`, `packages/codegen`,
`packages/openapi`, `packages/cli`, `packages/client`, `examples/library-api`.
**Every package in `packages/` is in the workspace — none are fenced out.**
`packages/openapi` and `packages/client` were previously fenced but are back
in; `packages/mcp` and `packages/cli` are new packages not mentioned in the
original fencing note at all. `examples/library-api` imports
`@rhi-zone/fractal-mcp` and `@rhi-zone/fractal-codegen` directly, so at least
those two are active, not just present.

The open question this left — whether `openapi` and `client` had actually
been migrated to the function-core model, or were back in the workspace
un-migrated — is now closed: the coordinated refactor (commit 8e8329c) touched
`openapi`, `client`, `cli`, `codegen`, and `mcp` directly, updating each for
the `fallback` field and DU-based `meta.http` shape (and rewriting
`packages/client` as a self-contained enumerator mirroring `openapi`'s
pattern). All packages work with the new node shape now; `npm test`/typecheck
pass across all 8 workspaces (233 tests, 0 failures) per the commit.

---

## Design backlog (2026-07-10 session audit)

Ordered roughly easiest → hardest to decide:

1. ~~**Override authoring form**~~ — SETTLED (2026-07-10): `meta.http` is a DU
   interpreted by the projector (interpreter pattern), not named keys. `verb`,
   `segment`, `when` are retired as separate keys. See router-model.md
   § HTTP metadata.
2. **`readOnly` vs `safe`** — tag naming. `safe` aligns with HTTP semantics
   (RFC 9110 §9.2.1); `readOnly` is more intuitive but narrower.
3. **`openWorld` tag** — is it a tag, a meta field, or something else? What
   does it actually control?
4. **Codegen hardening** — the current spine infers schemas from TS types at
   build time; how robust is this, and what are the edges?
5. **Versioning patterns** — how do versioning strategies (date-based, semver,
   header) compose with the dispatch model? (dispatch-extensibility.md has
   the date-versioning example; are there others?)
6. **Decorator / metadata layer** — is there a need for a decorator-like
   pattern for cross-cutting metadata (auth, rate-limit, caching)?
7. **Per-param HTTP location** — where does each handler parameter come from
   (path, query, body, header)? Currently implicit; should it be explicit?
   Reframed (2026-07-14–16 session): this is understood as metadata
   conventions on the type IR / routing metadata, not a separate mechanism.
   Still open, but now scoped as an instance of the type-IR-metadata question
   rather than an HTTP-specific one.
8. **Node disambiguation** — with `fallback` separated from `children`, static
   children always win (keyed lookup); fallback fires only when no child
   matches. Remaining question: is there ever more than one fallback?
9. **One tree for HTTP + CLI** — can one tree drive both projections, or do
   they need separate trees? What are the seams?
10. **"Is it too general?"** — the perennial question. When does generality
    become a liability?

---

## Pending renames — DONE (2026-07-11, commit 8e8329c)

- `by` → `kind` rename on the HTTP dispatch marker discriminant landed in
  `packages/http/src/project.ts` as part of the coordinated refactor.

## Pending removals — DONE (2026-07-11, commit 8e8329c)

All four items landed in the coordinated refactor (commit 8e8329c,
"refactor: retire dispatch()/ParamNode/effectiveTags/buildRoutes for fallback
+ DU model"):

- `effectiveTags` / tag inheritance in `packages/core/src/tags.ts` — removed;
  replaced by the `mapNodes` pre-order/post-order tree-transform visitor. A
  node's tags are now exactly what's on the node.
- `ParamNode` type and `param()` constructor — removed; replaced by a
  `fallback?: { name, subtree }` field on `Node` (`children` is now
  `Record<string, Node>`). See `docs/design/router-model.md` § Node Shape.
- `buildRoutes` / `compile` / flat route table in `packages/http/src/project.ts`
  — removed; the projector dispatches directly on the tree at request time
  (`candidatesForUrl` + `makeRouter(node)`, O(depth)), with a small full-tree
  scan reserved for the `legacyPath` escape hatch only. See
  `docs/design/router-model.md` § No compilation step.
- `meta.http.verb`, `meta.http.segment`, `meta.http.when` as named keys —
  removed; replaced by DU variants (`meta.http.dispatch: DispatchMarker`,
  `meta.http.directives: HttpDirective[]`) with interpreter functions in the
  projector. See `docs/design/router-model.md` § HTTP metadata.
- `dispatch()` in `packages/core/src/node.ts` — removed along with its test
  (the dead protocol-neutral path-walking dispatcher flagged 2026-07-11 had no
  callers in production code). The "which mechanism wins" question this
  raised is moot now that both the core walker and the flagged
  `buildRoutes`/`makeRouter` duplication are gone — see Architecture gaps
  § Two divergent dispatch mechanisms below.

Downstream packages (`cli`, `mcp`, `openapi`, `client`, `codegen`) and
`examples/library-api` were updated in the same commit for the new
`fallback`/DU shapes. All packages' `npm test`/typecheck pass (8/8
workspaces, 233 tests, 0 failures) per the commit message.

---

## PUBLISH (after the model settles)

- Create `github.com/rhi-zone/fractal`, push, set pages/topics/homepage.
- Ecosystem docs-sync in `~/git/rhizone/github-io` — 7 touchpoints:
  1. `docs/about.md`
  2. `README.md`
  3. `docs/.vitepress/config.ts`
  4. `docs/index.md`
  5. `docs/projects/index.md`
  6. NEW `docs/projects/fractal.md`
  7. `~/git/rhizone/profile/profile/README.md`

---

## Architecture gaps (2026-07-11 session)

The gap between the abstract tree and a complete API projection is larger than
currently addressed. The tree says WHAT exists and HOW it's organized; the
projection fills in HOW TO TALK TO IT in a specific protocol. Key gaps:

### Input extraction

How to get `T` from a protocol request. Currently hardcoded in the HTTP
projector: merge path params + query params + JSON body. Should be pluggable
with reasonable defaults. Reasonable defaults first, decomposition into
primitives later — don't over-engineer upfront.

All extraction strategies are extensions (same mechanism as dispatch kinds —
shipped variants are not architecturally different from user-added ones).
The need for specific default strategies should be proven, not assumed.

Auth and caller-context (middleware concerns) collapse into input
extraction — auth credentials are just another input parameter sourced from
the protocol request. No special middleware layer needed. See
`docs/design/routing-expression-model.md`.

### Output formatting

How to turn `U` into a protocol response. Currently hardcoded: JSON + 200 OK.
Same approach as input: pluggable, reasonable defaults, decompose later.

### Protocol behavior

Protocol obligations that aren't business logic:
- HEAD (derive from GET response), OPTIONS (allowed methods), 405 — currently
  `autoMethodLayer`
- CORS — separate concern from the above (preflight, Access-Control-* headers)
- Content negotiation, error status mapping, etc.

### Middleware / cross-cutting

Auth, rate limiting, logging, caching. Not in the tree. Design backlog #6.

Auth collapses into input extraction. Rate limiting, logging, caching remain
as open questions — may also reduce to input extraction or may need their
own expression. See `docs/design/routing-expression-model.md`.

### SDK generation / Stainless NIH

Generating typed client SDKs directly from the tree (no OpenAPI intermediate).
The tree already has the structure and types that Stainless infers from OpenAPI.
`packages/client` proxy is a rough version of this. A natural projection.

### Projection-specific metadata is co-located, not external

Metadata that governs a node lives on the node (`meta.http.*`). Tree transforms
targeting specific nodes in a typesafe manner is impractical (fragile path
strings or heavy lens machinery). Each projection reads what it needs from meta;
other projections ignore irrelevant namespaces.

### Dispatch builtins are extensions, not a separate category

Method dispatch, header dispatch, etc. are DU variants + matchers shipped with
the package — same mechanism as user-added kinds. The architecture is uniform.
Note: the specific builtins shipped (method, header) were assumed from HTTP
convention, not derived from proven need. This may or may not be problematic.

Reframed by routing expression model: "which builtins earn their spot" falls
out of the expression language design, not from importing HTTP categories.
See `docs/design/routing-expression-model.md`.

### Two divergent dispatch mechanisms — RESOLVED (2026-07-11, commit 8e8329c)

`packages/core/src/node.ts` used to have its own `dispatch()` — a
protocol-neutral, path-segment-only tree walk (no method/header awareness) —
while `packages/http/src/project.ts` had `buildRoutes`/`makeRouter`, the one
actually wired into the HTTP projection. Both were removed in the coordinated
refactor: core's `dispatch()` was deleted outright (dead code, no production
callers), and HTTP's `buildRoutes`/`makeRouter(routes)`/`Route[]` were replaced
by direct tree-walk dispatch at request time (`candidatesForUrl` +
`makeRouter(node)`, O(depth)). There is now a single dispatch mechanism, not
two.

---

## Deferred (build when needed)

### WebSocket / MCP / CLI surface kits

The protocol-neutral D-tree is surface-agnostic at the core level. Additional
surface kits (WS, MCP, CLI) would follow the same projection pattern. Note the open
question above on whether one tree can drive both HTTP and CLI — that's a
prerequisite for the CLI kit. No design work started.

### Reactivity / streaming substrate

invariants.md notes the author wants a canonical stream construct (rejecting a
`Result<T,E> | Response` escape hatch). Live queries and reactive client bindings
would require a reactive client library to exist first.

---

## Pointers

- **Authoritative model: `docs/design/invariants.md`** (mined, verbatim; wins on conflict)
- **Next-session handoff: `docs/design/handoff.md`**
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
