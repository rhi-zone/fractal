# Typed Stores: value-carrying members, presence-correct by declaration, deployment-owned service stores

Status: **IMPLEMENTED in fractal.** Was: "design spec, settled by the project
owner — not yet implemented." This is not a proposal under discussion; it is
the certified target architecture, and the sections below are kept as written
(they remain the contract §9's regression checklist is enforced against).
What the implementation settled, beyond what the text already fixed:

- **§5's `[verify:]` flag on MCP's `as Stores` cast is discharged — PROVEN.**
  Splitting `assembleInput` into `assembleArgumentInput`/`assembleUriVariableInput`
  over a shared `callerStore` helper removes the cast with a clean compile. The
  diagnosis was exactly right: the cast existed only because the single-function
  form built its object with a COMPUTED key, and each split path builds a
  literal-key object that checks directly against the bag type. All four call
  sites already passed a literal.
- **§8's open question on `source()`'s `const M` — it composes.** The `const M
extends SourceMapInput` signature keeps each call's literal key/store
  association through `HttpStore`'s own declaration-merged openness, verified by
  compiling against the real types rather than a simplified stand-in. Two
  guards were needed that the scratch repro could not have surfaced: a verb
  bundle types its directives tuple as the whole `HttpDirective` UNION (whose
  `source` member has an erased map), so both the coverage check and the
  directive walk must skip erased maps — see `FindStoreForParam`'s own doc.
- **§8's runtime wire-time check** is `checkRouteSourceCoverage`
  (http-api-projector's route.ts), called once from `makeRouterFromRoute`;
  it collects every problem across the tree into one `SourceCoverageError`
  rather than failing on the first.
- **§8's service-store threading LANDED for `http-api-projector`** (driven by
  the sibling codebase's real `tabularSource` consumer, §7) — see `TODO.md`'s resolved
  entry for the exact mechanics and the `HasRequiredKeys`-conditional design
  it evaluated and rejected (declaration-merging is global to a `ts.Program`,
  so a conditionally-required `PresetOptions.serviceStores` would force every
  `createFetch` call in a compilation to supply it, not just the mounted
  sub-app that reads it — wrong for a deployment with several independently-
  mounted trees). `HttpStoreBag` is `Stores & HttpStores` again (not
  `ProjectorStores & HttpStores`). **CLI/MCP/JSON-RPC/GraphQL projectors are
  still DEFERRED** — each remains typed `ProjectorStores & XStores` — because
  no real consumer has needed one yet; `ProjectorStores` (`Omit<Stores,
RequiredServiceStoreKeys>`) stays in api-tree for their sake.
- **Fractal has no real deployment**, so §3's single-augmentation role is played
  by `examples/library-api/src/stores.ts` (the example app's composition root)
  and by `packages/api-tree/src/__fixtures__/deployment-store.fixture.ts` (that
  package's own test suite's stand-in), mirroring the meta role-split precedent.
  §7's consumer story is the sibling codebase's, and is not implemented here. Scope: `packages/api-tree/src/input.ts`'s `Store`/
  `StoreRegistry`/`Stores`/`assemble`, every projector's current `declare
module` augmentation of `StoreRegistry` (`http-api-projector/src/decode.ts`,
  `cli-api-projector/src/cli.ts`, `mcp-api-projector/src/server.ts`,
  `json-rpc-api-projector/src/server.ts`, `graphql-api-projector/src/resolve.ts`),
  and the reference deployment (the sibling codebase)'s own composition root
  (`packages/fractal-support/`). Sibling to
  `docs/design/meta-role-split-spec.md` — same defect class (an ambient,
  all-optional registry that only a projector's own runtime walk keeps
  honest), same fix shape (deployment-owned single augmentation, projectors
  export inert fragments), applied to stores instead of meta.

## 1. Motivation

Originally (before this spec's implementation) `StoreRegistry` was a
name-only registry — every member typed `true`, never the store's actual
shape:

```ts
export interface StoreRegistry {
  caller: true;
}
```

and `Stores` blanket-optionaled every member regardless of what that member
actually was, by a single mapped type with a `?` modifier applied
uniformly:

```ts
export type Stores = Readonly<{ [K in keyof StoreRegistry]?: Store }>;
```

That shape no longer exists in `input.ts` — `caller`'s real shape now
lives on `CoreStores.caller` (`StoreRegistry extends CoreStores {}`), and
`Stores` is the identity-projection §2 below describes, not this
blanket-optional mapped type. The two snippets above are kept only to show
what the fix (§2) was a fix FROM.

Each projector used to declaration-merge its own store names onto this same
`StoreRegistry` via its own `declare module` block. That mechanism is gone
end to end — no projector package contains a `declare module` block onto
`StoreRegistry` anymore (verified: none of `http-api-projector/src/decode.ts`,
`cli-api-projector/src/cli.ts`, `mcp-api-projector/src/server.ts`,
`json-rpc-api-projector/src/server.ts`, `graphql-api-projector/src/resolve.ts`
declares one today). Each projector instead exports an inert fragment
interface, matching the shape §3 below settles on: `HttpStores`
(`http-api-projector/src/decode.ts`) carries `path`/`query`/`header`/`body`;
`CliStores` (`cli-api-projector/src/cli.ts`) carries `flag`/`path`/`env`;
`McpStores` (`mcp-api-projector/src/server.ts`) carries
`argument`/`"uri-variable"`; `JsonRpcStores`
(`json-rpc-api-projector/src/server.ts`) carries `params`; `GraphQLStores`
(`graphql-api-projector/src/resolve.ts`) carries `argument`. A deployment's
own single augmentation file extends `StoreRegistry` with whichever
fragments it uses — see §3. `caller` alone is declared once in core, on
`CoreStores` (`input.ts`), shared across every projector by design (its doc
comment explains why: every projector populates one, so it belongs on the
shared registry instead of being redundantly declared per projector) — this
spec does not change that part.

Two defects followed directly from `true`-typed members and the blanket `?`
(both now fixed — see §2's current shape):

- **Every store read was `unknown`-through-`Store`, never the store's real
  shape.** `Store = Record<string, unknown>` (`Store`, `input.ts`) is what
  every member's value resolved to at a read site regardless of what that
  particular store logically contained — `stores.query.q` and
  `stores.caller.userId` were both typed identically (`unknown`), because
  `StoreRegistry`'s `query: true` / `caller: true` carried no shape
  information for `Stores`' mapped type to project through. `Store`'s own
  doc comment (`input.ts`) documents this as `Store`'s own current
  contract, not a bug in `Store` itself — the gap was that `StoreRegistry`
  had nowhere to put a per-member shape even if a projector wanted to
  supply one.
- **`assemble()` cannot look anything up by literal key, so it string-casts
  past the type entirely.** `assemble`'s internal `byName` lookup
  (`assemble`, `input.ts`) widens `stores` to `Readonly<Record<string, Store |
undefined>>` with a comment explaining why: store names are resolved
  DYNAMICALLY there (from `sourceMap`/`pathParamNames`, both plain strings),
  and `Stores`' declaration-merged literal-key shape doesn't support that —
  by design, per the comment, for call sites that access it by literal key.
  This is a deliberate, documented escape hatch for ONE internal call site,
  still present today, not itself a defect this spec targets — flagged here
  because §5 replaces the OTHER cast with something narrower and explicitly
  keeps this one.
- **A second, ORTHOGONAL defect shared the same file: ambient
  augmentation.** Every projector's `StoreRegistry` augmentation lived
  inside that projector's own runtime module (`decode.ts`, `cli.ts`,
  `server.ts` ×2, `resolve.ts`) — exactly the pattern
  `meta-role-split-spec.md` §9(4) rules out for `Meta`. A transitively
  imported, UNUSED projector changed what `stores.someStoreName` accepted
  project-wide, for the same reason that spec gives: the type surface
  depends on which packages happen to be in the compilation, not on what
  the deployment actually composes.
- **No place to declare a REQUIRED, deployment-provided store.** Every
  member of `StoreRegistry` was a per-request, projector-BUILT store
  (path/query/body/caller) — there was no way to add a long-lived,
  deployment-injected CAPABILITY (a database handle, an external API
  client, a domain read-model) to the same registry `stores.x` already
  indexes into, because `Stores`' blanket `?` treated every member as
  equally optional-and-absent-until-a-projector-builds-it. `TODO.md` used
  to track the value-typing half of this as open ("`Stores` makes accessing
  an undeclared store name a compile error, but doesn't type individual
  values within a store...") — that item is gone from `TODO.md` today (this
  spec's implementation closed it; searched, not found at any line), so the
  citation isn't reproduced here. This spec was that follow-up, extended to
  cover requiredness as well as value shape once the motivating consumer
  case (§7) showed store misuse is not the only thing an all-optional
  registry costs.

## 2. Shape

`StoreRegistry` members carry their real VALUE type, not `true` — and
`Stores` stops blanket-optionaling every member; each member's own
declared optionality (`?` present or absent) is what determines whether
`stores.x` is nullable at a read site.

```ts
// packages/api-tree/src/input.ts

export interface StoreRegistry {
  caller: CallerStoreShape;
}

// No blanket `?` — an identity-projection over StoreRegistry, not a
// Partial<>-style modifier. Each member's own optionality (declared on
// StoreRegistry, by whoever adds that member) survives unchanged.
export type Stores = Readonly<{ [K in keyof StoreRegistry]: StoreRegistry[K] }>;
```

`caller`'s shape (`CallerStoreShape`) is a plain object of unknown-typed
fields — verified against every current populator: HTTP builds it from raw
header entries (`httpStores`, `decode.ts`, `Record<string, unknown>` via a
headers loop), CLI from environment (referenced in `cli.ts`'s module doc),
MCP from `authInfo`/`sessionId` (`callerStore`, `mcp-api-projector/src/server.ts`)
plus optional `createMessage`/`sendLog`. No single concrete shape unifies these across
projectors today — `CallerStoreShape` stays `Record<string, unknown>` (the
existing `Store` alias) at the CORE declaration; a deployment wanting a
richer `caller` shape composes it in its own augmentation (§3), the same
way `SharedMeta.description` stays generic in core while a deployment adds
`scopes` at leaf position.

Two KINDS of member now coexist on one registry, distinguished by
optionality, not by a second registry or a wrapper type:

- **Projector-built, per-request data stores** (`path`, `query`, `body`,
  `header`, `flag`, `argument`, `params`, …) — declared OPTIONAL (`name?:
Shape`), because any single projector only ever builds the subset it
  defines (`Stores`' existing doc comment already explains this — a
  compilation merging HTTP's and CLI's augmentations together doesn't mean
  a given request populates both). This is today's kind, unchanged in
  KIND, changed only in that the member now carries a real shape instead of
  `true`.
- **Deployment-provided, long-lived service stores** (a tabular-read
  capability, a domain read-model, …) — declared REQUIRED (`name: Shape`,
  no `?`), because the deployment's single registration site (§4) is
  checked structurally against every required member — a missing one is a
  compile error there, not a silent `undefined` at a random read site
  later.

## 3. Projectors export fragments, deployment owns the one augmentation

Same mechanism as `meta-role-split-spec.md` §2/§3, applied to
`StoreRegistry` instead of `Meta`/`LeafMeta`/`BranchMeta`: every projector
STOPS running its own `declare module "@rhi-zone/fractal-api-tree"` block.
Each exports an inert, plain, named interface carrying just its own store
names' shapes:

```ts
// packages/http-api-projector/src/decode.ts — HttpStores

export interface HttpStores {
  path?: Record<string, string>;
  query?: Store; // Proxy-backed, see httpStores' doc — still Store-shaped
  header?: Store;
  body?: Store;
}
```

```ts
// packages/cli-api-projector/src/cli.ts
export interface CliStores {
  flag?: Store;
  path?: Store;
  env?: Store;
}

// packages/mcp-api-projector/src/server.ts
export interface McpStores {
  argument?: Store;
  "uri-variable"?: Store;
}

// packages/json-rpc-api-projector/src/server.ts
export interface JsonRpcStores {
  params?: Store;
}

// packages/graphql-api-projector/src/resolve.ts
export interface GraphQLStores {
  argument?: Store;
}
```

The **deployment** owns the single `declare module` block, in one file —
for the sibling codebase, alongside the existing `LeafMeta`/`BranchMeta`/`SharedMeta`
augmentation, in `packages/fractal-support/src/meta.ts` or a sibling
`stores.ts` in the same package (file split is the sibling codebase's own call, not
decided here — both are "the composition root," same invariant either way):

```ts
// e.g. the sibling codebase's packages/fractal-support/src/stores.ts

import "@rhi-zone/fractal-api-tree/input";
import type { HttpStores } from "@rhi-zone/fractal-http-api-projector";
import type { CliStores } from "@rhi-zone/fractal-cli-api-projector";
import type { McpStores } from "@rhi-zone/fractal-mcp-api-projector";

declare module "@rhi-zone/fractal-api-tree/input" {
  interface StoreRegistry extends HttpStores, CliStores, McpStores {
    tabularSource: TabularSourceShape; // required — deployment-provided (§7)
  }
}
```

Same gotcha as `meta-role-split-spec.md` §5's first bullet, restated
because it bites at this exact call shape too: the `declare module` block
must be preceded by an `import` of the augmented module in the SAME file, or
it silently SHADOWS `StoreRegistry` (replaces it) instead of augmenting it.
**Heritage-clause accumulation across a `declare module` block is the same
verified mechanism `meta-role-split-spec.md` §3 already confirmed for
`Meta`** — `extends HttpStores, CliStores, McpStores` behaves exactly like
an ordinary interface's heritage clause, no separate re-verification needed
here; the mechanism is per-augmented-interface-target, not per-interface-
NAME, so its confirmed behavior transfers.

A transitive projector import stays type-inert, for the identical reason
`meta-role-split-spec.md` §2 gives: no projector package contains a
`declare module` block anymore, so importing one (even unused) changes
nothing about what `StoreRegistry`/`Stores` mean anywhere. Only the
deployment's own `extends` clause naming a fragment has any effect.

## 4. Single-shot registration for service stores

A REQUIRED member (§2, second kind) needs exactly one place a deployment
supplies its value — checked structurally against the merged
`StoreRegistry`, so a missing service store is a compile error at THAT
site, not a runtime `undefined` the first time some handler reaches for it.

```ts
// composition root, e.g. the sibling codebase's apps/web/src/server.ts /
// apps/cli/src/index.ts / apps/worker/src/index.ts — wherever the
// deployment already composes adapters into the running process (the same
// entrypoints commit 0a404643 moved createGoogleCalendarPort construction
// into, for the identical "don't let the composition leak into a shared
// module" reason)

const serviceStores: Pick<StoreRegistry, RequiredServiceStoreKeys> = {
  tabularSource: createGoogleSheetsTabularSource(...), // or any other adapter
}
```

The exact mechanical shape of `RequiredServiceStoreKeys` (a derived
utility type picking only `StoreRegistry`'s required-and-not-projector-
owned members) is settled now, not left open: `RequiredServiceStoreKeys`
and its registration-object type `ServiceStores` are both implemented in
`input.ts` today (`RequiredServiceStoreKeys` excludes `CoreStores`' own keys
from `RequiredStoreKeys`; `ServiceStores = Readonly<Pick<StoreRegistry,
RequiredServiceStoreKeys>>`). The INVARIANT this spec certifies is: one registration object, typed against
the required members of the fully merged registry, checked once. Projector
data stores keep being built per-request by the dispatching projector
(`httpStores` decode.ts, `buildInput` cli.ts,
`assembleArgumentInput`/`assembleUriVariableInput` mcp-api-projector's
server.ts, …) exactly as today — their
optionality (§2) is precisely the property that makes per-request
construction sound without a registration site of their own. A service
store, once registered, is merged into the per-request `stores` object each
projector already builds (mechanically: each projector's own store-builder
takes the registered service stores as an additional input and spreads them
into its per-request `Stores` value) — this spec does not prescribe HOW
that merge is threaded through each projector's preset options (an
implementation-order question, §8), only that the registration site itself
is single-shot and structurally checked.

## 5. Seams die: the widening casts stop being reachable

Two casts exist today specifically because `Stores`' declaration-merged
shape couldn't be looked up by a DYNAMIC (runtime-string) key or built
incrementally without violating its own required members:

- **`assemble()`'s `byName` cast** (`assemble`, `input.ts`,
  `stores as Readonly<Record<string, Store | undefined>>`) stays — this
  spec does not remove it, and says so explicitly to avoid implying it did.
  `assemble` resolves a store name from `sourceMap`/`pathParamNames` at
  RUNTIME (plain strings, not literal types the compiler can track — §6
  explains exactly why), so it structurally cannot be typed by literal key
  regardless of what `StoreRegistry`/`Stores` look like; the existing
  comment on that line already gives this reasoning and remains correct
  under this spec unchanged. What DOES change: `Store` values reached
  through this cast are still `Store`-shaped (`Record<string, unknown>`),
  same as today — this cast was never about VALUE typing, only about
  literal-key lookup, so §2's value-carrying members don't interact with
  it.
- **MCP's `as Stores` cast** (originally inside a single `assembleInput`)
  DOES go away, but not for a reason §2 alone supplies. As originally
  written: the object being cast was `{ [storeName]: values, caller: {...}
}` where `storeName` was a runtime STRING parameter (`"argument"` or
  `"uri-variable"`) — a computed property key, which TypeScript cannot
  narrow to a literal union member of `Stores` regardless of whether
  `Stores`' members carry `true` or a real value type. The cast was
  removable once `assembleInput`'s TWO call shapes were split into two
  typed construction paths (an object literal with a LITERAL `argument:` or
  `"uri-variable":` key compiles without a cast; a computed `[storeName]:`
  key does not) — a small, mechanical refactor, not a consequence of §2's
  shape change on its own. **This is done, and the split is independently
  verified** (not merely reasoned about, as the original `[verify:]` flag
  here used to say): `assembleArgumentInput`/`assembleUriVariableInput`
  (`mcp-api-projector/src/server.ts`) are the two typed construction paths,
  sharing a `callerStore` helper for the common `caller` field; each builds
  its `McpStoreBag` with a literal key (`argument: values` /
  `"uri-variable": values`), no cast anywhere in either function.
  `assembleArgumentInput` is called from the tool-call and prompt-get
  dispatch paths; `assembleUriVariableInput` from the resource-read paths —
  all four call sites in `server.ts`.
- **`Stores`' blanket-`?` mapped type** (the original `Stores`, `input.ts`; §1 above) itself is the seam
  §2 replaces, and the replacement's exact mechanics ARE independently
  verified this session (not merely reasoned about): a scratch `tsc`
  repro (`--strict`, deleted after) built a merged `StoreRegistry` with one
  required core member (`caller`), one optional projector-augmented member
  (`query?`), and one required deployment-augmented member
  (`tabularSource`), all merged via the SAME cross-module `declare module`
  pattern §3 uses (a `registry.ts` base, a `projector-http.ts` augmenting
  it with `query?`, a `deployment.ts` importing both and adding
  `tabularSource` required) — confirmed, with zero unexpected diagnostics
  and every deliberately-wrong line (`@ts-expect-error`) correctly
  flagged: (1) `stores.caller.userId` and `stores.tabularSource.read(...)`
  both typecheck WITHOUT a null/undefined guard; (2) `stores.query.q`
  WITHOUT a guard is a compile error, `stores.query?.q` is not; (3)
  `stores.notAStore` is a compile error (the property this whole mechanism
  exists to enforce, unchanged from today); (4) a registration function
  typed to require `tabularSource` rejects an empty object and accepts one
  supplying it. The identity-mapped `{ [K in keyof StoreRegistry]:
StoreRegistry[K] }` (no `?` modifier anywhere) is confirmed to preserve
  each member's OWN optionality from wherever it was declared, through
  cross-module declaration merging, to a read site three files away — the
  mechanism §2/§4 depend on is not speculative.

## 6. `op()`-level static coverage: partially reachable, not uniformly

**This section describes the mechanism as originally investigated, before
`source()`'s literal-preserving redesign (third bullet below) actually
landed — the redesign changed more than the bullet anticipated, including
dropping the directive/tuple-walk shape entirely in favor of a flat,
key-merged map. Rewritten against the current code, not left as originally
written, because the original description no longer matches how any of
this works.**

The candidate check: statically tie a handler's declared input keys to
`StoreRegistry` members of assignable type, catching a mistyped or
unregistered source at the `op()` call site instead of at first request.
Findings split by which piece of "where does this param come from" is
being checked, because the three sources `assemble`'s resolution order
consults (path-param match, then `sourceMap` override, then primary-store
convention — see `assemble`'s own `resolve` closure, `input.ts`) are NOT
equally visible to `op()`'s own type.

- **A handler's declared input keys ARE statically extractable.**
  `InputKeys<H> = H extends (input: infer I) => any ? keyof I : never`
  (`input.ts`) against a concrete handler compiles cleanly and correctly
  rejects an undeclared key. This piece is not the blocker.
- **`http.source()`-declared per-param overrides are statically visible
  today — this is now IMPLEMENTED, not merely shown feasible.** There is no
  `SourceDirective` type anymore; `source()` (`verbs.ts`) is
  `source<const M extends SourceMapInput>(map: M): { readonly http: {
  readonly sourceMap: ResolvedSourceMap<M> } }` — a literal-preserving
  generic signature (the `const M` technique) that returns a bare,
  KEY-MERGED map contribution, not a directive/array element. Composing two
  `http.source()` calls merges their maps directly at `op()`'s own
  `FoldMeta` fold, last-wins per key, the same depth-capped object-merge
  path (`MergeMetaValue`/`MergeTwoMeta`, `node.ts`) every other nested meta
  sub-bag already uses — the array/tuple-spread branch of `MergeMetaValue`
  still exists in `node.ts`, but it's for `http.directives`-style
  concatenation, unrelated to `sourceMap` today. `SourceMapsOf`/
  `FindStoreForParam`/`DeclaredSourceParams` (`input.ts`) read each
  namespace's already-merged, flat `sourceMap` directly — there is no
  tuple to walk and no "last element wins" scan, because `mergeMeta`/
  `FoldMeta` already resolved N composed `source()`-style contributions
  into one flat map, keyed, last-wins, before this module ever sees it (see
  those types' own doc comments in `input.ts` for the full mechanism,
  including the erased-map guard for a producer typed as an open DU rather
  than its exact variant).
- **The coverage check itself is wired into `op()` and enforced today.**
  `UncoveredSourceParams<H, Meta>` (`input.ts`) is folded into
  `CheckedContributions` (`node.ts`) alongside
  `EncodingMapDecoderMismatch`, so a `source()`-declared param the handler
  never reads is a compile error at the `op()` call site, not merely a
  reachable-in-principle check.
- **Path-derived param names are NOT visible to `op()`'s own type, and
  this IS a structural block, not an engineering gap.** `defaultDecode`
  (`route.ts`) computes `pathParamNames` from the MATCHED request's route
  slugs, intersected against the leaf's own `authoredPathParams` (its local,
  pre-`moveTo` ancestor slug names — this intersection is a real fix landed
  since this bullet was first written, closing a `moveTo`-relocation hazard
  path-binding used to have; see `route.ts`'s `Sources.authoredPathParams`
  and its own doc comments for why) — resolved by `http-api-projector`'s
  own route-building tree walk at a position `op()` has no view into (the
  leaf's mount path is a property of where it sits in the tree passed to
  `api()`, not of the leaf's own `op()` call arguments). No generic
  parameter on `op()` could see this without threading tree-position
  information INTO every leaf's own type — a much larger change than this
  spec's scope, and one that would recreate the exact "meta knows about
  tree position" coupling `meta-role-split-spec.md` keeps out of
  `LeafMeta`/`BranchMeta`.
- **Without codegen-derived `paramNames`, the parameter SET itself is
  request-shaped, not statically fixed.** `defaultDecode`'s fallback
  (`route.ts`, when `sources?.paramNames` is absent) takes the union of
  whatever the ACTUAL request's query string and parsed body happen to
  contain, at request time — there is no compile-time-fixed param list to
  check coverage against in this path at all, independent of store typing.

**Conclusion: no single check anchored purely at `op()`'s own call site
covers all three resolution-order steps uniformly**, because two of the
three (path match, primary-store convention under the no-`paramNames`
fallback) depend on information — tree mount position, and the live
request — that doesn't exist yet at `op()`'s definition time. The
source()-override coverage check IS a real static check, and is wired in
(`UncoveredSourceParams`/`CheckedContributions`, above); path-param and
convention-driven coverage are covered by a RUNTIME check instead, run
once at boot/wire time when the tree is assembled and routes are built —
`checkRouteSourceCoverage` (`route.ts`), called once from
`makeRouterFromRoute` (see the status block at the top of this doc). This
was left undesigned when this section was first written (§8's original
text); it is designed and implemented now.

## 7. Consumer story: the sibling codebase's tabular-read need

The motivating case, grounded against the sibling codebase's actual code (not a
hypothetical): `apps/web/src/server/api-fractal/ingestion.ts:215` [FLAGGED FOR
HUMAN: this file lives in the sibling codebase, not this repo — not
reachable from here to verify against current source or convert to a
symbol name; left as originally cited] imports
`readGoogleSheet` directly from `@the sibling codebase/integrations-google` — a
concrete googleapis-backed adapter, not a descriptor — and calls it inside
the `/sheets` POST handler (`ingestion.ts:476` [FLAGGED FOR HUMAN: same —
sibling-codebase file, unverifiable from this repo]). `the sibling codebase/TODO.md`'s
"Type-surface-independence direction (2026-07-31)" thread names this
exact call site as (a) a projection-purity violation (a route/tree module
reaching an adapter directly, the same class of violation
`type-surface-independence-and-slice-flattening-2026-07-31.md` targets)
and (b) "the sole remaining reason `codegen-fractal-validators.ts` still
has to parse `googleapis` for any slice at all" — quoted directly from
that file. The googleapis barrel import alone was measured there at +999
files / +84.4MB parsed source text / +1172MB RSS to the shared `ts.Program`
`codegen-fractal-validators.ts` builds — the reason that script re-execs
itself under a `systemd-run --user --scope -p MemoryMax=6144M` guard
(`apps/web/scripts/codegen-fractal-validators.ts`, per that script's own
module doc and `CLAUDE.md`'s workflow note about it). A sibling chain
through this same barrel (`filter-sets.ts` → `statusKinds.ts`) was
already fixed by a mechanical subpath swap (per TODO.md's 2026-08-01
session note) precisely BECAUSE `statusKinds.ts` needed only a lean,
googleapis-free DESCRIPTOR — but `ingestion.ts`'s case is different in
kind: `readGoogleSheet` IS the real adapter, not a descriptor, so no
subpath swap exists for it. TODO.md records this as blocked specifically
on "deciding WHERE that injected capability's contract is declared and
owned" — exactly the question this spec's store-registration mechanism
answers.

Under this spec: `ingestion.ts` declares the need it actually has, in
INGESTION's own vocabulary — not `readGoogleSheet`, not `SheetSourcePort`
(TODO.md's own note already leans toward a BROADER, non-sheets-specific
shape: "a tabular-data-source contract, not `SheetSourcePort`" — this spec
adopts that lean, not a fresh guess):

```ts
// StoreRegistry augmentation (composition root, §3)
interface StoreRegistry {
  tabularSource: {
    read(sourceId: string): Promise<{ headers: string[]; rows: unknown[][] }>;
  };
}
```

`ingestion.ts` reads `stores.tabularSource.read(...)` — never imports
`readGoogleSheet`, never imports `@the sibling codebase/integrations-google` at all.
The composition root (§4) registers the googleapis-backed implementation
exactly once:

```ts
const serviceStores = {
  tabularSource: { read: (id) => readGoogleSheet({ sheetId: id, ... }) },
}
```

If a second consumer later needs the same capability (an analytics slice
reading a different tabular source, say), it declares its OWN
`tabularSource` need independently — no shared contract package, no owning
domain slice negotiated between the two, structurally satisfied by
whichever single implementation the root registers, per this codebase's own
`docs/decisions/type-surface-independence-and-slice-flattening-2026-07-31.md`
finding that a shared cross-slice contract package is the wrong shape for
this kind of need. **The payoff this spec is written to unblock**: once
`ingestion.ts`'s import closure no longer reaches `readGoogleSheet` (and
therefore `googleapis`), the barrel import TODO.md measured at +999
files/+84.4MB/+1172MB RSS drops out of `codegen-fractal-validators.ts`'s
shared `ts.Program` for real (not just for one of two redundant chains, the
way the `statusKinds.ts` fix left it) — the concrete, measurable
precondition TODO.md already names for revisiting the `systemd-run`
memory-cap wrapper's necessity. This spec does not itself remove that
wrapper (a separate, later measurement + owner call, per TODO.md's own
"do not remove it ... until chain 1 has an owner-approved fix") — it is
what makes chain 1's fix possible in the first place.

## 8. What this spec does not decide

- ~~The exact mechanical shape of `RequiredServiceStoreKeys`~~ (§4) —
  **SETTLED, not left open.** `RequiredServiceStoreKeys`/`ServiceStores`
  are both implemented in `input.ts` today (see §4's updated text).
- **How a registered service store is threaded into each projector's
  per-request `Stores` merge** (§4's "mechanically... spreads them into its
  per-request `Stores` value") — RESOLVED for `http-api-projector` (see the
  status block at the top of this doc and `TODO.md`'s resolved entry); the
  remaining four projectors' preset options are still an open
  implementation-order question, deferred pending a real consumer.
- ~~`source()`'s literal-preserving redesign's exact signature~~ (§6) —
  **SETTLED and shipped.** `source<const M extends SourceMapInput>` is the
  real signature in `verbs.ts` today, composing cleanly against the real
  `SourceMapInput`/`HttpStore` types (not just the scratch repro's
  simplified stand-ins) — see the status block at the top of this doc and
  §6's rewritten text.
- ~~The runtime boot/wire-time coverage check's exact shape~~ (§6's
  conclusion) — **SETTLED and shipped**: `checkRouteSourceCoverage`
  (`route.ts`), collecting every problem into one `SourceCoverageError`
  rather than failing on the first, called once from `makeRouterFromRoute`
  — see the status block at the top of this doc.
- **`CallerStoreShape`'s eventual richer typing** (§2) — noted as staying
  `Record<string, unknown>` at the core declaration for now; a deployment
  wanting a stronger `caller` shape composes its own augmentation, same as
  today's `Store`-typed caller, just no longer hidden behind a `true`
  member.
- **Whether `assemble()`'s remaining `byName` cast (§5, kept) could ever
  be narrowed further** — flagged as staying, with the reasoning for why,
  not investigated for an alternative that removes it too.
- **Implementation order / rollout sequencing across the five projector
  packages and the sibling codebase.**

## 9. Regression checklist

Any future edit to this spec, or its implementation, MUST NOT reintroduce
any of the following:

1. **Name-only registry members (`name: true`).** `StoreRegistry` members
   carry the store's real value type (§2) — a member typed `true` is a
   regression to today's defect, not a stepping stone toward it.
2. **A blanket-optional `Stores` (`{ [K in keyof StoreRegistry]?: Store }`
   or any `Partial<>`-equivalent).** This defeats the entire point: a
   required service store (§2, §4) becomes silently `| undefined` again,
   the exact hole the now-resolved `TODO.md` item (§1) flagged and this
   spec closes. The
   identity-mapped `{ [K in keyof StoreRegistry]: StoreRegistry[K] }` (no
   modifier) is the certified shape, confirmed by scratch repro (§5) to
   preserve each member's own declared optionality.
3. **Projector-owned ambient `StoreRegistry` augmentation.** Every
   projector exports inert fragments only (§3); the deployment is the sole
   place any `declare module` targeting `StoreRegistry` runs. A projector
   package regaining its own `declare module` block reintroduces the
   "importing an unused projector changes the type surface" defect
   `meta-role-split-spec.md` §9(4) already rules out for `Meta` — the same
   rule, same reasoning, applies here.
4. **Reintroducing a widening cast this spec identifies as removable.**
   MCP's `as Stores` cast (§5) is removable via `assembleInput`'s call-site
   split — re-adding it (or adding a NEW equivalent cast elsewhere to avoid
   doing that split) is a regression. `assemble()`'s OWN `byName` cast (§5)
   is explicitly NOT a regression to avoid re-adding — it stays, for a
   reason unrelated to this spec's changes; don't conflate the two.
5. **Adapter-signature service store shapes.** A service store typed to
   match its IMPLEMENTATION's signature (`tabularSource: { read:
typeof readGoogleSheet } }`, or worse, `googleSheetReader:
ReadSheetOpts => ...`) is dependency injection without inversion — the
   exact defect §7 exists to avoid. A service store's shape is declared in
   the CONSUMER's vocabulary (`tabularSource.read(sourceId):
{headers,rows}`, generic over what backs it), never the adapter's own
   parameter/return shape, never named after the concrete provider
   (`google`, `sheets`, …).
6. **Scattered registration defeating completeness checking.** A required
   service store supplied ad hoc at multiple call sites (each constructing
   its own partial `Stores`-shaped object) instead of through the single
   registration site (§4) loses the "missing required store is a compile
   error" property this spec exists to add — even if every individual call
   site happens to compile, there is no longer ONE place a missing
   registration is caught structurally.
