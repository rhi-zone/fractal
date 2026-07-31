# Splitting `Meta` into `SharedMeta` / `LeafMeta` / `BranchMeta`

Status: design spec, not yet implemented. Scope: `packages/api-tree/src/node.ts`'s
`Meta` interface and every projector's `declare module` augmentation of it
(`http-api-projector`, `mcp-api-projector`, `cli-api-projector`,
`graphql-api-projector`, `json-rpc-api-projector`).

**Invariant (owner-stated, non-negotiable): api-tree core does not know about
projectors — full stop.** No protocol name (`http`, `cli`, `mcp`, `graphql`,
`jsonrpc`, `openapi`, …) may appear anywhere in `packages/api-tree/src/node.ts`.
Core declares only the ROLE interfaces (`SharedMeta`/`LeafMeta`/`BranchMeta`)
and the enforcement machinery around them; every protocol namespace is
declaration-merged in from the owning projector package, exactly as `Meta`
works today. §7 records the two defects this rewrite corrects from the
previous draft, which violated this invariant directly.

## 1. Motivation

Today `Meta` is one open, all-optional interface, declared in core with
exactly two members (`node.ts:43-52`):

```ts
export interface Meta {
  tags?: Tags
  description?: string
}
```

Core itself never declares a protocol namespace. Each projector
declaration-merges its own single key onto this same `Meta` interface — one
`declare module "@rhi-zone/fractal-api-tree/node" { interface Meta { http?:
HttpMeta } }` block in `http-api-projector/src/project.ts:67-71`, one for
`openapi?: OpenApiMeta` in `http-api-projector/src/openapi.ts:199-203`, one
for `cli?: CliMeta` in `cli-api-projector/src/cli.ts:361-365`, one for
`mcp?: McpMeta` in `mcp-api-projector/src/project.ts:320-324`, one for
`jsonrpc?: JsonRpcMeta` in `json-rpc-api-projector/src/project.ts:139-143`,
one for `graphql?: GraphQLMeta` in `graphql-api-projector/src/project.ts:95-99`
— verified by reading each `declare module` block directly, not inferred.
Each of `HttpMeta`/`CliMeta`/`McpMeta`/`JsonRpcMeta`/`GraphQLMeta`/
`OpenApiMeta` is today a single FLAT interface owned entirely by its
projector package, spanning fields that in practice are read at different
tree positions (leaf-only, branch-only, or both — §3). A consumer can
declaration-merge further onto `Meta` too — e.g. a required
`scopes: readonly string[]` on an op, so an authorization check has
something to enforce instead of silently treating absence as "no scope
required."

`HasRequiredKeys<Meta>` (`node.ts:65`) already exists to make this legal:
`op()` (`node.ts:357-359`) and `api()` (`node.ts:441-443`) both flip their
meta-parameter arity from "optional, folds contributions" to "one required
`Meta` argument" the moment `HasRequiredKeys<Meta>` is `true`. But the flip is
global — a consumer can't require a member on OPERATIONS only. A
`declare module` block that adds `scopes: readonly string[]` to `Meta` makes
every `api()` branch call require it too, even though a branch has no scope
of its own to check. Splitting `Meta` by ROLE (shared / leaf-only /
branch-only) and running `HasRequiredKeys` per-interface instead of once
lets a consumer target the requirement at the position where it's
meaningful — and, independently of requiredness, lets each projector split
ITS OWN namespace by the same role axis, so a field only valid at one
position (e.g. `mcp.segment`, a branch-only field) stops typechecking at the
other.

## 2. Shape

Core declares three role interfaces, no `Partial<>` anywhere, and NOTHING
protocol-specific:

```ts
// packages/api-tree/src/node.ts

export interface SharedMeta {
  description?: string
}

export interface LeafMeta extends SharedMeta {
  tags?: Tags
}

export interface BranchMeta extends SharedMeta {}
```

That is the entire core surface. `tags` moves off the base `Meta`-equivalent
onto `LeafMeta` specifically, because every read site for it is leaf-gated —
verified: every `.tags` read in every projector reads `child.meta.tags` (or
`leafMeta.tags`/`resolved.leafMeta.tags`) inside a leaf-only walk, and each
site's neighboring comment says so explicitly ("the leaf's OWN meta.tags —
there is no ancestor inheritance", repeated near-verbatim in
`cli.ts:12`, `mcp-api-projector/project.ts:10,358`,
`json-rpc-api-projector/project.ts:31`, `http-api-projector/tags.ts:49`,
`graphql-api-projector/project.ts:23`). No projector reads `meta.tags` off a
branch node. `description` stays on `SharedMeta` (both leaf and branch read
it — §3).

`Meta` itself is retired as a name in core; `op()`/`api()` are retargeted to
`LeafMeta`/`BranchMeta` respectively (§2a). A protocol package that needs a
combined "either role" reference for its own internal helpers can express
that locally (e.g. `LeafMeta | BranchMeta`, or its own shared type) — core
does not need to provide one, since `SharedMeta` already is that shared
piece and both role interfaces extend it.

Every protocol namespace a projector owns is merged in by that projector,
split by role the same way. Each projector's `declare module` block targets
whichever of `SharedMeta`/`LeafMeta`/`BranchMeta` its fields actually belong
to — never a bare `Meta`, which no longer exists as an augmentation target.
Where a single protocol namespace has members at more than one role (true of
`http`, `cli`, and `openapi` today — §3), that projector does NOT try to
merge one flat `HttpMeta` into two different core interfaces (which would
require every `HttpMeta` member to be declared exactly once, in only one of
the two `declare module` blocks, silently splitting the type). Instead the
projector declares its OWN role split locally and merges each piece into the
matching core interface — e.g. http-api-projector:

```ts
// packages/http-api-projector/src/project.ts (illustrative — not yet written)

export interface HttpSharedMeta {
  moveTo?: string
}

export interface HttpLeafMeta extends HttpSharedMeta {
  method?: string
  verb?: string
  response?: { status?: number; headers?: Record<string, string> }
  paginated?: { style?: "cursor" | "offset"; inputCursorParam?: string; inputOffsetParam?: string; inputLimitParam?: string }
  validate?: StandardSchemaV1
  sourceMap?: SourceMap
}

declare module "@rhi-zone/fractal-api-tree/node" {
  interface SharedMeta {
    http?: HttpSharedMeta
  }
  interface LeafMeta {
    http?: HttpLeafMeta
  }
}
```

This is the pattern every multi-role projector namespace follows (§3 gives
the per-projector breakdown). It is deliberate, not incidental: it is what
makes TS's redeclare-replaces hazard structurally impossible instead of
merely avoided by convention (§2b).

### 2a. Enforcement machinery, generalized per-interface

`FoldMeta`/`MergeTwoMeta` (`node.ts:155-193`) are unchanged in kind — they
still fold a tuple of contributions right-to-left with the same
optional/required-key logic. What changes is what they're checked against:

- `op()`'s `FoldMeta<C> extends LeafMeta` check enforces required members on
  the FOLDED contribution, not per-element — the per-element
  `C extends readonly LeafMeta[]` constraint on `op()`'s rest parameter is
  what currently breaks composition: a required member on `LeafMeta` makes
  `http.get`'s own `VerbBundle` (a single `{ http: {...}, tags: {...} }`
  contribution) fail to typecheck against `LeafMeta` on its own, before it's
  ever composed with anything that supplies the required field. Retyping
  that constraint doesn't fix this — the individual `VerbBundle` element
  still doesn't carry the required member. Fixing it needs the same
  right-to-left fold `FoldMeta<C>` already computes to run BEFORE the
  `extends LeafMeta` check, not per-element — the composed result must
  satisfy `LeafMeta`, not each ingredient.
- `api()`'s `opts.meta` (`node.ts:441-443`) is single-valued (no fold), so
  its `HasRequiredKeys<BranchMeta>` check is unchanged in kind, just
  retargeted from `Meta` to `BranchMeta`.
- `HasRequiredKeys<T>` (`node.ts:65`) itself is already generic over `T` —
  nothing about it needs to change; it's simply invoked twice, once per role
  interface, instead of once against a single `Meta`.

## 2b. The redeclare-replaces hazard

TypeScript's declaration merging is ADDITIVE only when every merged block
declares DISJOINT members. If two `declare module` blocks each redeclare the
SAME member of the SAME interface, the later-evaluated one does not merge
with the earlier one member-by-member — it silently REPLACES the member's
type outright, with no error. This is not a split-by-role concern
specifically; it is a standing hazard of declaration merging that a role
split makes easy to trip if a projector's own local split isn't kept
disjoint.

The previous (rejected) draft of this spec hit exactly this hazard in its
own worked example: it wrote `LeafMeta.cli` once with the full `CliMeta`
shape and then, in the "consumer-facing" illustration, showed a second block
redeclaring `LeafMeta.cli` without `hidden` — the second declaration didn't
add to the first, it REPLACED it, silently dropping `hidden` from the
effective type with no diagnostic anywhere. It made the same mistake with
`LeafMeta.openapi`, where a second illustrative redeclaration omitted
`security`/`securitySchemes`, silently dropping both. Neither loss would
surface as a type error at the point of the mistake — it would surface much
later, as a call site that types allow `meta.cli.hidden` or
`meta.openapi.security` on an object that no longer actually has an index
signature or the "obviously already there" member.

The mitigation is structural, not a rule to remember: every core-facing
`declare module` block for a given key writes that key EXACTLY ONCE, in
exactly one file (the projector's own project.ts/openapi.ts/cli.ts — same
one file each already merges its flat namespace into today), naming a role
interface that is entirely THIS projector's own subtype
(`HttpLeafMeta`, not `LeafMeta` fields written inline a second time). No
interface is ever redeclared with an overlapping-but-different member set
across two files. Because §2's pattern makes each projector nest its own
role split (`HttpSharedMeta`/`HttpLeafMeta`) and merge each COMPLETE nested
type into the corresponding core interface once, there is no second
declaration of `http?: ...` anywhere to conflict with the first — the hazard
is eliminated by construction, not by discipline.

## 3. Per-projector migration guidance

Grounded in read sites, not the type declarations alone — a key only counts
as "read at position X" if some projector actually reads it off a node at
that position. This table is REFRAMED from the previous draft's key-by-key
listing: it is per-PROJECTOR migration guidance (which of that projector's
OWN keys merge into which core interface), not a listing of core members —
because after §2, core has no protocol keys to list.

### http-api-projector

| Key | Merges into | Evidence |
|---|---|---|
| `http.moveTo` | `HttpSharedMeta` → `SharedMeta.http` | `route.ts` §2b `applyMoveTo` (`route.ts:379-524`) relocates both single method-entries and whole subtrees — see §5 for the open question this still raises |
| `http.method` | `HttpLeafMeta` → `LeafMeta.http` | `applyMethods` rewriter, per method-entry (`HttpMeta.verb`/`.method` fields, `project.ts:214-227`) |
| `http.verb` | `HttpLeafMeta` → `LeafMeta.http` | `verbFromTags` precedence step 1 (`tags.ts`) |
| `http.response` | `HttpLeafMeta` → `LeafMeta.http` | `applyResponse` rewriter, per method-entry |
| `http.paginated` | `HttpLeafMeta` → `LeafMeta.http` | `extensions/pagination.ts:253-256` reads `getHttpMeta(ctx.meta).paginated` off the matched (leaf) route |
| `http.validate` | `HttpLeafMeta` → `LeafMeta.http` | `validateOf`/`route.ts:170-177` resolves the last `validate` directive off a leaf/method-entry's meta into `sources.validate` |
| `http.sourceMap` | `HttpLeafMeta` → `LeafMeta.http` | `sourceMapOf` resolves `meta.http`'s `source` directives per leaf (`route.ts:145`); **not read at branch position anywhere** |
| `openapi.security` | `SharedMeta.openapi` (position-dependent meaning — open, §5) | field doc `openapi.ts:179-184`; per-operation read at `openapi.ts:461-467`; root-as-spec-default read at `openapi.ts:414-416` |
| `openapi.securitySchemes` | `SharedMeta.openapi` | `collectSecuritySchemes` walks the whole tree, methods included (`openapi.ts:221-238`; merges every node's and every method entry's bag) |
| `openapi.{operationId,summary,deprecated}` | `LeafMeta.openapi` | per-operation fields, destructured per method-entry (`openapi.ts:461-467`) |
| `openapi.description` | `LeafMeta.openapi` | per-operation override, same destructure (`openapi.ts:464,482`) |
| `openapi.tags` | `LeafMeta.openapi` | per-operation override, same destructure (`openapi.ts:465,483`) |

Retired/dead `http` directive kinds (`segment`, `when`, `legacyPath`,
`dispatch`) are not placed in either `HttpSharedMeta` or `HttpLeafMeta` above
— they are parsed but read by no current projector
(`directive-contract.md` §HTTP, rows `segment`/`when`/`legacyPath`). Whether
they belong in `HttpLeafMeta` as dead-but-typed members, or should be
dropped from `HttpMeta` entirely as part of this split, is open — not
decided here.

### cli-api-projector

| Key | Merges into | Evidence |
|---|---|---|
| `cli.hidden` | `SharedMeta.cli` (`CliSharedMeta`) | `cli.ts:515` (leaf child), `cli.ts:531,537` (branch child, and the fallback subtree) |
| `cli.{name,alias,paginated}` | `LeafMeta.cli` | leaf-only display/behavior overrides (`cli.ts:517-520`, `CliMeta.paginated` doc `cli.ts:339-354`) |
| `cli.sourceMap` | `LeafMeta.cli` | `getCliMeta(target.leafMeta).sourceMap` (`cli.ts:1103`) — resolved against the matched LEAF's meta only |

### mcp-api-projector

| Key | Merges into | Evidence |
|---|---|---|
| `mcp.{name,title,annotations,as,uri,mimeType}` | `LeafMeta.mcp` | `getMcpMeta(child.meta)` in the three per-surface leaf walks (`project.ts` `projectTools`/`projectResources`/`projectPrompts`) |
| `mcp.description` | `LeafMeta.mcp` | leaf-only override, ranked above `meta.description`: `project.ts:396-404,645-648,817-825` |
| `mcp.sourceMap` | `LeafMeta.mcp` | `Dispatch.sourceMap` built per leaf handler (`project.ts:449,674,841`); **not read at branch position** |
| `mcp.segment` | `BranchMeta.mcp` | wired: `project.ts:452-454,691,845` — a static child's own contribution to the name/URI prefix |

### json-rpc-api-projector

| Key | Merges into | Evidence |
|---|---|---|
| `jsonrpc.{name,errorDataSchema}` | `LeafMeta.jsonrpc` | `JsonRpcMeta` fields, read per method during the tree walk (`project.ts:124-136`) |
| `jsonrpc.description` | `LeafMeta.jsonrpc` | leaf-only override, ranked above `meta.description` (`project.ts:208-213`) |
| `jsonrpc.sourceMap` | `LeafMeta.jsonrpc` | `Dispatch.sourceMap` per leaf (`project.ts:226`); **not read at branch position** |
| `jsonrpc.segment` | `BranchMeta.jsonrpc` | wired: `project.ts:229` — a static child's own contribution to the dot-joined prefix |

### graphql-api-projector

| Key | Merges into | Evidence |
|---|---|---|
| `graphql.{operation,name,deprecated}` | `LeafMeta.graphql` | `deriveOperationType` (`project.ts`, precedence step 1), field-name override, deprecation override — all per-field (leaf) |
| `graphql.deprecatedReason` | `LeafMeta.graphql` | only meaningful alongside `deprecated`, same leaf scope (`directive-contract.md` §GraphQL) |
| `graphql.description` | `LeafMeta.graphql` | leaf-only override, ranked above `meta.description` (`project.ts:310-314`) |
| `graphql.sourceMap` | `LeafMeta.graphql` | `GraphQLMeta.sourceMap`, resolved per field's arg assembly; **not read at branch position** |
| `graphql.namespace` | `BranchMeta.graphql` | declared (`GraphQLMeta.namespace`, `project.ts:73-74`) but **currently unwired** — the leaf-centric Query walk explicitly doesn't visit branch nodes to read it (`project.ts:483-488`: "branch-level `meta.graphql.namespace` is a later-phase refinement") |

### `description` itself (core `SharedMeta`, not a projector key)

| Key | Read at | Evidence |
|---|---|---|
| `description` | leaf and branch | `cli.ts:487-492`'s `descriptionFrom` is called on the current node at `buildHelp` top (branch, `cli.ts:502`) AND on leaf/branch children (`cli.ts:516,532`) |

## 4. Consumer-facing effects

- **The augmentation gotcha**: a `declare module` block augmenting one of
  these interfaces must be preceded by an `import` of the module it augments
  in the same file — a `declare module` with no preceding `import` SILENTLY
  SHADOWS the interface (replaces it) instead of augmenting it. This was hit
  empirically during feasibility testing for this split and is easy to get
  wrong by copying an existing augmentation out of context.
- **Position-invalid keys become unrepresentable.** `mcp.segment` on a leaf's
  `LeafMeta`, or `http.validate` on a branch's `BranchMeta`, stop
  typechecking instead of silently no-op'ing the way they do today (every
  key is currently legal everywhere; a projector's own walk is what decides
  whether it's read).
- **Requiredness travels with the declaration, at any nesting depth.** A
  deployer (e.g. busiless) wants `scopes: readonly string[]` required on
  every op, so an authorization wrapper can stop treating an absent
  `scopes` as "no enforcement" (a silent open route). Declaration-merging
  that requirement directly onto core's `LeafMeta` (not onto a projector's
  nested namespace, and not onto `BranchMeta`) makes every scope-less
  `op()` call a compile error via the `FoldMeta<C> extends LeafMeta` check
  (§2a), without also demanding a `scopes` field from `api()` branch calls
  that have none to check. This works identically whether the required key
  is a top-level `LeafMeta` member (busiless's `scopes`) or a member nested
  inside a projector's own namespace object — the fold/`HasRequiredKeys`
  check operates on whatever the final merged `LeafMeta`/`BranchMeta` shape
  is, regardless of which file(s) contributed which member.

## 5. Open judgment calls (not decided here)

1. **`http.moveTo` is assigned `HttpSharedMeta`** (merged into core's
   `SharedMeta.http`), since both single-operation and whole-subtree
   relocation are real, evidenced uses (`route.ts` §2b). But `moveTo`
   describes where THIS node goes, not where its descendants go —
   semantically it's "placement-of-self," a different axis than
   "placement-of-descendants" (which nothing currently expresses). Someone
   may argue this makes it a bad fit for a bag whose other shared members
   (core's `description`, http's own `moveTo`) are genuinely dual-read for
   the same reason at both positions, rather than dual-read because one
   node happens to relocate itself regardless of role. No alternative
   placement is proposed here.

2. **`openapi.security` is assigned `SharedMeta.openapi`**, but its MEANING
   differs by position: on a leaf/method-entry it's a per-operation
   requirement (`openapi.ts:179-181`); on the root it's the spec-level
   default (`openapi.ts:182-184`, applied at `openapi.ts:414-416`). Nothing
   else in the shared position has position-dependent MEANING (only
   `moveTo` and core's `description` have position-dependent APPLICABILITY,
   which is a weaker claim). This needs a doc line wherever
   `HttpSharedMeta`/`OpenApiMeta` is introduced to readers. Whether that
   difference in kind — same key, different meaning in different
   positions — warrants a real type split (e.g. a root-flagged variant vs.
   a plain per-operation one) instead of a shared optional key is an open
   question, not resolved here.

## 6. Migration surface

The role axis (shared / leaf / branch) is orthogonal to the existing
per-protocol namespace axis (`meta.http`, `meta.mcp`, …) — each namespace
already spans leaf, branch, and (for `http`/`cli`/`openapi`) shared keys (§3).
So every projector's `declare module` augmentation splits into up to three
separate blocks (one onto `SharedMeta`, one onto `LeafMeta`, one onto
`BranchMeta`, per §2's nested-subtype pattern), and every read site that
currently takes a bare `Meta` re-anchors to whichever of `SharedMeta` /
`LeafMeta` / `BranchMeta` actually applies at that call site.

Known collateral, found during feasibility testing:

- `mergeMeta`'s erasure casts (`node.ts:280-287`) — `mergeMeta` currently
  returns the erased `Meta`; with `Meta` retired in favor of the three role
  interfaces, either three merge functions (one per return role) or one
  merge function whose return type is threaded from the call site.
- `httpRoute`'s `meta: {}` placeholder nodes (`route.ts:110-125`,
  specifically `meta: def.meta ?? {}` at `route.ts:122`) — an empty object
  literal must satisfy whichever interface is asked for at that call site;
  trivial while every relevant key stays optional, but every such
  placeholder needs its type re-checked once the interface it satisfies is
  no longer always the single `Meta`.
- `dx.ts`'s `crud()` (`http-api-projector/src/dx.ts`) composes multiple
  `op(handler, http.get, ...)`-style calls, each contributing a `VerbBundle`
  (`verbs.ts:87-160`) through `op()`'s folded rest parameter — this is
  exactly the composition path §2a shows breaking today when `LeafMeta`
  gains a required member, since each individual `VerbBundle` contribution
  doesn't itself carry that member.
- Test fixtures using bare `api({})` (`node.test.ts:61,203`,
  `project.test.ts` across the http/mcp/graphql/json-rpc projector
  packages) — `{}` must satisfy `BranchMeta` at these call sites; still
  trivial while every `BranchMeta` key stays optional, but worth
  enumerating since these are exactly the call sites `HasRequiredKeys`
  changes the arity of.

## 7. What this spec does not decide

- The two open judgment calls in §5.
- Whether the four dead `http` directive fields (`segment`, `when`,
  `legacyPath`, `dispatch`) get typed placement or get dropped.
- Whether `mergeMeta` becomes three functions or one generic one.
- Implementation order / rollout sequencing across the five projector
  packages.

## 8. Regression checklist

A prior draft of this spec (committed at `2be5563`, superseded by this
rewrite) was rejected by the project owner for reintroducing exactly the
coupling this design exists to prevent. Any future edit to this spec MUST
NOT reintroduce any of the following:

1. **Protocol keys declared in core.** The rejected draft's §2 wrote
   `cli?: {...}`, `http?: {...}`, `openapi?: {...}`, `mcp?: {...}`,
   `jsonrpc?: {...}`, `graphql?: {...}` directly inside core's
   `SharedMeta`/`LeafMeta`/`BranchMeta` in `node.ts`. Core must not know any
   protocol name — full stop. Every protocol namespace is merged in from
   its own projector package (§2), never authored in `node.ts`.
2. **Redeclare-replaces member loss.** The rejected draft redeclared
   `LeafMeta.cli` and `LeafMeta.openapi` a second time with a narrower
   member set (dropping `hidden` from `cli`, dropping
   `security`/`securitySchemes` from `openapi`), which TypeScript silently
   treats as a replacement of that member's type, not a merge (§2b). Every
   key merges into a core role interface from exactly one file, as a
   complete nested subtype — never redeclared piecemeal across files.
3. **All-optional taxonomy that makes requiredness inexpressible.** A design
   where every interface stays fully optional (including via a stray
   `Partial<>` wrapper) defeats the entire point of the split — the
   motivating consumer need (§4) is a REQUIRED field at a specific role
   (e.g. `scopes` required on every op, not on branches). The split must
   preserve `op()`/`api()`'s existing `HasRequiredKeys`-driven arity flip,
   retargeted per-interface (§2a), not flatten it away.
