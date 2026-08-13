# Subtree layers: per-branch middleware scoping via the meta channel

Status: **implemented** (project.ts's `HttpDirective` `middleware`/
`handlerMiddleware` kinds + `getHttpMeta` resolution, verbs.ts's
`http.middleware(...)`/`http.handlerMiddleware(...)`, compile.ts's
`collectRoutes` ancestor-chain composition threaded through `toRouter` and
all four built-in router compilers — `radixMatcher`, `compiledCharMatcher`,
`mapMatcher`, `mapCharRouter`). §9's two open questions are resolved below;
the FoldMeta array-shape hazard (§6/§7/§10.3) has a permanent regression test
(`subtree-layers.test.ts`), alongside subtree-scoping, nesting-order,
phase-ordering, and error-semantics coverage. `route.ts`'s
`makeRouterFromRoute` — an ALTERNATIVE router a deployment can select via
`PresetOptions.router`, not the default (`mapCharRouter` is) — is
DELIBERATELY OUT OF SCOPE, matching §5's own text ("every built-in router
compiler IN COMPILE.TS"): it does not apply subtree layers, a documented,
tested limitation (`subtree-layers.test.ts`), not a silent gap.
Scope: `packages/http-api-projector/src/{project,verbs,route,compile,preset}.ts`
(new `HttpDirective` kinds + `getHttpMeta` resolution + router-compiler
threading), zero changes to `packages/api-tree/src/node.ts` (core stays
protocol-blind — verified, not just claimed, §6). Sibling in kind to
`docs/design/meta-role-split-spec.md` and `docs/design/typed-store-spec.md`:
same "core declares the open, generic meta bag; a projector owns its own
namespaced fragment; core never sees a protocol name" shape, applied to a
capability (subtree-scoped request wrapping) fractal currently lacks
entirely.

**Revision note**: an earlier draft of this spec proposed a NEW core
mechanism — a generic `layers` slot on `Node` plus a `layered(layer,
subtree) → subtree'` combinator, with core defining nesting/composition
semantics and projectors only interpreting layer _content_. The owner
rejected that shape: **no new core attach slot, no new combinator.** A
wrapper belongs in the EXISTING meta channel, the same place `mcp.segment`
already lives — a branch-position (or leaf-position) member on a
projector-owned meta fragment (`HttpBranchMetaProperties`/
`HttpLeafMetaProperties`), read structurally by that projector's own walk.
This revision reflects that ruling throughout; §2 records why the rejected
shape and the accepted one both satisfy "value-attached, not
position-registered" (the invariant that survives from the original brief),
and §7 records a real, empirically-verified authoring-shape constraint the
meta-channel approach imposes that the rejected shape would not have had.

## 1. Motivation — grounded in code, not restated from a diagnosis

`PresetOptions.middleware` (`packages/http-api-projector/src/preset.ts:156-166`)
wraps the WHOLE compiled `Fetch` — read directly, `createFetch`'s
composition chain (`preset.ts:345-348`) applies every `middleware` entry
around `withContext` (the ALS-wrapped compiled router) before
`autoMethodLayer`/`corsLayer`, with no notion of "this entry only applies to
requests under branch X." `PresetOptions.handlerMiddleware`
(`preset.ts:168-184`) is the other existing hook — it wraps the HANDLER call
itself, `F => F` where `F = (input, stores) => result`, threaded into
`runRoute` (route.ts) — also global: every built-in router compiler
(`compile.ts`'s `toRouter`) applies the SAME `handlerMiddleware` array to
EVERY matched route (`toRouter`'s `runRoute(req, match.handler, match.meta,
match.sources, match.slugs, handlerMiddleware, ...)`, `compile.ts:67` — one
array, no per-route variation).

The sibling codebase's own `packages/fractal-support/src/rawRequest.ts` is the
motivating real consumer: `captureRawRequest` is a `PresetOptions.middleware`
entry that clones the incoming `Request` and reads its full body into a
`Buffer` on EVERY request that reaches the `Fetch` it wraps, so a webhook
leaf can verify a provider's HMAC signature over the exact pre-decode bytes
(`rawRequest.ts:8-45`, read in full). `docs/decisions/
one-root-fractal-tree-2026-08-02.md` §3.3/§7 (the sibling codebase) already names the
consequence directly, quoted: "Composing all 23 trees under one root Fetch
would make `captureRawRequest` apply to every request across the entire
merged surface — including curriculum's file-upload leaf and every other
slice's ordinary JSON traffic — cloning and buffering the full body on
requests that never need it... fractal has no existing mechanism to scope a
`PresetOptions.middleware` entry to one branch of a composed tree." That
doc's own §7 lists three unevaluated options, the third being "propose a
genuine per-branch-middleware capability to fractal upstream" — this spec is
that proposal.

Confirmed empirically (not assumed): `packages/http-api-projector/src/
compile.ts`'s `collectRoutes` (lines 96-116) walks an `HttpRoute` tree and
flattens it into `CollectedRoute { path, method, handler, meta, sources }` —
each entry carries only the matched LEAF's own `meta`; no ancestor-branch
information survives the flatten. Every router compiler (`radixMatcher`,
`compiledCharMatcher`, `mapMatcher`, `mapCharRouter`) builds its match
structure from this flat list, and `toRouter` (`compile.ts:55-69`) applies
ONE global `handlerMiddleware` array to whichever entry matches. There is
structurally nothing today a branch could declare that would reach only its
own descendants' dispatch.

## 2. Why the meta channel, and why this still satisfies "value-attached, not position-registered"

The invariant that survives from the original framing, restated precisely:
**a wrapper must travel with the node when the node moves**, never be
registered against a path pattern that lives separately from the tree. The
rejected precedent this guards against is documented at
`packages/api-tree/src/tags.ts:210-220`: the FORMER "closest-wins tag
inheritance" walk let a node's effective behavior depend on its ANCESTOR's
declared tags, resolved by tree POSITION at read time — "inheritance-by-
position breaks composability: moving a subtree would silently change its
behavior." `tags.ts`'s own fix was to make every tag exactly what's declared
ON that node, with `mapNodes` as the general "push a value down explicitly"
primitive for a caller that wants that shape deliberately, never an implicit
ancestor lookup.

The meta-channel design honors this exactly: a branch (or leaf) declares its
own `meta.http.directives` entries (via `http.middleware(...)`/
`http.handlerMiddleware(...)`, §3) on ITS OWN node — an ordinary `api()`
call's `opts.meta`, or an `op()` contribution — no different in kind from
`mcp.segment` (a branch-position field mcp-api-projector already reads
structurally during its own walk, per `meta-role-split-spec.md` §4's table)
or `http.moveTo` (leaf-or-branch, resolved relative to the node's OWN
position). Moving the branch value to a different parent moves its
`meta.http.directives` with it, unchanged — no separate registry, no path
string authored apart from the node. What makes this "not inheritance" in
the sense `tags.ts` rules out: **no node ever reads an ANCESTOR's meta.**
Composition happens at the PROJECTOR's own compile-time tree walk (§4) —
the same mechanism that already threads `moveTo`'s relative-path resolution
and `mcp.segment`'s prefix-building through the tree structurally, not a
runtime ancestor-lookup a leaf's own handler could see or depend on.

This also means the rejected `layered()`/core-attach-slot shape and the
accepted meta-channel shape are EQUIVALENT on the one property that
actually mattered (value travels with the node) — the owner's objection was
never that `layered()` failed that property, but that it required a NEW
core mechanism (a generic slot, new composition semantics core would have
to own) where an EXISTING, already-precedented mechanism (a projector's own
namespaced meta fragment, read structurally by that projector's own walk)
already suffices and keeps core at zero protocol knowledge.

## 3. Shape — new `HttpDirective` kinds, not a bare meta field

**Authored via the existing directive-array convention, never a bare
function-valued meta field.** This is not a style preference — §7's
`[verify]` finding is that a bare (non-array) function-valued property
folded across two `op()` meta contributions loses its call signature at the
type level. The `source` directive (`project.ts:107-117`, quoted in full
here because it is the exact precedent this design follows) already
documents the sibling class of this problem and its fix: _"Deliberately a
directive — appended to the array — rather than a plain merged object...
Arrays dodge it entirely: `MergeMetaValue`'s array branch concatenates
without recursing into elements."_ Two new `HttpDirective` variants, added
to the DU at `project.ts:155-178`:

```ts
export type HttpDirective<...> =
  | ... // existing variants unchanged
  | { readonly kind: "middleware"; readonly value: (inner: Fetch) => Fetch }
  | { readonly kind: "handlerMiddleware"; readonly value: HttpHandlerMiddleware }
```

(`Fetch`/`HttpHandlerMiddleware` are the SAME types `PresetOptions.middleware`/
`PresetOptions.handlerMiddleware` already use — layers.ts's `Fetch`,
route.ts's `HttpHandlerMiddleware` — no new type, only a new place to attach
a value of a type that already exists.)

New `verbs.ts` helpers, matching `http.source()`'s own shape (one directive
per call, `directives` array element, not a merged object):

```ts
export function middleware(...fns: readonly ((inner: Fetch) => Fetch)[]): {
  readonly http: { readonly directives: readonly HttpDirective[] };
};
export function handlerMiddleware(...fns: readonly HttpHandlerMiddleware[]): {
  readonly http: { readonly directives: readonly HttpDirective[] };
};
```

`getHttpMeta` (`project.ts:242-...`) gains a THIRD resolution shape,
alongside its existing "last-wins scalar" (`method`, `verb`, `moveTo`) and
"collect-and-merge" (`sourceMap`) shapes: **collect every `middleware`/
`handlerMiddleware` directive in the resolved `directives` array, in array
order, into `resolved.middleware: readonly ((inner: Fetch) => Fetch)[]` /
`resolved.handlerMiddleware: readonly HttpHandlerMiddleware[]`** —
structurally identical to how `sourceMap` is already collected from every
`source` directive (`project.ts:114-117`: "resolves the array of `source`
directives into a single `sourceMap` field, in array order"), substituting
"compose into an ordered wrap list" for "merge keys with later-wins."

`HttpSharedMetaProperties`/`HttpLeafMetaProperties` (`project.ts:192-224`)
each gain the two resolved fields — `middleware`/`handlerMiddleware` are
valid at BOTH leaf and branch position (a leaf can scope a wrapper to just
itself; a branch scopes it to its whole subtree), so both land on
`HttpSharedMetaProperties`, the same interface `moveTo` already lives on.

## 4. Two phases, kept genuinely distinct

### 4a. Dispatch-around (`http.middleware(...)`) — protocol-PHASE wrapping

Wraps at the SAME point `PresetOptions.middleware` wraps today: BEFORE
`runRoute` — before decode, before `sources.validate` runs, before the
handler is ever called. This is the phase `captureRawRequest` needs
(`rawRequest.ts`'s own doc: the clone must happen before `defaultDecode`'s
body-consuming parse). A subtree-scoped `middleware` entry does everything
`PresetOptions.middleware` does, at the granularity of "requests whose
matched leaf sits under this declaring node," never the whole tree.

### 4b. Handler-around (`http.handlerMiddleware(...)`) — protocol-agnostic wrapping of the leaf call

Wraps `F = (input, stores) => result`, the SAME shape `PresetOptions.
handlerMiddleware` already threads into `runRoute` — AFTER decode (and any
`sources.validate` Standard Schema check), BEFORE the handler runs, seeing
the assembled input and the raw pre-assembly stores. This phase is the one
genuinely protocol-agnostic piece: CLI's `CliOpts.middleware` and MCP's
`CreateMcpServerOptions.middleware` (referenced in `preset.ts:172-176`'s own
doc) already provide the identical handler-scoped hook for their own
protocols — a subtree-scoped `handlerMiddleware` on `HttpLeafMeta`/
`HttpBranchMeta` is HTTP's own instance of a pattern each projector would
declare independently (§8), never a shared core mechanism (core still never
sees "handler-around" as a concept — each projector's own meta fragment
names it in that projector's own vocabulary).

### Relation to `mapNodes`

`mapNodes` (`tags.ts:236-251`) is the general PRE-ORDER TREE-TRANSFORM
primitive: `(tree, fn) => tree'`, visiting every node once, producing a NEW
tree with `fn` applied per node. A caller COULD already hand-write "wrap
every leaf under this branch's handler with X" as a `mapNodes` pass that
rewrites `node.handler` — and this is not hypothetical: `wrapValidators`
(`build.ts`) and `wrapScopes` (the sibling codebase's `scopes.ts`) are both exactly this
shape, a recursive walk rewriting every leaf's handler. What `http.
handlerMiddleware`/`http.middleware` ADD beyond what a bespoke `mapNodes`
pass already does:

- **Ordering guarantees relative to the REST of the pipeline.** A hand-rolled
  `mapNodes` pass runs whenever its author calls it — nothing enforces where
  in `createFetch`'s stage list (validators → projection → rewriters →
  router → als → middleware → autoMethodLayer, `preset.ts`'s own module doc)
  it executes relative to decode/validation. `handlerMiddleware`'s wire
  point (inside `runRoute`, after decode/validate, before handler) and
  `middleware`'s wire point (before the router even matches) are FIXED by
  where `runRoute`/`toRouter` read the resolved directive lists — a
  subtree's author declares WHAT to wrap with, never WHERE in the pipeline
  it runs, which is exactly what a hand-rolled pass cannot promise without
  re-deriving `createFetch`'s own stage ordering itself.
- **Composability with phase (b) without hand-coordinating two walks.** A
  bespoke `mapNodes` pass rewriting `handler` directly can only express
  handler-around wrapping — it has no access to the pre-decode `Request`
  (phase (a)'s whole reason to exist), because by the time ANY `Node`-level
  transform runs, there is no `Request` yet; decode happens per-protocol,
  downstream of the `Node` tree entirely. `middleware`'s directive lives on
  the SAME node as `handlerMiddleware`'s, and the router compiler (§5)
  resolves both from the same walk — a subtree author composes both phases
  through one declaration site instead of splitting the concern across a
  `Node`-level transform (for one phase) and something else entirely (for
  the other, which `mapNodes` cannot reach).
- **A typed, protocol-aware context.** `handlerMiddleware`'s `F` signature
  (`(input, stores) => result`) and `middleware`'s `Fetch` signature are
  real HTTP-specific types (`HttpStoreBag`, `Request`/`Response`) a
  hand-rolled `mapNodes` pass over the generic `Node`/`Handler` type has no
  access to — `mapNodes` operates before any protocol has resolved what a
  "handler call" even receives.

`mapNodes` is NOT superseded or duplicated by this design — it remains the
general primitive for "rewrite every node a certain way," and this spec's
mechanism is implemented USING it in one place (§5's `resolveDirectiveChain`
is itself expressible as, though not necessarily literally built from,
`mapNodes`-shaped recursion over `HttpRoute`). The two coexist the way
`wrapValidators`/`wrapScopes` (bespoke `mapNodes`-shaped passes, run once,
globally, over a whole tree) coexist with per-subtree declarative meta
today (`meta.scopes` itself, read per-leaf by `wrapScopes`'s walk) — this
spec adds the SAME "declare on the node, let the walk compose it" shape for
middleware that `scopes` already has for authorization.

## 5. Composition mechanism — ancestor-chain resolution at router-compile time

`collectRoutes` (`compile.ts:96-116`) must change from flattening
`{path, method, handler, meta, sources}` to ALSO threading the ordered list
of ancestor branches' resolved `middleware`/`handlerMiddleware` past to the
leaf, so each `CollectedRoute` carries its own fully-composed wrap chain:

```ts
function collectRoutes(
  route: HttpRoute,
  segs: readonly string[],
  ancestorMiddleware: readonly ((inner: Fetch) => Fetch)[],
  ancestorHandlerMiddleware: readonly HttpHandlerMiddleware[],
): CollectedRoute[] {
  const { middleware = [], handlerMiddleware = [] } = getHttpMeta(route.meta);
  const mw = [...ancestorMiddleware, ...middleware];
  const hmw = [...ancestorHandlerMiddleware, ...handlerMiddleware];
  // ...each method entry ALSO composes its own (leaf-position) directives on top of `mw`/`hmw`...
  // ...recursive calls into children/fallback pass `mw`/`hmw` down...
}
```

**Ordering (owner-specified, precise): outer wraps inner.** The root's own
`middleware` entries (if any) sit OUTERMOST, then each descending branch's
own entries wrap progressively tighter around the leaf, matching
`PresetOptions.middleware`'s existing convention ("first entry is the
outermost wrapper," `preset.ts:156-166`) — a branch's own array is composed
in ARRAY order (first entry outermost WITHIN that branch's own
contribution), then the whole per-branch chain is composed root-to-leaf
(earliest-declared/outermost ancestor's chain wraps around each
descendant's). Concretely, for `root(mwR) → admin(mwA) → webhooks(mwW) →
leaf`, the leaf's final dispatch is `mwR[0](mwR[1](...mwA[0](...mwW[0]
(...leaf...)...)...))` — reduce with `reduceRight` exactly the way
`createFetch`'s own `(opts.middleware ?? []).reduceRight(...)`
(`preset.ts:345-348`) already composes its flat array, just seeded per-leaf
with the CONCATENATED root→leaf chain instead of one global array.

Each `CollectedRoute`'s pre-composed `mw`/`hmw` is then applied at the
per-route dispatch this compiler already builds (`toRouter`'s `runRoute`
call, `radixDispatch`'s returned `RouteMatch`, the generated char-matcher's
per-route branch) — a COMPILE-TIME cost (walking the tree once, same as
`collectRoutes` already does), not a per-request cost: `mapCharRouter`'s
static `Map`/dynamic char-fn still dispatch in the same O(1)/O(matched-path)
time they do today, now to a per-route handler that is ALREADY the fully
composed `mwR[0](...(leaf's runRoute call)...)` closure, built once at
compile time. **`middleware` wraps `runRoute` itself for that one route**
(not the whole `Fetch` before matching) — this is what gives it subtree
SCOPE without a per-request path-prefix string check: only requests that
MATCH a leaf under the declaring branch ever reach that branch's composed
wrapper, because matching happens first and each match's dispatch is
pre-wrapped for exactly its own ancestor chain. For webhooks specifically,
this means `captureRawRequest`, scoped to the `webhooks` branch, still runs
BEFORE that leaf's own decode (same requirement `rawRequest.ts` states) —
it now also runs strictly AFTER the router has matched the request to a
`webhooks`-subtree leaf, which is stronger than today's global placement
(today's `PresetOptions.middleware` runs on EVERY request, including a 404;
a subtree-scoped one only runs on requests that actually reach that
subtree) and does not change the byte-capture semantics `rawRequest.ts`
depends on (the clone still happens before `runRoute`'s own decode call for
that route).

This is a real, load-bearing implementation change to every built-in router
compiler in `compile.ts` (`radixMatcher`, `compiledCharMatcher`,
`mapMatcher`, `mapCharRouter`) — each currently discards ancestor
information at `collectRoutes` time; this spec requires each to carry the
per-route composed chain through to wherever it currently calls `runRoute`.
Not designed to the byte here (an implementation-order question, §9), but
the MECHANISM (compile-time ancestor-chain composition, applied once per
leaf, zero added per-request cost beyond calling through however many
wrapper closures that leaf's own chain has) is certified as sound by the
above trace through `collectRoutes`/`toRouter`'s actual current code.

## 6. `[verify]` — empirically checked this session, in scratch, deleted after

Per the coordinator's specific ask: **function-valued meta members are new**
(every existing meta value has been JSON-serializable data — strings,
booleans, arrays of directive DU values). Checked directly against real
code (`packages/api-tree/src/__scratch_verify__/` and `packages/
http-api-projector/src/__scratch_verify__/`, created and deleted this
session, never committed), not reasoned about from memory.

### Extractor / `walkNodeType` — CONFIRMED inert

`extractRouteTypeRefs` (`tree.ts`) run against a real `op()`/`api()` tree
whose leaf meta carried `{ http: { middleware: [fn] } }` (via the open
index-signature widening every meta value already gets, `node.ts`'s
`Widen<T>`) produced the correct input/output `TypeRef`s, untouched by the
function-valued member — confirmed by running it, not just reading the
code. This holds STRUCTURALLY, not by luck: `walkNodeType` (`tree.ts:195-
285`) only ever reads `children`, `handler`, `fallback`, and two SPECIFIC
literal-string keys off `meta.mcp` (`name`/`segment`, via `mcpMetaOverride`,
which itself bails to `undefined` on any non-string-literal type,
`tree.ts:152-167`) — it has no code path that enumerates `meta.http`'s
contents at all, so a new member there is invisible by construction, not by
this spec's discipline.

### Validator/schema codegen (`build.ts`) — CONFIRMED inert

`wrapValidators` run against the same tree (with a real generated-entry map
for the one leaf) completed without error and returned a working wrapped
handler. `build.ts`'s own leaf walk (per its module doc, `build.ts:1-20`
region) keys off `meta.tags.unvalidated` and the caller-supplied
per-path `GeneratedEntry` map — neither reads `meta.http` at all.

### `HttpManifest<N>`/`TreeManifest<N>` type computations — inert by construction, not independently re-run

Not re-verified via a fresh scratch `tsc` repro this session (flagged, not
overclaimed) — but the code-level reasoning is direct: `HttpManifest<N>`
(`http-manifest.ts`) computes PATH from tree shape + `moveTo` directives,
and METHOD from `meta.http.directives`' FIRST `{kind:"method"}` entry
(module doc, `http-manifest.ts:8-21`) — a purely STRUCTURAL, kind-tagged
pattern match over the `directives` tuple's DU members, never a generic
enumeration of `meta.http`'s keys. A `{kind:"middleware", value: fn}` entry
added to that same tuple is simply never matched by the `{kind:"method"}`/
`{kind:"moveTo"}` conditional-type patterns `HttpManifest` already runs —
inert for the identical structural reason the extractor is.

### `listRoutes`/`toOpenApi` — CONFIRMED, no leakage into the document

`toOpenApiFromRoute` run (at runtime, via `bun run`) against an
`httpProjection`-projected route whose leaf meta carried `{ http: {
middleware: [fn] } }` produced a valid OpenAPI document
(`{"openapi":"3.1.0",...}`, checked directly) whose serialized JSON does
NOT contain the substring `"function"` anywhere — confirmed by string
search on the actual output, not inferred. `openapi.ts`'s own per-operation
field reads (`operationId`, `summary`, `deprecated`, `security`, …, per
`meta-role-split-spec.md` §4's table) destructure NAMED fields off the
resolved `HttpLeafMetaProperties`, never spread or `JSON.stringify` the
whole bag — a function sitting in an unread field is inert the same way an
unread `sourceMap` entry already is today.

### `FoldMeta`/`mergeMeta` — REAL BREAK FOUND on a bare (non-array) function member, confirmed via scratch `tsc`; the array-authored shape is unaffected

Two scratch checks, both against real `op()`/`FoldMeta` code (not a
simplified stand-in):

1. **Array-valued member (the shape §3 mandates)**: `op(fn, { http: {
middleware: [mw1] } }, { http: { middleware: [mw2] } })` — the folded
   type's `middleware` member type-checked cleanly against `readonly
((inner: Fetch) => Fetch)[]`. `MergeMetaValue`'s ARRAY branch
   (`node.ts:177-180`) fires first (both sides are tuples), concatenating
   `readonly [mw1, mw2]` — the function values inside the array are never
   individually merged as "objects," only the array itself is spread.
2. **Bare (non-array) function member — BREAKS**: `op(fn, { http: { onError:
mw1 } }, { http: { onError: mw2 } })` — the folded type's `onError`
   member does **NOT** type-check against `(inner: Fetch) => Fetch`
   (`FoldedOnError extends (inner: Fetch) => Fetch ? true : false` evaluated
   to `false`, confirmed by a deliberate `true`-vs-`false` type mismatch
   diagnostic). Forcing TypeScript to print the unevaluated type showed it
   stuck as `MergeTwoMeta<(inner: Fetch) => Fetch, (inner: Fetch) => Fetch,
[unknown, unknown]>` — i.e. `MergeMetaValue` took the OBJECT-merge branch
   (`A extends object`, `node.ts:181-189`) for a bare function member,
   because a function type structurally satisfies `extends object` in
   TypeScript. `MergeTwoMeta`'s own mechanism (`Omit<A, keyof B> & Omit<B,
keyof A> & {...mapped over keyof A & keyof B...}`, `node.ts:213-231`) is
   built from MAPPED TYPES (`Omit`/`Pick`), which structurally strip a call
   signature — `keyof` a plain function type is empty, so every piece of the
   intersection reduces toward `{}`, losing callability. (A value was still
   ASSIGNABLE into the broken type — `{}` accepts any object including a
   function — which is why this only shows up as "not callable," not as an
   assignment error; the diagnostic that actually catches it is the
   `extends (fn-type) ? true : false` check, not a plain assignment.)

**This is the real argument the owner asked to surface, not paper over —
and `project.ts`'s own `source`-directive doc comment (§3, quoted above)
already independently discovered the SAME class of hazard for a different
field shape (`Record<string,ParamSource>` index signatures) and fixed it
the identical way.** The finding does not indict the meta-channel design as
a whole; it fixes WHICH authoring shape is safe: **a function-valued meta
member MUST be authored as (or resolved into) an array, appended-to via a
directive-per-call convention, never declared as a bare single-value field
that two separate `op()` contributions could both set.** §3's design
already follows this (directive-array authoring, `getHttpMeta`
collect-into-array resolution) — this `[verify]` result is WHY that shape is
mandatory, not incidental, and is recorded in the regression checklist
(§10.4) so a future edit doesn't "simplify" `middleware`/`handlerMiddleware`
back into a bare field.

## 7. Interaction with the rest of the machinery

### wrapScopes / caller-context resolution

`docs/decisions/one-root-fractal-tree-2026-08-02.md` §3.2 (the sibling codebase) found
that its 18 `resolve<Slice>CallerContext` functions collapse to ONE shared
resolver plus a small per-branch DECLARATIVE table (which marker scope a
session of a given role grants) — real variation was almost entirely
data (a table), not control flow, with three named exceptions
(`approvals.ts`'s `actorId` field choice, `hiring.ts`'s public-fallback
scope, `push.ts`'s broader role check — §3.2, quoted in that doc). **Could
per-subtree caller-context resolution become a `middleware`/
`handlerMiddleware` layer under this spec's mechanism?** Structurally,
yes — `PresetOptions.als.init` (which resolves `CallerContext` today, via
`callerContextStorage`, the sibling codebase's `callerContext.ts`) is currently GLOBAL
in the exact same way `PresetOptions.middleware` is, and a subtree-scoped
`middleware` entry could set a DIFFERENT ALS value for its own subtree
(structurally identical to how `captureRawRequest` already populates a
SEPARATE ALS, `rawRequestStorage`, scoped to the request, from inside a
`middleware` entry). **This spec does NOT recommend making that move now**,
for a reason specific to the one-root-tree finding, not a general objection:
the real variation is a small DECLARATIVE TABLE keyed by role, which
`meta.scopes` (a plain data field, already required per-leaf per
`meta-role-split-spec.md` §7) is a more direct fit for than a per-subtree
FUNCTION — a table entry composes with `wrapScopes`'s existing per-leaf walk
with no new resolution-order question, where a `middleware`-based resolver
would introduce ONE MORE ancestor-composed function chain (per §5) sitting
alongside `wrapScopes`'s own separate global wrap, without a clear account
of which one wins when both could theoretically set `CallerContext`. §9
leaves this open for the owner rather than deciding it here — the honest
finding is "mechanically possible, not the recommended migration target
given the actual variation this spec's own grounding evidence shows."

### Validators — ordering is preserved, not bypassed or reordered

`middleware` (dispatch-around) resolves and runs strictly BEFORE `runRoute`
begins — before decode, before `sources.validate` (`http.validate()`'s
Standard Schema check, run inside `runRoute`, route.ts) ever executes; this
is UNCHANGED from `PresetOptions.middleware`'s existing wire point, just
narrowed to a subtree. `handlerMiddleware` (handler-around) resolves and
runs at the SAME point `PresetOptions.handlerMiddleware` already runs today
— inside `runRoute`, strictly AFTER decode and `sources.validate`, before
the handler — again unchanged in ORDER, only in SCOPE. Neither phase gives a
subtree author a way to skip or reorder `wrapValidators`'s AOT-generated
`parse()` (which wraps the handler itself, upstream of ALL of this, at
`createFetch`'s `workingNode` step, `preset.ts:317-322`) or `sources.
validate`'s Standard Schema check — both continue to run at their existing
fixed points regardless of what any subtree declares.

### Extraction / codegen / IR cache

Covered exhaustively in §6: the extractor is TYPE-LEVEL (walks a source
file's resolved TYPES via the checker, `tree.ts`'s own module doc,
lines 3-18), never touches a runtime meta VALUE at all, and its only reads
of `meta`'s CONTENTS are two named string-literal keys under `meta.mcp` —
structurally blind to anything under `meta.http`. `docs/design/
ir-keyed-cache-spec.md`'s leaf-fingerprint mechanism (§6 of that spec) keys
on a leaf's resolved input/output `TypeRef` alone — `middleware`/
`handlerMiddleware` never enter a leaf's input/output type (they're meta,
not part of the handler's own signature), so a subtree gaining or losing a
layer changes NO leaf's IR fingerprint — no spurious cache invalidation.

### `listRoutes`/OpenAPI — route surface unchanged

Confirmed in §6 (`toOpenApiFromRoute` run against a layered tree): the
document's `paths`/`operationId`/method set is IDENTICAL to what an
unlayered tree with the same shape produces — `middleware`/
`handlerMiddleware` change WHAT WRAPS a matched leaf's dispatch, never
WHICH leaves exist or what path/method they're reachable at. `listRoutes`
(`openapi.ts:393-410`, called internally by `toOpenApi`) walks the same
`HttpRoute` tree `collectRoutes` (§5) does, reading `path`/`method`/`meta`
per entry — the NEW ancestor-composed `mw`/`hmw` fields this spec adds to
that walk's internal bookkeeping are additively threaded through, never
substituted for the fields `listRoutes` already reads.

### tree-lint — no new position dependence

`docs/design/tree-lint-spec.md`'s collision rule (§3e, source-text
fingerprint of `node.handler`) and its own regression checklist (§9(3))
both hinge on: a moved subtree must not silently change identity or
behavior by virtue of NEW tree position. Under this spec, a branch's
`meta.http.directives` (including any `middleware`/`handlerMiddleware`
entries) travels WITH the branch value when it's moved — §2 already
establishes this is exactly what "value-attached, not position-registered"
guarantees. What DOES change when a layered branch is moved is which
ANCESTOR chain it composes with (§5's root-to-leaf composition is a
function of the NEW parent's own declared layers) — this is not a
regression tree-lint's own scope covers: tree-lint's collision rule
compares HANDLER identity/source-text and PATH across trees, never
middleware composition, and no existing fractal mechanism (moveTo's
relative-path resolution included) promises that a moved subtree's
COMPOSITION WITH ITS NEW ANCESTORS stays constant — only that the subtree's
OWN declared meta does. A subtree moved under a NEW parent that also
declares `middleware` will correctly pick up that parent's wrapping, exactly
as it should (an author moving a leaf under `admin` should expect it to gain
whatever `admin` declares) — this is the intended, structural composition
this spec's whole mechanism exists to provide, not an accidental
position-dependence of the kind `tags.ts`/tree-lint's regression list rules
out (which is specifically about a node's OWN behavior changing from
identical declared meta, never about deliberate ancestor composition a node
opts into by where its author places it).

## 8. Phase vocabulary beyond HTTP — projector-owned, not designed here

Per the "core is blind, protocol-specific layer types are projector-owned
inert exports" doctrine (`meta-role-split-spec.md` §2's "every projector
exports inert plain interfaces... never wrapped in a `declare module`
block," applied here to `HttpDirective`'s two new kinds, which live entirely
in `http-api-projector`, never in core): an MCP or CLI analogue of
dispatch-around/handler-around is each of THOSE projectors' own call to
make, in their own vocabulary, on their own `McpLeafMeta`/`CliLeafMeta`
fragments — HTTP's `before-decode`/`after-decode-before-handler` split does
not obviously map onto MCP's tool-dispatch or CLI's arg-parse pipeline
one-for-one (MCP has no "raw body" concept the way an HTTP `Request` does;
CLI's closest analogue to "before decode" would be before `argv` parsing).
This spec designs HTTP's own two phases to the byte (§3-§5) and states the
GENERAL shape other projectors would follow (a directive-array-authored,
branch/leaf-position meta member, resolved into an ordered wrap list,
composed root-to-leaf at that projector's own compile step) without
prescribing MCP's or CLI's concrete phase names — that is real,
un-scoped-here future work (§9).

## 9. What this spec does not decide — open questions, both now closed

- **CLOSED by owner ruling: per-subtree caller-context resolution stays OFF
  this mechanism, for now.** §7's analysis stands (mechanically possible, a
  `middleware` entry populating a different `AsyncLocalStorage` value per
  subtree) but the owner's call is to NOT migrate onto it — declarative
  extension of `meta.scopes` is the chosen direction for caller-context
  resolution, matching the one-root-tree finding's own evidence (a small
  per-role declarative table, not per-subtree control flow). Not implemented
  as part of this spec; a future, separate, consumer-side (deployment-level)
  piece of work.
- **SUPERSEDED 2026-08-02 — see below.** This bullet originally closed the
  question by ruling that a subtree layer's throw must match its EXISTING
  global counterpart's throw, phase for phase — which meant a `middleware`
  throw (dispatch-around, either scope) stayed UNCAUGHT, since that was the
  global `PresetOptions.middleware` behavior at the time. The owner
  subsequently revisited that call for maximal consistency: an uncaught
  middleware throw was the one pre-decode path that didn't produce an
  encoded `Response` like every other error path in this package, which is
  itself an inconsistency worth closing. **CLOSED by owner ruling
  (2026-08-02): a `middleware` throw — subtree-scoped or global — is now
  CAUGHT and run through `thrownErrorEncoder`, identically to a
  `handlerMiddleware` throw**, instead of propagating uncaught:
  - `PresetOptions.middleware` (dispatch-around) still wraps OUTSIDE the
    compiled router entirely, in `createFetch`'s own composition chain,
    OUTSIDE `runRoute`'s try/catch — but `createFetch` now wraps that
    composed chain in its own try/catch, encoding a throw via the same
    `encodeThrownError` helper (route.ts) `runRoute`'s catch block uses.
    No route context (`meta`/path) is available at that point — a
    pre-decode, pre-route-match throw can't be, since matching hasn't
    happened yet — but `ThrownErrorEncoder`'s signature never took route
    context anyway, so nothing is lost or fabricated; the encoder just
    sees the raw error, same as every other call site.
  - `PresetOptions.handlerMiddleware` (handler-around) is UNCHANGED: wraps
    INSIDE `runRoute`, around the handler call, INSIDE the try/catch —
    caught and encoded via `thrownErrorEncoder` exactly as before.
    §5's mechanism composes subtree `middleware` OUTSIDE each route's
    `runRoute` call (`toRouter`, compile.ts — now wrapped in its own
    try/catch, since matching HAS already happened by the time subtree
    middleware runs) and subtree `handlerMiddleware` INSIDE `runRoute` (via
    the SAME `handlerMiddleware` parameter `runRoute` already threads a global
    array through, unchanged) — so both phases now funnel through
    `encodeThrownError` identically, matching their own global counterpart
    exactly, per phase: a subtree `middleware` throw is caught and encoded
    (same as global); a subtree `handlerMiddleware` throw is caught and
    encoded (same as global, same as before). Never silent, no special
    channel. Permanent regression tests: `subtree-layers.test.ts`'s "error
    semantics" `describe` block, `preset.test.ts`'s middleware-throw tests.
- **Cross-protocol phase vocabulary** (§8) — MCP/CLI/JSON-RPC/GraphQL
  analogues of dispatch-around/handler-around are each that projector's own
  future design, not specified here.
- **RESOLVED by implementation: all four `compile.ts` router compilers were
  edited together, in one pass**, sharing one `collectRoutes` (the ancestor-
  chain composition) and one `toRouter` (the per-request wrap-and-dispatch) —
  `radixMatcher`/`radixDispatch`, `compiledCharMatcher`'s codegen'd object
  literal, and `buildMapMatcher` each carry `middleware`/`handlerMiddleware`
  through their own `RouteMatch` construction identically. No sequencing
  question remained once `CollectedRoute` grew the two fields.

## 10. Regression checklist

Any future edit to this spec, or its implementation, MUST NOT reintroduce:

1. **A new core (`api-tree`) attach slot or combinator for layers.** The
   owner explicitly rejected this shape (§0/§2) in favor of the existing
   meta channel — core stays at zero protocol knowledge, unchanged from
   today (verified: no edit to `node.ts` is in this spec's scope at all).
2. **Ancestor-position INHERITANCE at read time** — a node's own behavior
   depending on an ancestor's declared meta the way the REMOVED closest-wins
   tag walk did (`tags.ts:210-220`). §5's ancestor-CHAIN COMPOSITION at
   router-COMPILE time is not this: it composes explicitly-declared,
   value-attached wrap lists via the projector's own walk, never has a leaf
   read an ancestor's `meta` directly, and moving a subtree correctly
   changes which ancestors it composes with (§7's tree-lint analysis) — a
   deliberate, structural property, not the implicit-lookup hazard `tags.ts`
   removed.
3. **A bare (non-array) function-valued meta member.** §6/§7's empirically
   confirmed break: `FoldMeta`/`MergeTwoMeta`'s mapped-type merge strips a
   function's call signature when two `op()` contributions both set the same
   bare-function key. `middleware`/`handlerMiddleware` MUST stay
   directive-array-authored (§3), matching the `source` directive's own
   established precedent for the identical class of hazard.
4. **A runtime path-string check standing in for structural composition.**
   §5's mechanism composes each leaf's wrap chain from its ACTUAL ancestor
   ARRAY, walked once at compile time — not a `req.url.startsWith(branchPath)`
   runtime check (one of the un-evaluated options
   `one-root-fractal-tree-2026-08-02.md` §7 names and this spec does NOT
   adopt). A future "simplification" that replaces compile-time ancestor
   composition with a runtime path-prefix test reintroduces exactly the
   "path-pattern registration, disconnected from the node" shape the
   original brief's constraint (and `tags.ts`'s own precedent) rules out.
5. **Changing the route surface.** `middleware`/`handlerMiddleware` must
   never add, remove, or rename a path/method `listRoutes`/`toOpenApi`
   reports (§6/§7, confirmed empirically for a representative tree) — a
   future change that lets a layer influence routing (as opposed to only
   wrapping dispatch to an already-determined route) is out of this spec's
   scope and would need its own design.
6. **Reordering or bypassing validation.** §7: `middleware` stays strictly
   before `runRoute` (before decode/`sources.validate`); `handlerMiddleware`
   stays strictly inside `runRoute`, after decode/validate, before the
   handler — a future change letting either phase run AFTER the handler, or
   letting `middleware` observe/mutate the ALREADY-VALIDATED input,
   collapses the two phases back into one and defeats §4's whole reason for
   keeping them distinct.
