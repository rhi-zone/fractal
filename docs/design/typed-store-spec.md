# Typed Stores: value-carrying members, presence-correct by declaration, deployment-owned service stores

Status: **design spec, settled by the project owner — not yet implemented.**
This is not a proposal under discussion; it is the certified target
architecture. Scope: `packages/api-tree/src/input.ts`'s `Store`/
`StoreRegistry`/`Stores`/`assemble`, every projector's current `declare
module` augmentation of `StoreRegistry` (`http-api-projector/src/decode.ts`,
`cli-api-projector/src/cli.ts`, `mcp-api-projector/src/server.ts`,
`json-rpc-api-projector/src/server.ts`, `graphql-api-projector/src/resolve.ts`),
and the reference deployment (busiless)'s own composition root
(`packages/fractal-support/`). Sibling to
`docs/design/meta-role-split-spec.md` — same defect class (an ambient,
all-optional registry that only a projector's own runtime walk keeps
honest), same fix shape (deployment-owned single augmentation, projectors
export inert fragments), applied to stores instead of meta.

## 1. Motivation

Today `StoreRegistry` is a name-only registry — every member is typed
`true`, never the store's actual shape (`input.ts:53-55`):

```ts
export interface StoreRegistry {
  caller: true
}
```

and `Stores` blanket-optionals every member regardless of what that member
actually is, by a single mapped type with a `?` modifier applied uniformly
(`input.ts:68`):

```ts
export type Stores = Readonly<{ [K in keyof StoreRegistry]?: Store }>
```

Each projector declaration-merges its own store names onto this same
`StoreRegistry` — verified by reading each `declare module` block directly:
`http-api-projector/src/decode.ts:33-40` adds `path`/`query`/`header`/`body`;
`cli-api-projector/src/cli.ts:68-74` adds `flag`/`path`/`env`;
`mcp-api-projector/src/server.ts:79-84` adds `argument`/`"uri-variable"`;
`json-rpc-api-projector/src/server.ts:111-115` adds `params`;
`graphql-api-projector/src/resolve.ts:25-29` adds `argument`. `caller` alone
is declared once in core (`input.ts:53-55`), shared across every projector
by design (its doc comment explains why: every projector populates one, so
it belongs on the shared registry instead of being redundantly declared
three times) — this spec does not change that part.

Two defects follow directly from `true`-typed members and the blanket `?`:

- **Every store read is `unknown`-through-`Store`, never the store's real
  shape.** `Store = Record<string, unknown>` (`input.ts:33`) is what every
  member's value actually resolves to at a read site, regardless of what
  that particular store logically contains — `stores.query.q` and
  `stores.caller.userId` are both typed identically (`unknown`), because
  `StoreRegistry`'s `query: true` / `caller: true` carry no shape
  information for `Stores`' mapped type to project through. `Store`'s own
  doc comment (`input.ts:25-32`) already documents this as the CURRENT
  contract, not a bug in `Store` itself — the gap is that `StoreRegistry`
  has nowhere to put a per-member shape even if a projector wanted to
  supply one.
- **`assemble()` cannot look anything up by literal key, so it string-casts
  past the type entirely.** `assemble`'s internal `byName` lookup
  (`input.ts:134`) widens `stores` to `Readonly<Record<string, Store |
  undefined>>` with a comment explaining why: store names are resolved
  DYNAMICALLY there (from `sourceMap`/`pathParamNames`, both plain strings),
  and `Stores`' declaration-merged literal-key shape doesn't support that —
  by design, per the comment, for call sites that access it by literal key.
  This is a deliberate, documented escape hatch for ONE internal call site,
  not itself a defect this spec targets — flagged here because §5 replaces
  it with something narrower.
- **A second, ORTHOGONAL defect shares the same file: ambient
  augmentation.** Every projector's `StoreRegistry` augmentation lives
  inside that projector's own runtime module (`decode.ts`, `cli.ts`,
  `server.ts` ×2, `resolve.ts`) — exactly the pattern
  `meta-role-split-spec.md` §9(4) rules out for `Meta`. A transitively
  imported, UNUSED projector changes what `stores.someStoreName` accepts
  project-wide, for the same reason that spec gives: the type surface
  depends on which packages happen to be in the compilation, not on what
  the deployment actually composes.
- **No place to declare a REQUIRED, deployment-provided store.** Every
  member of `StoreRegistry` today is a per-request, projector-BUILT store
  (path/query/body/caller) — there is no way to add a long-lived,
  deployment-injected CAPABILITY (a database handle, an external API
  client, a domain read-model) to the same registry `stores.x` already
  indexes into, because `Stores`' blanket `?` treats every member as
  equally optional-and-absent-until-a-projector-builds-it. `TODO.md:109`
  (fractal) already tracks the value-typing half of this as open: "`Stores`
  makes accessing an undeclared store name a compile error, but doesn't
  type individual values within a store. Worth a follow-up pass if store
  misuse ever shows up in practice." — verified by reading that line
  directly; this spec is that follow-up, extended to cover requiredness as
  well as value shape once the motivating consumer case (§7) showed store
  misuse is not the only thing an all-optional registry costs.

## 2. Shape

`StoreRegistry` members carry their real VALUE type, not `true` — and
`Stores` stops blanket-optionaling every member; each member's own
declared optionality (`?` present or absent) is what determines whether
`stores.x` is nullable at a read site.

```ts
// packages/api-tree/src/input.ts

export interface StoreRegistry {
  caller: CallerStoreShape
}

// No blanket `?` — an identity-projection over StoreRegistry, not a
// Partial<>-style modifier. Each member's own optionality (declared on
// StoreRegistry, by whoever adds that member) survives unchanged.
export type Stores = Readonly<{ [K in keyof StoreRegistry]: StoreRegistry[K] }>
```

`caller`'s shape (`CallerStoreShape`) is a plain object of unknown-typed
fields — verified against every current populator: HTTP builds it from raw
header entries (`decode.ts:191-194`, `Record<string, unknown>` via a
headers loop), CLI from environment (referenced in `cli.ts`'s module doc),
MCP from `authInfo`/`sessionId` (`server.ts:629-636`) plus optional
`createMessage`/`sendLog`. No single concrete shape unifies these across
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
// packages/http-api-projector/src/decode.ts

export interface HttpStores {
  path?: Record<string, string>
  query?: Store // Proxy-backed, see httpStores' doc — still Store-shaped
  header?: Store
  body?: Store
}
```

```ts
// packages/cli-api-projector/src/cli.ts
export interface CliStores {
  flag?: Store
  path?: Store
  env?: Store
}

// packages/mcp-api-projector/src/server.ts
export interface McpStores {
  argument?: Store
  "uri-variable"?: Store
}

// packages/json-rpc-api-projector/src/server.ts
export interface JsonRpcStores {
  params?: Store
}

// packages/graphql-api-projector/src/resolve.ts
export interface GraphQLStores {
  argument?: Store
}
```

The **deployment** owns the single `declare module` block, in one file —
for busiless, alongside the existing `LeafMeta`/`BranchMeta`/`SharedMeta`
augmentation, in `packages/fractal-support/src/meta.ts` or a sibling
`stores.ts` in the same package (file split is busiless's own call, not
decided here — both are "the composition root," same invariant either way):

```ts
// e.g. busiless's packages/fractal-support/src/stores.ts

import "@rhi-zone/fractal-api-tree/input"
import type { HttpStores } from "@rhi-zone/fractal-http-api-projector"
import type { CliStores } from "@rhi-zone/fractal-cli-api-projector"
import type { McpStores } from "@rhi-zone/fractal-mcp-api-projector"

declare module "@rhi-zone/fractal-api-tree/input" {
  interface StoreRegistry extends HttpStores, CliStores, McpStores {
    tabularSource: TabularSourceShape // required — deployment-provided (§7)
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
// composition root, e.g. busiless's apps/web/src/server.ts /
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
owned members) is an implementation detail for whoever builds this — the
INVARIANT this spec certifies is: one registration object, typed against
the required members of the fully merged registry, checked once. Projector
data stores keep being built per-request by the dispatching projector
(`httpStores`, `buildInput`, `assembleInput`, …) exactly as today — their
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

- **`assemble()`'s `byName` cast** (`input.ts:134`,
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
- **MCP's `as Stores` cast** (`server.ts:637`, inside `assembleInput`) DOES
  go away, but not for a reason §2 alone supplies. Read directly: the
  object being cast is `{ [storeName]: values, caller: {...} }` where
  `storeName` is a runtime STRING parameter (`"argument"` or
  `"uri-variable"`, per the comment at `server.ts:624-626`) — a computed
  property key, which TypeScript cannot narrow to a literal union member of
  `Stores` regardless of whether `Stores`' members carry `true` or a real
  value type. The cast is removable once `assembleInput`'s TWO call shapes
  (`"argument"` at `server.ts:1008,1135`; `"uri-variable"` at
  `server.ts:1092,1107`) are split into two typed construction paths (an
  object literal with a LITERAL `argument:` or `"uri-variable":` key
  compiles without a cast; a computed `[storeName]:` key does not) — a
  small, mechanical refactor of `assembleInput`'s signature (two overloads,
  or a discriminated-by-caller helper), not a consequence of §2's shape
  change on its own. Flagged here as a `[verify: NOT independently
  re-verified against a scratch repro this session — the reasoning above is
  read directly from `server.ts`'s existing code and comment, not from a
  compiled check of the proposed split]`.
- **`Stores`' blanket-`?` mapped type** (`input.ts:68`) itself is the seam
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

The candidate check: statically tie a handler's declared input keys to
`StoreRegistry` members of assignable type, catching a mistyped or
unregistered source at the `op()` call site instead of at first request.
Investigated directly against the current mechanism, not assumed —
findings split by which piece of "where does this param come from" is
being checked, because the three sources `assemble`'s resolution order
consults (`input.ts:97-100`: path-param match, then `sourceMap` override,
then primary-store convention) are NOT equally visible to `op()`'s own
type.

- **A handler's declared input keys ARE statically extractable.**
  `InputKeys<H> = H extends (input: infer I) => any ? keyof I : never`
  against a concrete handler compiles cleanly and correctly rejects an
  undeclared key (`@ts-expect-error` confirmed in scratch repro). This
  piece is not the blocker.
- **`http.source()`-declared per-param overrides are type-ERASED today,
  confirmed by direct read, not inference:** `SourceDirective`'s `map`
  field is typed `SourceMap = Readonly<Record<string, ParamSource>>`
  (`project.ts:163-164`, `input.ts:88`) — a plain index-signature type.
  `source()`'s own doc comment (`verbs.ts:258-298`) already explains why:
  merging TWO such index-signature objects at the type level hits a real
  TypeScript limitation (a spurious `| undefined` on every merged entry),
  so `source()` returns a DIRECTIVE (array element, concatenated via
  `op()`'s `FoldMeta`/`MergeMetaValue`'s tuple-spread array branch,
  `node.ts:170-175`) rather than a merged object — but the directive's OWN
  `map` field is still built via a fixed, non-generic return annotation
  (`source(map: SourceMapInput): {...}`, `verbs.ts:307`), which erases
  each key's literal association with its store the moment the function
  returns, independent of the array-vs-object question its doc comment
  addresses.
- **That erasure is NOT structurally forced — a scratch repro this
  session built a literal-preserving redesign and it compiles.** A
  `source<const M extends SourceMapInput>(map: M): {...map: M...}`
  signature (matching the `const V`/`const P` technique `httpVerbBundle`/
  `moveTo` already use elsewhere in the same file, per their own doc
  comments) keeps each call's literal key/value association. TWO such
  calls concatenate as separate tuple elements (confirmed:
  `MergeMetaValue`'s array branch is `readonly [...A, ...B]`, a real tuple
  spread, not a widening `Array<A[number] | B[number]>` — read directly at
  `node.ts:170-175`), and a recursive conditional type walking that tuple
  (`FindStoreForParam`, last-element-wins per the resolution order
  `source()`'s own doc already specifies) resolves "what store does param
  X come from, given N source() calls" purely at the type level — verified
  against a 2-directive scratch repro (`year`→`"query"` literal,
  `months`→`{store:"body",key:"budgetMonths"}` literal, both recovered by
  name through the walk, a nonexistent name resolving to `never`) with
  zero diagnostics. **This means a source()-driven coverage check is
  reachable, contingent on redesigning `source()`'s signature to be
  literal-preserving — not free, but not blocked by the index-signature
  limitation its current doc comment cites, because that limitation is
  about merging two maps into ONE type, and the tuple-walk approach never
  does that.**
- **Path-derived param names are NOT visible to `op()`'s own type, and
  this IS a structural block, not an engineering gap.** Read directly:
  `pathParamNames = Object.keys(slugs)` (`route.ts:941`) — `slugs` are the
  regex-captured segments of the MATCHED request URL, resolved by
  `http-api-projector`'s own route-building tree walk at a position `op()`
  has no view into (the leaf's mount path is a property of where it sits
  in the tree passed to `api()`, not of the leaf's own `op()` call
  arguments). No generic parameter on `op()` could see this without
  threading tree-position information INTO every leaf's own type — a much
  larger change than this spec's scope, and one that would recreate the
  exact "meta knows about tree position" coupling `meta-role-split-spec.md`
  keeps out of `LeafMeta`/`BranchMeta`.
- **Without codegen-derived `paramNames`, the parameter SET itself is
  request-shaped, not statically fixed.** Read directly: `defaultDecode`'s
  fallback (`route.ts:944-957`, when `sources?.paramNames` is absent) takes
  the union of whatever the ACTUAL request's query string and parsed body
  happen to contain, at request time — there is no compile-time-fixed
  param list to check coverage against in this path at all, independent of
  store typing.

**Conclusion: no single check anchored purely at `op()`'s own call site
covers all three resolution-order steps uniformly**, because two of the
three (path match, primary-store convention under the no-`paramNames`
fallback) depend on information — tree mount position, and the live
request — that doesn't exist yet at `op()`'s definition time. The honest
split: a source()-override coverage check is a real, buildable static
check (contingent on the `source()` redesign above); path-param and
convention-driven coverage remain a RUNTIME check, run once at boot/wire
time when the tree is assembled and routes are built (the point at which
mount position and the codegen'd `paramNames` list, if present, both
exist) — not a compile-time gap papered over, a genuinely later point in
the pipeline where the missing information first becomes available. This
spec does not design that runtime check's exact shape (§8).

## 7. Consumer story: busiless's tabular-read need

The motivating case, grounded against busiless's actual code (not a
hypothetical): `apps/web/src/server/api-fractal/ingestion.ts:215` imports
`readGoogleSheet` directly from `@busiless/integrations-google` — a
concrete googleapis-backed adapter, not a descriptor — and calls it inside
the `/sheets` POST handler (`ingestion.ts:476`). `busiless/TODO.md`'s
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
    read(sourceId: string): Promise<{ headers: string[]; rows: unknown[][] }>
  }
}
```

`ingestion.ts` reads `stores.tabularSource.read(...)` — never imports
`readGoogleSheet`, never imports `@busiless/integrations-google` at all.
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

- **The exact mechanical shape of `RequiredServiceStoreKeys`** (§4) — a
  derived-type detail for the implementer, not a design choice with
  competing tradeoffs worth recording here.
- **How a registered service store is threaded into each projector's
  per-request `Stores` merge** (§4's "mechanically... spreads them into its
  per-request `Stores` value") — an implementation-order question across
  five projector packages' preset options, not decided here.
- **`source()`'s literal-preserving redesign's exact signature** (§6) —
  confirmed FEASIBLE via scratch repro, not specified to the letter; the
  real `SourceMapInput`/`HttpStore` types (unlike the scratch repro's
  simplified stand-ins) need their own pass to confirm the `const M`
  technique composes cleanly with `HttpStore`'s own declaration-merged
  openness, which this session did not test.
- **The runtime boot/wire-time coverage check's exact shape** (§6's
  conclusion) — that it must exist and must run once at tree-assembly time
  is certified; its API, error format, and exactly which of the three
  resolution-order steps it covers beyond what §6 already scoped out is
  not.
- **`CallerStoreShape`'s eventual richer typing** (§2) — noted as staying
  `Record<string, unknown>` at the core declaration for now; a deployment
  wanting a stronger `caller` shape composes its own augmentation, same as
  today's `Store`-typed caller, just no longer hidden behind a `true`
  member.
- **Whether `assemble()`'s remaining `byName` cast (§5, kept) could ever
  be narrowed further** — flagged as staying, with the reasoning for why,
  not investigated for an alternative that removes it too.
- **Implementation order / rollout sequencing across the five projector
  packages and busiless.**

## 9. Regression checklist

Any future edit to this spec, or its implementation, MUST NOT reintroduce
any of the following:

1. **Name-only registry members (`name: true`).** `StoreRegistry` members
   carry the store's real value type (§2) — a member typed `true` is a
   regression to today's defect, not a stepping stone toward it.
2. **A blanket-optional `Stores` (`{ [K in keyof StoreRegistry]?: Store }`
   or any `Partial<>`-equivalent).** This defeats the entire point: a
   required service store (§2, §4) becomes silently `| undefined` again,
   the exact hole `TODO.md:109` flagged and this spec closes. The
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
