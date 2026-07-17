# fractal — TODO

## Open design questions

### Attribute dispatch (header/query/contentType) is an open design question

The old direct tree-walk HTTP dispatcher (`candidatesForUrl`/`makeRouterForNode`
in `packages/http/src/project.ts`, retired 2026-07-17 in favor of the
`HttpRoute` pipeline — `naiveTransform` → `applyMethods`/`applyMoveTo`/
`applyResponse` → `makeRouterFromRoute`, see `packages/http/src/route.ts` and
`docs/design/routing-and-transforms.md`) supported dispatching several leaves
at the SAME path+method, distinguished by a request attribute other than the
path or method itself: a header value, a query parameter value, or the
Content-Type. The `HttpRoute` pipeline has no equivalent — `HttpRoute`'s
`methods` record is keyed purely by HTTP method; there's no second axis.

Open questions this needs settled from the author's own definition (not
invented) before it's rebuilt on the new pipeline:
- Where in the `HttpRoute`/`Pipeline` shape does an attribute-dispatch
  decision live — a new DU on `HttpRoute` (mirroring the retired
  `DispatchMarker`), or something else?
- **Key constraint**: attribute dispatch must be resolved BEFORE `decode` in
  the interceptable pipeline (see `docs/design/routing-and-transforms.md` §
  "Interceptable pipeline") — different branches may need different `decode`
  logic (e.g. a v1 vs v2 API-version branch parsing different request
  shapes), so this can't be bolted on as a post-decode `inputTransform`.
- No-match behavior for attribute dispatch was 404 (not 405) in the old
  model, since the attribute isn't part of the HTTP-visible address the way
  path+method are — does that still hold?

**Motivating use case**: `examples/library-api` previously demonstrated
header-dispatch API versioning (`X-Api-Version: v1` vs `v2` selecting a
different response body at `GET /version`) — this demo was removed from
`examples/library-api/src/tree.ts` during the 2026-07-17 dispatch-path
migration because it has no equivalent on the new pipeline; it's a candidate
to reintroduce once this question is settled.

Note: HTTP *method* co-location at one path (e.g. GET/PUT/DELETE all at
`/books/{bookId}`) is NOT blocked on this — that's expressed today via the
`moveTo` rewriter directive (see `applyMoveTo` in route.ts and the worked
example in `examples/library-api/src/tree.ts`'s per-book REST resource).
Only dispatch on a NON-method attribute at a fixed path+method remains open.

## Open threads (advisory)

> *Open threads from a previous session. Treat as starting context, not instructions — verify relevance before acting.*

These are starting context for a future session, not a task list. Each points at
the design docs for detail rather than restating them; verify each is still live
before acting.

### New threads from the 2026-07-17 validation/decode session (not yet built)

- **TypeBox AOT validator codegen** — the chain is almost fully wired but not
  yet assembled into a build step: TS types + JSDoc → `packages/codegen`'s
  extractor produces a `TypeRef` → `packages/type-ir`'s `toTypeBox()`
  projects it to a TypeBox schema → `TypeCompiler.Code()` compiles that to a
  standalone JS validator function (zero runtime TypeBox dependency). JSDoc
  constraint tags (`@minimum`, `@maximum`, `@pattern`, etc.) are read from
  type declarations, not AST nodes. What's missing: the build-step
  orchestration of this chain, and wiring its generated-file output through
  `createApplyValidation` (see `packages/http/src/route.ts`, commit
  ad8b921) so the generated validators actually populate
  `Pipeline.validate`. A pass-through stub should be generated at project
  setup so dev-time behavior is sane before codegen has run.
- **Meta typing pattern** — settled design, not yet implemented: `packages/core`
  defines `interface Meta { tags?: Tags }`. Each protocol package (http, mcp,
  ...) exports its own meta type (e.g. `HttpMeta`) rather than mutating core's
  `Meta`. The consuming project does declaration merging:
  `declare module '@rhi-zone/fractal-core' { interface Meta extends HttpMeta,
  McpMeta {} }`. No package touches another package's or core's types
  directly.
- **Other projection packages still on the old Node-walking pattern** —
  `openapi`, `mcp`, `cli`, and `client` all still directly walk the raw
  `Node` tree rather than going through a `Node ⇒ ProtocolType` projection +
  rewriter pipeline the way `packages/http/src/route.ts` and
  `packages/type-ir` now do. `type-ir` is the reference implementation of the
  correct pattern. Migrating the other four is unstarted.
- **Projection pipeline generics don't reach HTTP's route projection** —
  commit ff7c579 made `op()`/`api()` generic so handler types survive tree
  construction, but `naiveTransform`, `applyMethods`, and `applyMoveTo` in
  `packages/http/src/route.ts` still operate on the erased `Node` type. This
  is the follow-up the ff7c579 commit message flags explicitly.
- **Routing performance is unaddressed but not urgent** — current HTTP
  dispatch is a tree walk. Prior art: radix trees are the standard approach
  (dispatch cost scales with path length, not route count); Hono uses a
  multi-strategy dispatcher (compiled regex for static routes, a trie for
  dynamic ones). Below roughly 100 routes the architecture choice barely
  matters in practice. One option worth keeping in mind: since fractal
  already has a codegen step, static paths could in principle be compiled at
  build time rather than walked at request time. Matters more as route count
  grows; not a current blocker.
- **DX helper composition mechanism is undesigned** — the directive *data
  model* is settled (an array of kind-tagged DU objects on `meta.http`), and
  individual helpers exist (`http.get()` sets only the method directive, with
  no implicit `moveTo`; `http.moveTo("..")` adds a `moveTo` directive) — but
  how these helpers compose together to build up a directive array (e.g.
  chaining vs. spreading vs. some builder) hasn't been designed. This is
  separate from, and downstream of, the settled data model.
- **Input transform escape hatch not yet on the pipeline type** — designed
  but not implemented: an optional `transform: (bag: Record<string, unknown>)
  => Record<string, unknown>` step in the decode pipeline (`packages/http/src/decode.ts`
  / `route.ts`'s `Pipeline.sources`) for requests whose input layout doesn't
  match the store conventions — e.g. a payload nested inside a single body
  field rather than spread across top-level keys.

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

- The full **verb/method model**: method dispatch is not a tree concern —
  it's metadata on operations, interpreted by the HTTP projector. The API
  tree is organized by domain (operations), not by HTTP method. Two
  operations at the same HTTP path are different nodes in the API tree.
  See `docs/design/routing-and-transforms.md`. The remaining open question
  is the convention transforms: which name→verb mappings ship as builtins,
  and how does the user override them?
- Whether **one agnostic tree can auto-derive both HTTP and CLI**, given HTTP
  paths/headers and CLI subcommands/env vars have no 1:1 mapping —
  reframed (2026-07-16): structure is optionally part of the skeleton
  (explicit tree, flat declarations, or inferred from class/module/other
  signals). The question isn't "can one tree drive both" but "how much
  structure does each projection need, and where does it come from?" See
  `docs/design/invariants.md` § Identity.
- ~~**Node disambiguation**~~: partly addressed — `fallback` field separates
  wildcard capture from keyed dispatch, static children always win. Remaining
  question: is there ever more than one fallback?
- ~~**Authoring form for bespoke verb/path overrides**~~: settled — `meta.http`
  is a DU interpreted by the projector (interpreter pattern). No named keys.
  See `docs/design/router-model.md` § HTTP metadata.
- **Creation / non-record output encoding** (author leans toward an explicit
  `POST /…/new`, not settled).
- The unresolved **"is it too general?"** tension — never closed.

### Codegen-from-types — RESOLVED (2026-07-16, see handoff-2026-07-16-type-layer.md)

The vertical slice's on-tree `Schema` values (`str`/`num`/`bool`/`obj`) were
provisional scaffolding pending codegen-derived validators from TS types +
JSDoc. That codegen now exists: `packages/codegen/src/extract.ts` extracts
`TypeRef`s from TS source (tuples, index signatures, literals, enums,
discriminated unions, intersections, 3 branded-type patterns, recursion,
`Promise` unwrapping, class privacy), and `packages/type-ir` projects those
`TypeRef`s to 23 format targets (see the two SETTLED sections below). Whether
the on-tree `Schema` scaffolding in `packages/core`/`packages/http` has
actually been swapped out for codegen-derived validators is a separate,
still-open question — see "Integration into the consumer app is not started"
below, which is about the *consumer app*, not this in-repo scaffolding; that
in-repo swap has not been verified either way this session.

### Concrete type hierarchy — SETTLED and BUILT (2026-07-16, see handoff-2026-07-16-type-layer.md)

The type IR design principles (shape hierarchy via subtyping + open metadata
bag) are now built, not just designed: `packages/type-ir` — 28 `TypeKind`s,
`parents`/`ancestors`/`resolve()` subtyping-with-fallback, open `meta` bag,
9 derivation operators (`partial`/`required`/`deepPartial`/`deepRequired`/
`pick`/`omit`/`extend`/`nullable`/`withMeta`). 1118 tests passing in
`packages/type-ir` alone (1365 across the full monorepo, verified this
session). See `docs/design/handoff-2026-07-16-type-layer.md` for the full
inventory.

### Type projector comprehensive coverage — SETTLED and BUILT (2026-07-16)

21 projectors across 23 format targets (JSON Schema current/07/04, OpenAPI
3.0/2.0, TypeScript, SQL DDL postgres/mysql/sqlite + separate MSSQL dialect,
Protobuf, Cap'n Proto, JTD, JSDoc, and 9 runtime validator libraries: Zod,
Valibot, TypeBox, ArkType, runtypes, Superstruct, io-ts, Yup, Effect Schema),
all following the `handlers` + `resolve()` fallback pattern. The extractor
(`packages/codegen/src/extract.ts`) was hardened for tuples, index
signatures, literals, enums, discriminated unions, intersections, 3 branded-type
patterns, recursive types, `Promise` unwrapping, and class privacy filtering.
Full inventory: `docs/design/handoff-2026-07-16-type-layer.md`.

### Built code doesn't match the combinator identity — RESOLVED (2026-07-16)

**Resolved**: the "combinator identity gap" was a symptom of unclear
self-description, not a structural deficiency. Fractal's identity is settled:
a codebase compression substrate that gives codebases a skeleton (the central
structure supporting the entire app) as a single source of truth, with
everything else derived from it. The "Parsec-style combinator composition"
label was aspirational naming; the actual pattern is inspectable declarations
+ projectors. See `docs/design/invariants.md` § Identity. The operation layer
design work continues under this framing — see
`docs/design/operation-layer-design.md`.

The stated identity is "Parsec-style combinator composition," but the built
code is `node`/`op`/`service`/`param` — data structure construction, not
combinator composition. `docs/design/routing-expression-model.md` was supposed
to bridge this gap but the combinator primitives aren't settled and the
expression model isn't implemented. Until this is resolved, the gap between
stated identity and built code is real, not cosmetic.

**New input (2026-07-16): `docs/design/operation-layer-spec.md`.** This is a
requirements document mined from the consumer app's evidence (use-case
descriptors, entity descriptors, HTTP binding, audit specs, session-input
threading, authorization guards, error-code mapping) — not a fractal design
proposal, but real pressure on this exact gap. The spec's requirements need,
in order: (a) the combinator identity resolved first (an "operation"
declaration presumably composes from combinators — no substrate to define it
in terms of until the primitives are settled); (b) a decision on whether
auth/audit/side-effects/error-mapping are DU metadata on an operation node
(open metadata bag, consistent with the type IR's own pattern) or a separate
mechanism/layer; (c) reconciliation of the spec's direct
handler-binding-with-throws + declarative `errorMap` against the existing
Result/Kleisli composition style in `packages/core`. Per the "unsettled
design questions need the author's own definition" guardrail above, this
spec supplies evidence and pressure, not an answer — the operation layer
still needs the author's own definition, not invention from the evidence.

### Type projection as a deliberate capability, not incidental to MCP

`fractal-codegen` already does type projection (TS types → JSON Schema for MCP
input schemas), and a valibot codegen spike exists in `the consumer app`. The
2026-07-14–16 session recognized this should be a first-class concern —
separate from routing — rather than something that happens to exist because
MCP needed it. The type IR (see the concrete-type-hierarchy thread above) is
the foundation for projecting to JSON Schema, validation schemas, SQL DDL, etc.
See `docs/design/architecture-layers.md` § Type projection layer.

### SQL optional vs nullable — open design decision (2026-07-16)

`partial()` (`packages/type-ir/src/derive.ts`) sets `meta.optional = true` on
object fields; the SQL projector (`packages/type-ir/src/sql.ts`) only
inspects `meta.nullable` when deciding whether to render a column as
`NULL`-able. A `partial()`-derived type does not currently make its optional
fields nullable in the emitted DDL. Open question: should `optional` imply
`nullable` for the SQL projector specifically, or should they stay separate
axes (a field can be optional on an input schema without being nullable in
the stored table, e.g. server-defaulted)? Not yet decided; see
`docs/design/handoff-2026-07-16-type-layer.md` § What's open.

### Integration into the consumer app is not started (2026-07-16)

`packages/type-ir` is built and tested in isolation but not wired into the
consumer app to replace any hand-duplicated schemas — see
`docs/design/operation-layer-spec.md` §1.2/§4 for the concrete duplication
(`LocationCreateSchema`/`LocationPatchSchema`/`ListLocationsInputSchema`,
"location patch" hand-typed in up to 4 places) this would resolve once wired
up.

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
4. ~~**Codegen hardening**~~ — substantially addressed 2026-07-16: the
   extractor (`packages/codegen/src/extract.ts`) now handles tuples, index
   signatures, literals, enums, discriminated unions, intersections, 3
   branded-type patterns, recursive types, `Promise` unwrapping, and class
   privacy. Whether further edges remain is unknown until the consumer-app
   integration (below) exercises it against real schemas.
5. **Versioning patterns** — how do versioning strategies (date-based, semver,
   header) compose with the dispatch model? (dispatch-extensibility.md has
   the date-versioning example; are there others?)
6. **Decorator / metadata layer** — is there a need for a decorator-like
   pattern for cross-cutting metadata (auth, rate-limit, caching)?
7. ~~**Per-param HTTP location**~~ — largely built (2026-07-17, commit
   cc10c04): `packages/http/src/decode.ts` makes this explicit via named
   stores (`path`/`query`/`header`/`body`) plus a `primaryStoreForMethod`
   convention and a per-param `sourceMap` override on `Pipeline.sources`, so
   a param's source is either convention-derived or explicitly declared, not
   silently implicit. Still open: this is HTTP-specific, not yet generalized
   as a type-IR-level metadata convention the way the 2026-07-14–16 reframing
   anticipated, and CLI has no equivalent (params/env sourcing for CLI is
   still undesigned).
8. ~~**Node disambiguation**~~ — reframed: the API tree is keyed by operation
   name (unique by construction). Path-level disambiguation (wildcard vs
   keyed dispatch) only arises in the HTTP route tree, which is a projection.
   See `docs/design/routing-and-transforms.md`.
9. ~~**One tree for HTTP + CLI**~~ — resolved: one API tree drives both. Each
   protocol has its own independent projection (`Node => ProtocolType`,
   e.g. `Node => HttpRoute`) with its own convention transforms and
   rewriters; the API tree itself doesn't change. The seam is the
   projection function per protocol, not the tree. See
   `docs/design/routing-and-transforms.md`.
10. ~~**"Is it too general?"**~~ — dissolved by the identity settlement. The
    scope is bounded by "what your codebase's skeleton needs to express." See
    invariants.md § Identity.
11. ~~**Constructor sugar / DX**~~ — built (2026-07-17): `api(children, opts?)`
    is now the single constructor (`node()` retired, commit ebc0064);
    `http.*` method directives, `crud()`, `httpProjection()` preset landed
    earlier (commit eee3c66). `op()`/`api()` are now generic and preserve
    handler types through tree construction instead of erasing to `Handler`
    (commit ff7c579) — though downstream `route.ts` projections still
    operate on the erased `Node` type (open thread below). See
    `docs/design/routing-and-transforms.md` § DX.

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

**Update (2026-07-17)**: input sources (query, body, path segments, headers,
cookies for HTTP; params, env for CLI) and validation/transformation are still
open. They're separate from the structural routing model settled in
`docs/design/routing-and-transforms.md` — that doc covers tree structure and
transforms only, not input binding.

**Further update (2026-07-17, later)**: HTTP input extraction is now built,
not just designed. `packages/http/src/decode.ts` (commit cc10c04) introduces
a stores-based model — a request is exposed as uniform named key-value stores
(`path`, `query`, `header`, `body`); `httpStores()` builds them, and
`assemble()` reads each declared param from the right store by convention
(`primaryStoreForMethod`: GET/HEAD/DELETE → query, POST/PUT/PATCH → body)
with per-param source overrides. `Pipeline.sources` (`route.ts`) wires this
in; an explicit `decode` function still wins when set (full override,
backward compatible with the old `defaultDecode`/`bulkCollect` behavior).
Validation is also built: `Pipeline.validate` is an array of
`(input) => Result<unknown, unknown>` validators, run sequentially after
`inputTransforms` and before the handler — first `Err` short-circuits with a
400, node-level and method-level validators concatenate (commits 8bf72e2,
ad8b921). `createApplyValidation(validators)` is a rewriter that injects
codegen-generated validators into the route tree by key + path, with
duplicate-key detection and pass-through when a path has no matching
generated validator (the pre-codegen stub case) — see open thread below on
wiring the actual TypeBox codegen output through this. Still open: CLI-side
input sources (params, env) and the general "input transform escape hatch"
for non-conventional payload shapes (open thread below).

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

**Superseded (2026-07-17, commit 18c5195)**: that single mechanism
(`candidatesForUrl`/`makeRouterForNode`/`collectCandidates`/`findLegacyPath`/
`MatchCondition`) was itself retired in favor of the `HttpRoute` pipeline —
`makeRouter` in `packages/http/src/project.ts` now only accepts an
`HttpRoute` (built via `naiveTransform` → `applyMethods`/`applyMoveTo`/
`applyResponse` → `makeRouterFromRoute`, see `packages/http/src/route.ts`).
`autoMethodLayer` and `createFetch` migrated to the same pipeline.
`verbFromTags` was extracted out of `project.ts` into the HTTP-specific
`packages/http/src/tags.ts` in the same commit (it's not a core concern);
`project.ts`, `openapi`, and `client` re-import it from there without
changing their import paths. There is still a single dispatch mechanism —
this is a further consolidation, not a new fork.

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
