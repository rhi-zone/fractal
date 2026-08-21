# Tree lint: cross-tree analysis over composed/mounted `Node` trees

Status: **design spec, proposed — not yet implemented.** Doc only; no code
in this pass. Scope: a new package, `packages/tree-lint/`
(`@rhi-zone/fractal-tree-lint`), that runs analysis rules over a SET of
already-built `Node` trees — the trees a deployment actually mounts, not a
single tree in isolation. First rule: cross-tree collision detection. Sibling
in kind to `docs/design/meta-role-split-spec.md` and
`docs/design/typed-store-spec.md` — same "deployment owns composition, core
package stays inert/generic" shape, applied to a NEW capability (analysis)
instead of a type-surface split.

## 1. Motivation: the incident this spec exists to prevent

Grounded directly in the consumer repo, `the sibling codebase`
(`apps/web/src/server/api-fractal/accounting.ts`'s own module doc, read
verbatim, not summarized from memory):

Two independently-authored fractal trees —
`apps/web/src/server/api-fractal/accounting.ts` and
`apps/web/src/server/api-fractal/tax-compliance.ts` — each wrapped the SAME
three `taxCompliance.useCases.*` calls (`listNexusCrossings`,
`addSellerRegistration`, `reconcileRegistrations`), mounted at two different
base paths (`/api/accounting/nexus-*` and
`/api/admin/tax-compliance/nexus-*` respectively, via
`apps/web/src/server/buildApp.ts`'s two separate `app.mount(...)` calls).
`accounting.ts`'s own doc calls its copy "a byte-identical duplicate of
`tax-compliance.ts`'s own tree." This went undetected across multiple
migration passes (`accounting.ts`'s own "RESOLVED 2026-07-31" module-doc
section: a prior pass believed the `/api/accounting/nexus-*` path could be
freely deleted, found a real client dependency instead, and only then — as a
SEPARATE, later pass — resolved the duplication itself on 2026-07-31, by
migrating the client to the surviving path and deleting the copy).

**Why fractal's own machinery didn't catch it.** `mergeRoutes`
(`packages/http-api-projector/src/route.ts`) throws on a same-method+same-path
conflict — but only for method/path collisions WITHIN one route tree being
assembled by one `applyMoveTo`/`insertAt` walk. At the time of the incident,
each `serveX(composed)` in the sibling codebase independently produced a
`Fetch` (`packages/fractal-support/src/fetch.ts`'s `createThe sibling codebaseFetch`),
and `buildApp.ts` mounted each `Fetch` at its own base path via a separate
`app.mount(...)` call — by the time two trees were both live, they were two
opaque `Fetch` closures at two disjoint mount points, with no shared data
structure a check could walk to notice the two closures served the same
operation.

The sibling codebase has since composed ALL of its fractal trees into one
root (`docs/decisions/one-root-fractal-tree-2026-08-02.md`, now implemented,
not just proposed): `buildFractalRootTree`
(`apps/web/src/server/lib/fractalRootTree.ts`) nests every slice's
`build<Slice>Tree(composed)` output — `accounting` and `admin["tax-compliance"]`
included — as a branch of ONE composed `Node`, served by a single
`serveFractalRoot(composed)` mounted once
(`app.mount("/api", serveFractalRoot(composed))`) in place of the old
per-slice mounts. Because `mergeRoutes` now runs across that one composed
walk, a literal same-path collision between two slices throws at compose
time — a real gain the old per-slice-mount shape didn't have.

This does NOT close the gap that let the accounting/tax-compliance
duplication through, though — confirmed by that same migration's own
"effects on existing checks" analysis: `mergeRoutes` only rejects same-PATH
collisions, and two DIFFERENT paths serving the same underlying operation
(exactly this incident's shape) stays invisible to it, one root or many.
Every slice's `Node` is now reachable in one place —
`buildFractalRootTree`'s own composed return value — but nothing walks that
structure comparing sibling branches' leaves against each other for a
duplicated operation; if anything, one root makes that walk EASIER to add
than the old many-opaque-closures shape did, since the trees are already
assembled rather than needing to be gathered from many separate mount
sites.

This is the gap tree-lint is scoped to close: given the SET of trees a
deployment is about to mount (or already mounts), find operations that
appear more than once — at any path, in any tree — before that duplication
survives to production undetected, the way this one did.

## 2. Where tree-lint lives, and why: the owner-certified placement

Fractal's own design precedent (`meta-role-split-spec.md`,
`typed-store-spec.md`) draws a hard line: **core (`api-tree`) declares
shapes and stays behavior-blind; a projector package walks a tree for ONE
protocol's own purpose; the deployment owns composition.** Tree-lint is
none of the three existing roles:

- Not core (`api-tree`) — core's job is the `Node`/`Meta` SHAPE and the
  `op()`/`api()` constructors; it has never contained a walk that produces
  a diagnostic, only walks that produce another tree (`mergeMeta`,
  `detach`) or a derived value a caller asked for. A collision-detection
  walk is analysis, not shape.
- Not a projector (`http-api-projector`, `mcp-api-projector`, …) — every
  existing projector's tree walk exists to PROJECT one tree into one
  running surface for one protocol (`docs/design/function-core-and-projection.md`'s
  "pure function over the composed service" framing, which the sibling codebase's own
  CLAUDE.md independently re-derives as "a projection is a pure function
  over the received composed service ... anything a projection appears to
  build for itself is either part of composition or the run verb itself").
  Tree-lint's job — comparing N already-built trees against EACH OTHER — is
  neither "run this one tree" nor a per-protocol concern; a collision is
  language-agnostic (an HTTP tree, an MCP tree, and a CLI tree built from
  the same `op()` leaves could ALL exhibit the identical underlying
  duplication, and the check that finds it never needs to know which
  protocol eventually renders any of them).
- **Is** a new sibling package: `packages/tree-lint/`
  (`@rhi-zone/fractal-tree-lint`), depending only on `api-tree`'s `Node`
  type (no projector import), taking a set of already-built trees as input
  and returning findings. This mirrors `type-ir`'s own role in the
  workspace — a package that CONSUMES the tree/type shape core defines and
  performs analysis over it, producing diagnostics, not a projected running
  surface — rather than either of the two existing roles being stretched to
  cover a third job.

## 3. Leaf identity: what makes two leaves in different trees "the same operation"

This is the load-bearing design question. Every candidate below is evaluated
against the ACTUAL incident code (`accounting.ts`'s now-deleted nexus-*
leaves vs. `tax-compliance.ts`'s surviving ones, and `accounting.ts`'s
surviving leaves — e.g. `getPnlLeaf`, in `buildAccountingTree` — for what a
typical leaf's `handler` looks like), not a hypothetical.

### 3a. Handler reference equality — REJECTED as primary, sound but empirically defeated

The structurally strongest possible signal: if `node.handler` for two
leaves in two different trees is the SAME function object
(`===`), they are provably the same operation — no ambiguity, no false
positive. `isLeaf` (`packages/api-tree/src/node.ts`) already tests
`n.handler !== undefined`, so a walk collecting `(path, node.handler)` pairs
per tree needs no new machinery to compare handlers by reference.

**Why it fails on the real incident.** Read directly:
`accounting.ts`'s `getPnlLeaf` is
`op(async () => { const result = await accounting.useCases.getPnl(); ... },
http.post, {...})` — a FRESH anonymous closure authored inline at this call
site, not a reference to `accounting.useCases.getPnl` itself. Every leaf in
both `accounting.ts` and `tax-compliance.ts` follows this same shape (`op(async
() => { const result = await taxCompliance.useCases.listNexusCrossings(); ...
}, ...)`, `tax-compliance.ts`'s `nexusCrossingsLeaf`) — the wrapping closure exists to
translate the use case's `Result<T,E>` into the tree's `ok()`/`err()`
envelope, a translation every migrated leaf performs, per
`docs/artifacts/fractal-migration-2026-07/plan.md`'s established pattern
(read in the sibling codebase, not fractal, but the shape recurs identically across every
`api-fractal/*.ts` file). Two independently-authored files that each write
this wrapper closure around the SAME underlying use case produce two DIFFERENT
function objects — `===` is `false` between them even though they are
byte-identical in source. **This is not a corner case of the incident; it is
the exact and only case this rule needs to catch, and reference equality
provably cannot catch it**, because the whole reason a duplicate leaf exists
is that a second author wrote a second closure rather than importing the
first tree's `Node`.

Reference equality remains WORTH CHECKING as a zero-cost, zero-false-positive
supplementary signal (it catches the narrower case of a shared `buildXLeaf()`
helper function or an accidentally-mounted-twice `Node` object — a real,
simpler mistake, distinct from the incident but cheap to also catch on the
same walk), but cannot be the PRIMARY signal because its false-negative rate
on the motivating case is total.

### 3b. `meta.http.sourceMap` — REJECTED, near-zero coverage on the real corpus

`meta.http.sourceMap` (the `Sources.sourceMap` field,
`packages/http-api-projector/src/route.ts`; populated by `http.source()`
directives, resolved per-leaf by `sourceMapOf`) records how a handler's
PARAMETER NAMES map onto
HTTP stores (query/body/path) — it is a decode-time routing concern, not a
provenance or identity marker. Two concrete problems, both verified against
the actual accounting/tax-compliance leaves rather than assumed:

1. **It is absent on the overwhelming majority of leaves, including every
   leaf involved in the incident.** None of `accounting.ts`'s thirteen
   leaves (every leaf built in `buildAccountingTree`) call `http.source()` —
   the ones
   that take input either take none (`getPnl`, `getArAging`, …) or validate
   the whole body positionally (`recordExpenseLeaf`, `valibot`-parsed).
   `tax-compliance.ts`'s three nexus leaves are the same. An `undefined`
   `sourceMap` on both sides of a real duplicate carries zero discriminating
   information — comparing "absent" to "absent" cannot distinguish this pair
   from any other pair of parameterless leaves in the whole deployment.
2. **Where present, it describes the wire shape, not the operation.** Two
   UNRELATED leaves that both happen to take a single `id` path parameter
   would have IDENTICAL `sourceMap` shapes despite being entirely different
   operations — the signal has real false-positive risk in the cases where
   it isn't simply absent.

Not recommended even as a secondary signal — it answers "how is this leaf's
input decoded," a question orthogonal to "is this the same operation as that
other leaf."

### 3c. Declared meta name (e.g. `openapi.operationId`, a hypothetical `meta.opId`) — the durable fix, but not available today

If every leaf carried an explicit, author-declared, STABLE identity string —
`openapi.operationId` is the closest existing field
(`HttpLeafMeta`'s `openapi.operationId`, per-operation,
`meta-role-split-spec.md` §4's http-api-projector table) — two leaves sharing
that identity across trees would be an unambiguous, cheap, false-positive-free
signal, and (unlike source-text fingerprinting, §3e) it SURVIVES a reformatting
or trivial refactor of the wrapping closure, which a text-based signal does
not.

**Why it isn't the primary recommendation.** Verified by reading every leaf
in `accounting.ts` and `tax-compliance.ts`: NONE of them declare
`openapi.operationId`, or any other author-supplied identity field, today.
Recommending a signal with ~0% coverage on the exact corpus that produced
the incident this spec is written to prevent would leave the motivating case
undetected by the very rule meant to catch it. This is real future work
(§8), not a rejected idea — the natural sequel to landing rule-checking is a
SEPARATE, follow-on decision to require an identity field (mirroring how
`meta-role-split-spec.md` §7 turned `scopes` from optional to required once
its own machinery existed to enforce it) — but it cannot be this spec's
PRIMARY recommendation because it checks nothing on the codebase's current
state.

### 3d. Path shape (trailing segment name, structural similarity) — REJECTED as primary by definition, kept as a low-confidence corroborating heuristic

Path CANNOT be a primary signal for cross-tree duplication, because the
incident's whole defect was two DIFFERENT paths serving the same operation
— any rule anchored on path similarity is answering a different question
("do these look like they're about the same resource") than the one that
actually matters ("do these DO the same thing"). It is also noisy in both
directions: `nexus-crossings`/`nexus-register`/`nexus-reconcile` (the real
duplicate's trailing segments) are distinctive enough to be a plausible
corroborating hint, but a generic trailing segment (`list`, `get`, `sync`)
recurs across many genuinely unrelated slices' trees and would produce
constant false positives if trusted as anything more than a hint.

Recommended only as a LOW-CONFIDENCE secondary tier (§4c) — surfaced
alongside a higher-confidence finding to help a human triage it faster
("these two also share a path segment"), never raised as a finding on its
own.

### 3e. Handler source-text fingerprint — RECOMMENDED PRIMARY signal

`Function.prototype.toString()` on `node.handler` returns the handler's
authored source text (for non-minified `.ts`/`.js` executed directly by
Bun/Node, which is how tree-lint is scoped to run — §5). A normalized
fingerprint (strip comments and insignificant whitespace, then hash) of two
leaves' handler source text, compared across trees, is:

- **Verified to catch the actual incident.** `accounting.ts`'s own module
  doc states its now-deleted nexus-* leaves were "byte-identical" to
  `tax-compliance.ts`'s surviving ones — that is a claim ABOUT the source
  text made by the codebase's own migration record, not an inference of
  this spec's. A byte-identical duplicate is a source-text-fingerprint
  MATCH by construction; this is the one signal that is confirmed, on the
  motivating case's own documented evidence, to have actually caught it.
- **Available today, no authoring convention change required.** Every leaf
  already has a `handler` function; no new field, no new discipline. This
  is the decisive advantage over §3c.
- **Honestly fragile, and the spec says so rather than overselling it.**
  A cosmetic difference — a renamed local variable, a reformatted line, an
  inline comment one author added and the other didn't — breaks an exact
  match. It does NOT catch a duplicate that was refactored even trivially
  after being copy-pasted, and it does not catch a duplicate that was
  independently re-derived from the same use case without ever being
  literally copied. It is a copy-paste detector, not a semantic-equivalence
  detector — the same honest limitation any AST/text-diff-based duplication
  tool (jscpd and similar) carries, not a defect specific to this design.
- **Low false-positive risk in practice, because it's gated on the closure
  body actually differing per operation.** Two DIFFERENT operations'
  wrapping closures differ at minimum in which
  `composed.<slice>.useCases.<method>` they call — verified across every
  leaf read in this pass, no two leaves share call text unless they are
  genuinely wrapping the same call. A trivial shared boilerplate skeleton
  (`async () => { const result = await X(); if (result.kind === "err")
return err(result.error); return ok(...) }`) recurs across leaves, but `X`
  and the final `ok(...)` shape are what's being fingerprinted along with
  the skeleton — normalizing whitespace/comments does not erase the actual
  differing tokens.

**Recommendation: source-text fingerprint is the PRIMARY (high-confidence)
signal, handler reference equality is a supplementary zero-cost
zero-false-positive check run on the same walk, and path-segment similarity
is a low-confidence corroborating hint attached to findings from either of
the first two — never a standalone finding.** §3c's declared-name approach
is the recommended DIRECTION for a future, stronger check once the
authoring convention exists to support it (§8), not part of this spec's
implementable surface.

## 4. Rule shape

### 4a. What a rule is

A rule is a plain function over the full set of mounted trees, returning a
list of findings — no base class, no rule-object protocol beyond "takes the
input, returns findings":

```ts
// packages/tree-lint/src/rule.ts

export interface MountedTree {
  readonly basePath: string;
  readonly tree: Node;
  /** Free-form label for where this tree came from — e.g. "accounting",
   *  matching the slice/file it was built in — surfaced in findings so a
   *  human can jump straight to the source, never consulted by rule logic
   *  itself (rules reason about `basePath`/`tree`, never about labels). */
  readonly label?: string;
}

export interface Finding {
  readonly rule: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly locations: readonly { basePath: string; path: readonly string[]; label?: string }[];
}

export type LintRule = (trees: readonly MountedTree[]) => readonly Finding[];
```

`collisionRule` (§3, §4c) is one such function, exported by the package as
its shipped default. Running lint is applying a list of rules to one input:

```ts
export function runTreeLint(
  trees: readonly MountedTree[],
  rules: readonly LintRule[] = [collisionRule],
): readonly Finding[] {
  return rules.flatMap((rule) => rule(trees));
}
```

### 4b. Where "the set of all mounted trees" comes from

**Not an ambient registry — an explicit array the caller assembles**,
matching every other cross-tree assembly point in this design lineage
(`typed-store-spec.md` §4's single-shot `serviceStores` registration site;
the sibling codebase's own CLAUDE.md "select adapters ... by direct import + direct
injection at the deployment root, never a central catalog/registry" —
independently arrived at, same shape).

This premise needs a note the original investigation didn't have: the
sibling codebase has SINCE composed every slice's tree into one root
(§1's "why fractal's own machinery didn't catch it," `buildFractalRootTree`
in `apps/web/src/server/lib/fractalRootTree.ts`) — so, unlike when this
section was first written, every `build<Slice>Tree(composed)` output IS
already collected in one place today, each nested at the branch key
matching its URL segment (`accounting: buildAccountingTree(composed)`,
`admin: api({ ..., "tax-compliance": buildTaxComplianceTree(composed), ... })`,
and so on for every other slice). What `buildFractalRootTree` does NOT do is
hand back a labeled array a lint rule could iterate by origin — it returns
one merged `Node`, assembled for SERVING (one `wrapScopes`/`wrapAudit`/
validation pass), not for cross-branch analysis. So a `MountedTree[]` still
needs to be built explicitly for tree-lint's purpose, but building it is now
simpler than it would have been pre-one-root: a caller can reuse the SAME
`build<Slice>Tree` imports `buildFractalRootTree` already makes, pairing
each with the branch key it's already nested at there, rather than needing
to gather them from many separate mount call sites.

Two call shapes follow from this, both legitimate, differing only in WHEN
"the set" is assembled and what `composed` it's built against:

- **Boot-time (loud):** the composition root (`fractalRootTree.ts`, wherever
  it already constructs one real `ComposedSurface`) additionally builds the
  array `[{ basePath: "/accounting", tree: buildAccountingTree(composed) },
{ basePath: "/admin/tax-compliance", tree: buildTaxComplianceTree(composed) },
...]` — one entry per `build<Slice>Tree` import `buildFractalRootTree`
  already makes, trivially derivable by pairing each import with the branch
  key it's already nested at in that same file's composed `api({...})` call
  — and passes it to `runTreeLint`, throwing (or logging loud, per the
  deployment's own choice, mirroring `typed-store-spec.md` §"§8's runtime
  boot/wire-time coverage check" — precedent: `checkRouteSourceCoverage`,
  called once from `makeRouterFromRoute`, collects every problem into ONE
  thrown error rather than failing on the first, `typed-store-spec.md`'s
  status block) before the app finishes booting, ahead of
  `serveFractalRoot`'s own single `app.mount("/api", ...)` call.
- **Standalone CI command:** the same array, built by a small script that
  constructs trees WITHOUT a live `composed` — collision detection only
  needs tree STRUCTURE (paths, `meta`, `handler` source text via
  `toString()`), never actually INVOKES a handler, so a fake/stub
  `ComposedSurface` (every slice's `useCases` methods present as no-op stubs
  satisfying the type, matching the pattern already established by
  `accounting.ts`'s own module doc, the paragraph preceding
  `buildAccountingTree`'s definition: "verified via a standalone smoke
  script ... driving `buildAccountingTree` against a real
  `createAccounting(...)` instance" — a REAL instance was used there because
  that script was verifying WIRING correctness end to end, a stronger bar
  than lint needs) suffices to build every `buildXTree(stub)` call and run
  lint against the result in CI, with no database, no credentials, no
  network. This is the natural home for a `bun run lint:tree-collisions`
  script in the sibling codebase, callable in CI without booting the real app.

Both paths call the SAME `runTreeLint` — the loud/boot-time path and the CI
path differ only in how `trees` gets built and what happens to the findings
(throw vs. exit-code), never in the rule logic itself. Tree-lint itself
(the package) prescribes neither path; it exports `runTreeLint` and the
default rule set, and leaves the call site (the sibling codebase's composition root
and/or CI script) to the deployment, matching every other "deployment owns
composition" precedent in this design lineage.

### 4c. Collision rule's finding shape

Two confidence tiers, per §3's signal ranking:

- **`error`, high confidence**: two or more leaves across DIFFERENT trees
  (different `basePath`) whose `handler` source-text fingerprints match
  (§3e), OR whose `handler` is reference-identical (§3a) — the latter case
  additionally worth a distinct message ("mounted twice," not "duplicated
  authorship") since its likely cause (a shared `Node`/leaf constant
  imported into two trees, or the same tree accidentally mounted at two
  base paths) differs from a copy-paste duplicate's likely fix.
- **`warning`, low confidence**: two leaves across different trees with NO
  fingerprint/reference match but a shared trailing path segment (§3d) —
  surfaced as a hint for human triage, never blocking, never escalated to
  `error` on its own.

A same-tree, same-path+method collision is explicitly OUT of this rule's
scope — `mergeRoutes` (§1) already throws on that, loud, at tree-assembly
time, before tree-lint would ever see two leaves at the identical
`(basePath, path)`. Tree-lint's collision rule targets exactly the gap
`mergeRoutes` cannot see: same operation, different `(basePath, path)` pairs,
across different trees.

## 5. Extensibility: open function list, not a registry — matching `tags.ts`'s own precedent

`packages/api-tree/src/tags.ts` establishes the pattern this package follows
for its own "more than one of these, some standard, more addable" surface:
`Tags` is an OPEN bag (arbitrary consumer keys legal), `resolveTags`
computes a fixed lattice over a small set of WELL-KNOWN keys the package
ships as named constants (`TAG_READ_ONLY`, `TAG_IDEMPOTENT`, …), and a
consumer is free to add their own tag keys the resolver simply doesn't
special-case. Tree-lint's rule list follows the identical shape:

- `LintRule` (§4a) is a plain function type, not a closed union or a
  string-keyed registry entry — the exact reason: nothing "resolves" a
  rule from a runtime string a caller holds (the sibling codebase's own CLAUDE.md draws
  this line explicitly for its own composition choices: "use open-key
  descriptor registries only for runtime-dynamic dispatch — a value
  resolved at runtime from a string a caller holds ... reserve closed
  unions for genuinely-fixed primitives"). A rule list is assembled
  STATICALLY by whoever calls `runTreeLint` — passed as a plain array
  argument, the same shape `op()`'s meta-contribution rest parameter or
  `httpErrorEncoder`'s override map already use elsewhere in this codebase
  lineage — never looked up by name at dispatch time.
- The package ships ONE standard rule (`collisionRule`) as a named export,
  the way `tags.ts` ships `TAG_READ_ONLY` etc. as named constants — not a
  closed enum of "the rules," just the one rule this spec designs plus
  whatever a consumer appends to their own array. A second rule (§8 lists
  live candidates) is added the same way any future well-known TAG is
  added to `tags.ts`: a new named export, appended to the caller's own rule
  list, no change to `LintRule`'s shape or to `runTreeLint`.
- A consumer-authored custom rule (e.g. the sibling codebase wanting a
  the sibling codebase-specific check — "every admin-only leaf declares
  `requireAdminSession`," say) is just another `LintRule`-shaped function
  in the same array, exactly as legal as the shipped one. No plugin
  system, no rule-name string, no separate registration call — the
  function IS the registration.

## 6. What is explicitly NOT in scope

Tree-lint is cross-tree ANALYSIS over already-VALID trees — it is not a
second implementation of checks that already run, loud, at a different
point in the pipeline, over a SINGLE tree's own internal wiring:

- **`wrapValidators`/input-schema coverage** — whether a leaf's declared
  input keys are actually satisfiable by some store, already checked
  wire-time by `checkRouteSourceCoverage` (`typed-store-spec.md`'s status
  block; `packages/http-api-projector`'s `route.ts`, called once from
  `makeRouterFromRoute`, collecting every problem into one
  `SourceCoverageError`). Tree-lint does not re-derive this — it operates
  across trees, this check operates within one tree, at a point in the
  pipeline tree-lint's own trees-array assembly (§4b) happens no earlier
  than.
- **`wrapScopes` coverage / required-scope enforcement** — whether every
  leaf declares `meta.scopes` at all (the sibling codebase's own
  `meta-role-split-spec.md` §7 consumer story: `scopes` moving from
  optional to required is a TYPE-LEVEL compile error, not a lint finding —
  a scope-less `op()` call fails to typecheck before tree-lint would ever
  run). Tree-lint is a runtime/CI check over built trees; a compile-time
  requiredness flip is a stronger, earlier gate for the same class of
  defect and this spec does not duplicate it.
- **Same-tree, same-path method collisions** — `mergeRoutes` (§1, §4c)
  already throws on this, loud, at `applyMoveTo`/`insertAt` assembly time,
  strictly earlier in the pipeline than tree-lint's own "trees are already
  built" starting point.
- **Any single-tree structural validation** (an orphaned `fallback`, a
  `moveTo` targeting a nonexistent path, …) — these are properties of ONE
  tree, checkable (and, where fractal already checks them, checked) without
  ever comparing to a second tree. Tree-lint's reason to exist is
  specifically that NOTHING today compares N trees to each other; a
  single-tree check belongs in the projector or core code that already
  walks that one tree for its own purpose, not duplicated here.

The dividing line, stated once, for future rules considering whether they
belong in this package: **if the check needs to see more than one mounted
tree at once to be meaningful, it belongs in tree-lint; if it's fully
answerable from one tree's own structure, it belongs at that tree's own
wire/compile time, wherever that already is (or, if it genuinely isn't
checked anywhere yet, that absence is its own separate gap — not
retroactively assigned to tree-lint just because tree-lint is the newest
piece of analysis machinery being built).**

## 7. Consumer story: the sibling codebase

`packages/tree-lint` has no reference deployment inside fractal itself
(fractal has no real deployment — same situation `typed-store-spec.md`'s
own status block notes for its own consumer story). The sibling codebase is where §4b's
two call shapes land:

- Boot-time: `apps/web/src/server/lib/fractalRootTree.ts` (or a small
  wrapper it calls) — the one place that already imports and nests every
  slice's `build<Slice>Tree(composed)` output into the one composed root —
  gains an assembled `MountedTree[]` alongside that existing composition,
  and a `runTreeLint(trees)` call whose findings are thrown loud (matching
  `SourceCoverageError`'s own "collect everything, throw once" shape) before
  the app finishes booting, ahead of `serveFractalRoot`'s own single
  `app.mount("/api", ...)` call in `buildApp.ts`.
- CI: a new script (naming and exact location the sibling codebase's own call, matching
  how `codegen-fractal-validators.ts` and other per-repo scripts already
  live under `apps/web/scripts/`) builds the same `MountedTree[]` against a
  stub `ComposedSurface` and exits non-zero on any `error`-severity
  finding, runnable in CI with no live infra.

Neither call site is designed in this pass (doc only, no implementation, per
this spec's own Status line) — recorded here as the concrete shape the next
implementation pass targets, not as work already done.

## 8. What this spec does not decide

- **The exact normalization function for source-text fingerprinting**
  (comment/whitespace stripping, which AST-level normalization if any) —
  a real implementation choice with a correctness/complexity tradeoff
  (a naive whitespace-strip is cheap and catches the actual incident;
  full AST-normalize-then-hash catches more reformatting variance at
  real implementation cost) not resolved here.
- **Whether `openapi.operationId` (or a new dedicated field) becomes a
  REQUIRED, lint-enforced identity going forward** (§3c) — the durable fix
  once the first pass of this rule exists and the authoring discipline
  question can be posed with real evidence behind it, not decided by this
  spec, which only certifies that today's corpus doesn't have it yet.
- **Whether tree-lint eventually gains rules beyond collision detection**
  (§5, §6's boundary) — live candidates surfaced by this investigation but
  NOT specified here: an orphaned-descriptor rule (a `defineUseCase`
  descriptor, e.g. `accountingUseCaseDescriptors`, registered but never
  reachable from any mounted leaf — the inverse blind spot from
  collision), and a cross-tree AUTH-DRIFT rule (the same underlying
  operation reachable through two trees with two DIFFERENT `meta.scopes`/
  auth requirements — a correctness-relevant variant of collision, not
  just a duplication-cost one). Neither is designed here; both are
  consistent with §5's open rule-list shape whenever someone builds them.
- **How `MountedTree.basePath` pairing with each `buildXTree` call is kept
  in sync without hand-maintenance** (§4b assumes a human keeps the
  lint-time array and `fractalRootTree.ts`'s own composed branch nesting
  consistent; a codegen or single-source-of-truth mechanism that derives
  both from one list is a real follow-on question, not designed here).
- **Whether/how a stub `ComposedSurface` (§4b's CI path) is generated
  mechanically versus hand-maintained per slice** — the sibling codebase's own
  implementation-time call, not decided by this spec.
- **Exact severity/exit-code/output-format conventions for the CI command**
  (§7) — left to whatever convention the sibling codebase's other lint scripts
  (`lint:custom-display-count` and siblings, per the sibling codebase's own CLAUDE.md)
  already use, not re-derived here.

## 9. Regression checklist

Any future edit to this spec, or its implementation, MUST NOT reintroduce
any of the following:

1. **Handler reference equality treated as sufficient on its own.** §3a is
   real and cheap but has a TOTAL false-negative rate on the motivating
   incident — every leaf in the actual duplicate wraps its use case call in
   a fresh closure. A design that relies on reference equality alone would
   not have caught the incident this spec exists to prevent; it stays as a
   supplementary check only, never the sole or primary signal.
2. **`sourceMap`-based identity.** §3b is near-zero coverage on the real
   corpus (absent on every leaf involved in the incident) and, where
   present, describes decode shape rather than operation identity. Not a
   signal, primary or secondary.
3. **Path-based primary detection.** §3d — the incident's defining property
   is that the duplicate sat at two DIFFERENT paths; any design that leans
   on path similarity as its main signal is structurally incapable of
   catching the case it's meant to catch. Path stays a low-confidence
   corroborating hint only, never promoted to a standalone finding.
4. **A closed rule enum or a string-keyed rule registry.** §5 — rules are
   an open list of plain functions, matching `tags.ts`'s open-bag-plus-
   well-known-constants precedent, never a registry resolved by a runtime
   string a caller holds (that shape is reserved for genuinely
   runtime-dynamic dispatch, per the sibling codebase's own composition-time-selection
   principle, and a rule list is assembled statically by its caller, not
   looked up).
5. **Tree-lint re-implementing a check that already runs elsewhere in the
   pipeline.** §6's dividing line (needs ≥2 trees at once, or it doesn't
   belong here) is the test; `wrapValidators`/`wrapScopes` coverage and
   same-tree `mergeRoutes` collisions are named explicitly as already
   covered, loud, earlier in the pipeline — re-deriving either inside
   tree-lint duplicates an existing gate rather than closing the real gap
   (cross-tree comparison) this package exists for.
6. **An ambient/ubiquitous tree registry in place of an explicit array.**
   §4b — "the set of all mounted trees" is an explicit `MountedTree[]` a
   caller assembles at its own composition root or CI script, never a
   module-level mutable registry every `api-fractal/*.ts` file
   self-registers into at import time (the exact ambient-registration shape
   `meta-role-split-spec.md` §9(4) and `typed-store-spec.md` §9(3) both
   independently rule out for their own registries, for the same reason:
   the effective input would depend on which files happen to be imported by
   a given compilation/process, not on what the deployment deliberately
   composes).
