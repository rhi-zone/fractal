# Splitting `Meta` into `SharedMeta` / `LeafMeta` / `BranchMeta`

Status: **design spec, settled by the project owner — implemented.** This
document now describes the shipped architecture, not a proposal: core
declares `SharedMeta`/`LeafMeta`/`BranchMeta` with no protocol name in
`node.ts`, every projector exports inert namespaced fragment interfaces
instead of augmenting core, and zero projector-owned `declare module` blocks
remain (`http-api-projector/src/project.ts:39` states this directly for that
package; the same holds across `mcp-api-projector`, `cli-api-projector`,
`graphql-api-projector`, `json-rpc-api-projector`). §1 below narrates the
PRE-migration shape this spec replaced, kept for the rationale it argues
from. Scope: `packages/api-tree/src/node.ts`'s `Meta`-role interfaces, every
projector's namespaced fragment exports (`http-api-projector`,
`mcp-api-projector`, `cli-api-projector`, `graphql-api-projector`,
`json-rpc-api-projector`), and the reference deployment (the sibling
codebase)'s own single augmentation file.

**Invariant (owner-stated, non-negotiable): api-tree core does not know about
projectors — full stop.** No protocol name (`http`, `cli`, `mcp`, `graphql`,
`jsonrpc`, `openapi`, …) may appear anywhere in `packages/api-tree/src/node.ts`.

**Second invariant, new in this revision: projector packages never augment
anything either.** A prior draft of this spec (rejected by the owner, then a
second draft accepted core-blindness but still had every projector run its
own `declare module` block) left the type surface dependent on which
projectors happen to be transitively imported — importing an unused
projector could change what a caller's `op()`/`api()` calls require. This
revision removes that dependency structurally: every projector exports
inert plain interfaces and performs zero `declare module` side effects. The
**deployment** is the only place a `declare module` block exists, in one
file, written once. §9 records the full defect list this design corrects.

## 1. Motivation (the PRE-migration shape this spec replaced)

This section narrates the design problem as it stood before this spec
shipped — kept because §2's shape is derived from it, not because it's
current. See the Status line above for what actually exists now.

Before this migration, `Meta` was one open, all-optional interface, declared
in core with exactly two members:

```ts
export interface Meta {
  tags?: Tags;
  description?: string;
}
```

Core itself never declared a protocol namespace. Each projector
declaration-merged its own single key onto this same `Meta` interface — one
`declare module "@rhi-zone/fractal-api-tree/node" { interface Meta { http?:
HttpMeta } }` block in http-api-projector's project.ts, one for `openapi?:
OpenApiMeta` in its openapi.ts, one for `cli?: CliMeta` in cli-api-projector's
cli.ts, one for `mcp?: McpMeta` in mcp-api-projector's project.ts, one for
`jsonrpc?: JsonRpcMeta` in json-rpc-api-projector's project.ts, one for
`graphql?: GraphQLMeta` in graphql-api-projector's project.ts. Each of
`HttpMeta`/`CliMeta`/`McpMeta`/`JsonRpcMeta`/`GraphQLMeta`/`OpenApiMeta` was a
single FLAT interface owned entirely by its projector package, spanning
fields that in practice are read at different tree positions (leaf-only,
branch-only, or both — §4). A consumer could declaration-merge further onto
`Meta` too — e.g. a required `scopes: readonly string[]` on an op, so an
authorization check has something to enforce instead of silently treating
absence as "no scope required" (the sibling codebase's
`packages/fractal-support/src/meta.ts` did exactly this, as an OPTIONAL
`scopes?: readonly string[]` — §7 covers the migration this spec drove
there).

`HasRequiredKeys<T>` (`node.ts`) already existed to make requiredness legal:
`op()` and `api()` both flip their meta-parameter arity from "optional, folds
contributions" to "one required argument" the moment `HasRequiredKeys<T>` is
`true`. But against the single old `Meta`, the flip was global — a consumer
couldn't require a member on OPERATIONS only. A `declare module` block that
added `scopes: readonly string[]` to `Meta` made every `api()` branch call
require it too, even though a branch has no scope of its own to check.
Splitting `Meta` by ROLE (shared / leaf-only / branch-only) and running
`HasRequiredKeys` per-interface instead of once (the shape §2 describes,
now shipped) lets a consumer target the requirement at the position where
it's meaningful — and, independently of requiredness, lets each projector
split ITS OWN namespace by the same role axis, so a field only valid at one
position (e.g. `mcp.segment`, a branch-only field) stops typechecking at the
other.

## 2. Shape

Core declares three role interfaces, no `Partial<>` anywhere, and NOTHING
protocol-specific:

```ts
// packages/api-tree/src/node.ts

export interface SharedMeta {
  description?: string;
}

export interface LeafMeta extends SharedMeta {
  tags?: Tags;
}

export interface BranchMeta extends SharedMeta {}
```

That is the entire core surface. `tags` moves off the base `Meta`-equivalent
onto `LeafMeta` specifically, because every read site for it is leaf-gated —
verified: every `.tags` read in every projector reads `child.meta.tags` (or
`leafMeta.tags`/`resolved.leafMeta.tags`) inside a leaf-only walk, and each
site's neighboring comment says so explicitly ("the leaf's OWN meta.tags —
there is no ancestor inheritance", repeated near-verbatim across
`cli-api-projector/src/cli.ts`, `mcp-api-projector/src/project.ts`,
`json-rpc-api-projector/src/project.ts`, `http-api-projector/src/tags.ts`,
`graphql-api-projector/src/project.ts`). No projector reads `meta.tags` off
a branch node. `description` stays on `SharedMeta` (both leaf and branch
read it — §4, "`description` itself").

`Meta` itself is retired as a name in core; `op()`/`api()` are retargeted to
`LeafMeta`/`BranchMeta` respectively (§2a).

### Projectors export fragments, never augment

Every protocol namespace a projector owns is exported by that projector as
an INERT plain interface, split by role — never wrapped in a `declare
module` block. Each fragment is NAMESPACED — it carries its own single
property (`http?`, `mcp?`, `cli?`, …), matching today's `meta.http`/
`meta.mcp`/… runtime shape — not a flat merge of bare field names directly
onto the role interface. Where a single protocol namespace has members at
more than one role (true of `http`, `cli`, and `openapi` today — §4), the
projector declares its own local role split for the CONTENTS of that
namespace and exports each piece separately — still with no augmentation
anywhere in the package.

**Rule: the nested bag itself — the type of `meta.http`, `meta.mcp`, etc. —
must be a NAMED, EXPORTED interface, never an inline object-literal type.**
An inline literal (`http?: { moveTo?: string }` written directly, with no
separate named type) can't itself be declaration-merged or extended by
anything downstream — a deployer wanting to add its own field onto
`meta.http` without touching the projector's source would have nowhere to
hook in. Naming and exporting the bag (`HttpSharedMetaProperties`,
`HttpLeafMetaProperties`, …) keeps it as open to further extension as every
other interface in this design. E.g. http-api-projector:

```ts
// packages/http-api-projector/src/project.ts

export interface HttpSharedMetaProperties {
  moveTo?: string;
}

export interface HttpSharedMeta {
  http?: HttpSharedMetaProperties;
}

export interface HttpLeafMetaProperties extends HttpSharedMetaProperties {
  method?: string;
  verb?: string;
  response?: { status?: number; headers?: Record<string, string> };
  paginated?: {
    style?: "cursor" | "offset";
    inputCursorParam?: string;
    inputOffsetParam?: string;
  };
  validate?: StandardSchemaV1;
  sourceMap?: SourceMap;
}

export interface HttpLeafMeta {
  http?: HttpLeafMetaProperties;
}
```

`HttpLeafMetaProperties extends HttpSharedMetaProperties` (not `HttpLeafMeta
extends HttpSharedMeta`) is where the shared/leaf inheritance actually
lives — the wrapper interfaces (`HttpSharedMeta`, `HttpLeafMeta`) each stay
a single-property passthrough onto their respective properties interface,
which is what keeps `LeafMeta`'s inherited `http` member (via
`SharedMeta.http: HttpSharedMetaProperties`, once `SharedMeta extends
HttpSharedMeta` in the deployment's augmentation — §3) compatible with
`LeafMeta`'s own `http: HttpLeafMetaProperties` — required for TypeScript
to accept the redeclaration when a single deployment merges both role
interfaces' `http` contribution together.

mcp-api-projector, cli-api-projector, json-rpc-api-projector, and
graphql-api-projector each export the equivalent leaf/branch/shared
wrapper-plus-properties pair for their own namespace, per §4's
per-projector table (the table's "Exported on" column names the wrapper;
the properties interface it wraps follows the same
`{Protocol}{Role}MetaProperties` naming).
**Importing any projector package is now type-inert** — its `.ts` module
graph contains no `declare module` block, so `import type { HttpLeafMeta }
from "@rhi-zone/fractal-http-api-projector"` (or any transitive import that
pulls the package in) changes nothing about what `LeafMeta`/`BranchMeta`/
`SharedMeta` mean anywhere. Only the deployment's own augmentation (§3 below)
changes that.

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

## 3. The single deployment-owned augmentation file

**The deployment owns the meta type**, via exactly one `declare module`
block, written once, in a file the deployment authors (not a projector, not
core):

```ts
// e.g. the sibling codebase's packages/fractal-support/src/meta.ts

import "@rhi-zone/fractal-api-tree/node";
import type { HttpLeafMeta, HttpSharedMeta } from "@rhi-zone/fractal-http-api-projector";
import type { McpLeafMeta, McpBranchMeta } from "@rhi-zone/fractal-mcp-api-projector";

declare module "@rhi-zone/fractal-api-tree/node" {
  interface LeafMeta extends HttpLeafMeta, McpLeafMeta {
    scopes: readonly string[];
  }
  interface BranchMeta extends McpBranchMeta {}
  interface SharedMeta extends HttpSharedMeta {}
}
```

**Heritage clauses accumulate across merged interface declarations** — this
is the mechanism the whole design rests on, and is verified empirically
(scratch `tsc`, deleted after verification; see the note at the end of this
section): a `declare module` block augmenting `LeafMeta` with an `extends`
clause pulling in an imported projector fragment, PLUS a required member of
the deployment's own, behaves exactly like an ordinary interface
declaration with that heritage — confirmed three ways against a
minimal repro mirroring `op()`'s `HasRequiredKeys`-driven arity flip
(`node.ts:357-361`):

1. Once the augmented `LeafMeta` carries a required member (`scopes`), a
   zero-argument `op(fn)` call fails to typecheck — `HasRequiredKeys<LeafMeta>`
   correctly flips to `true` and the rest-parameter tuple type correctly
   demands at least one `LeafMeta` argument.
2. A contribution object literal supplying `scopes` plus the namespaced
   `http` bag pulled in transitively through the heritage clause (e.g.
   `{ scopes: [...], http: { verb: "GET" } }` — `http` is present on
   `LeafMeta` only because `LeafMeta extends HttpLeafMeta`, and
   `HttpLeafMeta`'s own `http` property is typed `HttpLeafMetaProperties`)
   typechecks cleanly — heritage-clause members are not second-class
   relative to members declared directly in the augmenting block, and this
   holds through a level of nesting, not just at the top.
3. Excess-property checking on an object literal passed directly as a
   contribution catches a misspelled OPTIONAL key NESTED inside the
   heritage-clause-inherited `http` bag (`{ http: { moveeTo: "../v2" } }`,
   `moveeTo` instead of `moveTo`) with the usual "did you mean" diagnostic —
   the same checking TypeScript already does for a directly-declared
   interface, unaffected by the member's having arrived via `extends`
   inside a `declare module` augmentation, and unaffected by the extra
   level of nesting the namespaced-fragment rule (§2) requires.

A transitive import of an unused projector changes nothing, because
projectors carry no augmentations (§2) — only importing a projector's
fragment types INTO the deployment's own `declare module` block, and naming
them in an `extends` clause there, has any effect. Requiredness (e.g.
the sibling codebase's `scopes`) errors locally at each scope-less `op()` call via the
existing flip (§2a), and only at leaf position — `api()`'s `BranchMeta` has
no `scopes` member unless the deployment separately puts one there, which
this design does not do (a branch has no scope of its own to enforce).

### 3a. The redeclare-replaces hazard, and why this shape avoids it

TypeScript's declaration merging is ADDITIVE only when every merged block
declares DISJOINT members. If two `declare module` blocks each redeclare the
SAME member of the SAME interface, the later-evaluated one does not merge
with the earlier one member-by-member — it silently REPLACES the member's
type outright, with no error. A prior (rejected) draft of this spec hit
exactly this hazard in its own worked example: it wrote `LeafMeta.cli` once
with the full `CliMeta` shape and then, in a "consumer-facing" illustration,
showed a second block redeclaring `LeafMeta.cli` without `hidden` — silently
dropping it, with no diagnostic anywhere (§9 regression item 2).

This design is structurally immune to that hazard, not just disciplined
about it: there is exactly ONE `declare module` block in the whole system
(the deployment's), so there is no second file for a member to be
redeclared IN. Within that one block, each projector fragment is named
once in an `extends` clause; TypeScript's ordinary multiple-heritage rule
(every extended interface's same-named member must be structurally
compatible) is the only constraint, and it applies exactly once, not
across files with different member sets racing to be "the" declaration.

## 4. Per-projector migration guidance

Grounded in read sites, not the type declarations alone — a key only counts
as "read at position X" if some projector actually reads it off a node at
that position. Per-PROJECTOR (which of that projector's OWN keys the
projector exports as a leaf/branch/shared fragment) — after §2/§3, core has
no protocol keys to list, and no projector file contains a `declare module`
block anymore; each row below names the plain interface the fragment lives
on inside the projector package, ready for a deployment to name in its own
`extends` clause.

### http-api-projector

| Key                                        | Exported on                                                                      | Evidence                                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.moveTo`                              | `HttpSharedMeta`                                                                 | `route.ts` §2b `applyMoveTo` (`route.ts:379-524`) relocates both single method-entries and whole subtrees — see §8 for the open question this still raises |
| `http.method`                              | `HttpLeafMeta`                                                                   | `applyMethods` rewriter, per method-entry (`project.ts:214-227`)                                                                                           |
| `http.verb`                                | `HttpLeafMeta`                                                                   | `verbFromTags` precedence step 1 (`tags.ts`)                                                                                                               |
| `http.response`                            | `HttpLeafMeta`                                                                   | `applyResponse` rewriter, per method-entry                                                                                                                 |
| `http.paginated`                           | `HttpLeafMeta`                                                                   | `extensions/pagination.ts:253-256` reads `getHttpMeta(ctx.meta).paginated` off the matched (leaf) route                                                    |
| `http.validate`                            | `HttpLeafMeta`                                                                   | `validateOf`/`route.ts:170-177` resolves the last `validate` directive off a leaf/method-entry's meta into `sources.validate`                              |
| `http.sourceMap`                           | `HttpLeafMeta`                                                                   | `sourceMapOf` resolves `meta.http`'s `source` directives per leaf (`route.ts:145`); **not read at branch position anywhere**                               |
| `openapi.security`                         | `HttpLeafMeta` — leaf-only now (§6 fixes the prior dual meaning)                 | field doc `openapi.ts:178-184`; per-operation read at `openapi.ts:461-467`                                                                                 |
| `openapi.securitySchemes`                  | `HttpSharedMeta`/`HttpLeafMeta` (read at both — collected across the whole tree) | `collectSecuritySchemes` walks the whole tree, methods included (`openapi.ts:221-238`; merges every node's and every method entry's bag)                   |
| `openapi.{operationId,summary,deprecated}` | `HttpLeafMeta`                                                                   | per-operation fields, destructured per method-entry (`openapi.ts:461-467`)                                                                                 |
| `openapi.description`                      | `HttpLeafMeta`                                                                   | per-operation override, same destructure (`openapi.ts:464,482`)                                                                                            |
| `openapi.tags`                             | `HttpLeafMeta`                                                                   | per-operation override, same destructure (`openapi.ts:465,483`)                                                                                            |

Dead `http` directive kinds (`segment`, `when`, `legacyPath`) and the
`dispatch` marker are parsed by `getHttpMeta` (`project.ts:243-296`) but
read by no current projector or consumer anywhere in the tree — verified by
searching every package for a read of `.segment`, `.when`, `.legacyPath`,
or the resolved `.dispatch` field outside `getHttpMeta`'s own body: none
exists. `project.ts`'s own module doc already documents `dispatch` markers
and the `legacyPath`/`segment`/`when` directives as retired in favor of the
`HttpRoute` pipeline (`project.ts:14-19`). This spec orders their deletion rather
than typed placement in either `HttpSharedMeta` or `HttpLeafMeta` — dead
code with a typed home is still dead code, and giving it one would let a
future author read it as live surface.

### cli-api-projector

| Key                          | Exported on     | Evidence                                                                                                |
| ---------------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `cli.hidden`                 | `CliSharedMeta` | `cli.ts:515` (leaf child), `cli.ts:531,537` (branch child, and the fallback subtree)                    |
| `cli.{name,alias,paginated}` | `CliLeafMeta`   | leaf-only display/behavior overrides (`cli.ts:517-520`, `CliMeta.paginated` doc `cli.ts:339-354`)       |
| `cli.sourceMap`              | `CliLeafMeta`   | `getCliMeta(target.leafMeta).sourceMap` (`cli.ts:1103`) — resolved against the matched LEAF's meta only |

### mcp-api-projector

| Key                                            | Exported on     | Evidence                                                                                                                       |
| ---------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `mcp.{name,title,annotations,as,uri,mimeType}` | `McpLeafMeta`   | `getMcpMeta(child.meta)` in the three per-surface leaf walks (`project.ts` `projectTools`/`projectResources`/`projectPrompts`) |
| `mcp.description`                              | `McpLeafMeta`   | leaf-only override, ranked above `meta.description`: `project.ts:396-404,645-648,817-825`                                      |
| `mcp.sourceMap`                                | `McpLeafMeta`   | `Dispatch.sourceMap` built per leaf handler (`project.ts:449,674,841`); **not read at branch position**                        |
| `mcp.segment`                                  | `McpBranchMeta` | wired: `project.ts:452-454,691,845` — a static child's own contribution to the name/URI prefix                                 |

### json-rpc-api-projector

| Key                              | Exported on         | Evidence                                                                             |
| -------------------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| `jsonrpc.{name,errorDataSchema}` | `JsonRpcLeafMeta`   | `JsonRpcMeta` fields, read per method during the tree walk (`project.ts:227-241`)    |
| `jsonrpc.description`            | `JsonRpcLeafMeta`   | leaf-only override, ranked above `meta.description` (`project.ts:208-213`)           |
| `jsonrpc.sourceMap`              | `JsonRpcLeafMeta`   | `Dispatch.sourceMap` per leaf (`project.ts:226`); **not read at branch position**    |
| `jsonrpc.segment`                | `JsonRpcBranchMeta` | wired: `project.ts:229` — a static child's own contribution to the dot-joined prefix |

### graphql-api-projector

| Key                                   | Exported on         | Evidence                                                                                                                                                                                                                                                    |
| ------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graphql.{operation,name,deprecated}` | `GraphQLLeafMeta`   | `deriveOperationType` (`project.ts`, precedence step 1), field-name override, deprecation override — all per-field (leaf)                                                                                                                                   |
| `graphql.deprecatedReason`            | `GraphQLLeafMeta`   | only meaningful alongside `deprecated`, same leaf scope (`directive-contract.md` §GraphQL)                                                                                                                                                                  |
| `graphql.description`                 | `GraphQLLeafMeta`   | leaf-only override, ranked above `meta.description` (`project.ts:310-314`)                                                                                                                                                                                  |
| `graphql.sourceMap`                   | `GraphQLLeafMeta`   | `GraphQLMeta.sourceMap`, resolved per field's arg assembly; **not read at branch position**                                                                                                                                                                 |
| `graphql.namespace`                   | `GraphQLBranchMeta` | declared (`GraphQLMeta.namespace`, `project.ts:73-74`) but **currently unwired** — the leaf-centric Query walk explicitly doesn't visit branch nodes to read it (`project.ts:483-488`: "branch-level `meta.graphql.namespace` is a later-phase refinement") |

### `description` itself (core `SharedMeta`, not a projector key)

| Key           | Read at         | Evidence                                                                                                                                                    |
| ------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description` | leaf and branch | `cli.ts:487-492`'s `descriptionFrom` is called on the current node at `buildHelp` top (branch, `cli.ts:502`) AND on leaf/branch children (`cli.ts:516,532`) |

## 5. Consumer-facing effects

- **The augmentation gotcha**: a `declare module` block augmenting one of
  these interfaces must be preceded by an `import` of the module it augments
  in the same file — a `declare module` with no preceding `import` SILENTLY
  SHADOWS the interface (replaces it) instead of augmenting it. This was hit
  empirically during feasibility testing for this split and is easy to get
  wrong copying an existing augmentation out of context. It matters more
  under this design than the rejected drafts, precisely because there is
  now only ONE augmentation file to get right — there's no second file's
  correct import to fall back on.
- **Position-invalid keys become unrepresentable.** `mcp.segment` on a
  leaf's `LeafMeta`, or `http.validate` on a branch's `BranchMeta`, stop
  typechecking instead of silently no-op'ing the way they do today (every
  key is currently legal everywhere; a projector's own walk is what decides
  whether it's read).
- **Requiredness travels with the declaration, at any nesting depth.** A
  deployer (e.g. the sibling codebase) wants `scopes: readonly string[]` required on
  every op, so an authorization wrapper can stop treating an absent
  `scopes` as "no enforcement" (a silent open route). Declaring that
  requirement directly on the augmented `LeafMeta` (not on `BranchMeta`)
  makes every scope-less `op()` call a compile error via the
  `FoldMeta<C> extends LeafMeta` check (§2a), without also demanding a
  `scopes` field from `api()` branch calls that have none to check.
- **A projector fragment's own optional members flow through the heritage
  clause exactly like directly-declared members** — confirmed by the §3
  verification: a `LeafMeta` built via `extends HttpLeafMeta, McpLeafMeta`
  type-checks contributions and reports excess-property errors on
  misspelled optional keys identically whether the member came from the
  deployment's own block or from an `extends`-inherited fragment.

## 6. `openapi.security`: one meaning, not two

Today `openapi.security` means two different things depending on WHERE it's
read, not just where it's authored — this is a dual-meaning key, the exact
defect §9(5) rules out:

- Per-operation (leaf/method-entry position): a requirement on that one
  operation. Doc comment `openapi.ts:178-184`; read per-operation at
  `openapi.ts:461-467`.
- Root position: read as the SPEC-LEVEL DEFAULT (`OpenApiDoc.security`),
  applied at `openapi.ts:414-416` (`const rootSecurity =
getOpenApiMeta(route.meta).security`).

This spec keeps only the per-operation (leaf) meaning as `openapi.security`
on `HttpLeafMeta`. The spec-level default moves out of `meta` entirely, into
the OpenAPI document builder's own OPTIONS parameter (a plain function
argument to `buildDoc`/`toOpenApi`, not a tree-authored value) — a document
has exactly one spec-level default security requirement, and it belongs
with the other document-level choices (title, servers, …) the builder
already takes as options, not smuggled onto the root node's meta where it
reads exactly like a per-operation override that happens to be authored one
level up. One key never means two things by position after this change;
the caller who wants a default now passes it explicitly to the builder
call, and every remaining `security` read is unambiguously per-operation.

## 7. Migration surface

Known collateral, found during feasibility testing and by reading the
current implementation directly:

- **Every projector's existing `declare module` block moves out** of
  `project.ts`/`openapi.ts`/`cli.ts` into plain exported interfaces (§2),
  and the reference deployment gains the single augmentation file
  described in §3. This touches all five projector packages
  (`http-api-projector/src/project.ts:67-71` and
  `http-api-projector/src/openapi.ts:199-203`,
  `cli-api-projector/src/cli.ts:361-365`,
  `mcp-api-projector/src/project.ts:320-324`,
  `json-rpc-api-projector/src/project.ts:139-143`,
  `graphql-api-projector/src/project.ts:95-99`) plus every deploying
  consumer.
- `mergeMeta`'s erasure casts (`node.ts:280-287`) — `mergeMeta` currently
  returns the erased `Meta`; with `Meta` retired in favor of the three role
  interfaces, either three merge functions (one per return role) or one
  merge function whose return type is threaded from the call site (§ open
  in the prior draft, not decided here either — see the note at the end of
  this section).
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

### Consumer story: the sibling codebase

`packages/fractal-support/src/meta.ts` today augments the single `Meta`
with an OPTIONAL `scopes?: readonly string[]`, and its module doc says so
explicitly ("Absent ⇒ no scope required"). `packages/fractal-support/src/scopes.ts`'s
`wrapScopes` reads `node.meta.scopes` and treats an absent-or-empty array
as "passes" (no enforcement) — multiple slice files across
`apps/web/src/server/api-fractal/*.ts` document this as a deliberate
default they rely on (e.g. `tax-compliance.ts:66`, `nps.ts:62`,
`push.ts:41`).

Under this spec, the sibling codebase's file becomes the deployment's single
augmentation (§3): `scopes` moves to `LeafMeta`, loses its `?` (becomes
required), and merges in whichever projector fragments the sibling codebase actually
uses (`HttpLeafMeta`, and any others it composes). Because `scopes` is now
required, every existing leaf that never declared it becomes a compile
error until given one — the migration's forcing function. Once every leaf
has an explicit `scopes` value, `wrapScopes`'s "absent means allow" branch
has nothing left to trigger on `absence`, so its EMPTY-array case is what's
left to decide: this spec's motivation (§1) is exactly to stop treating an
unscoped/unenforced op as the silent default, so `wrapScopes` flips empty
array to DENY (closing the silent-open-route hole), and any leaf that
genuinely wants no scope requirement must say so some other way (a
recognizable public/no-auth marker, not `scopes: []`) — that marker's shape
is the sibling codebase's own call, not decided by this spec.

## 8. What this spec does not decide

- **`http.moveTo`'s shared-role placement.** It's assigned `HttpSharedMeta`,
  since both single-operation and whole-subtree relocation are real,
  evidenced uses (`route.ts` §2b). But `moveTo` describes where THIS node
  goes, not where its descendants go — semantically it's
  "placement-of-self," a different axis than "placement-of-descendants"
  (which nothing currently expresses). No alternative placement is
  proposed here.
- Whether `mergeMeta` becomes three functions or one generic one.
- Implementation order / rollout sequencing across the five projector
  packages.
- The exact shape of the sibling codebase's "explicitly no scope required" marker
  (§7's consumer story) once `wrapScopes` flips to deny-by-default.

## 9. Regression checklist

Two prior drafts of this spec were rejected by the project owner. Any
future edit to this spec MUST NOT reintroduce any of the following:

1. **Protocol keys declared in core.** Core must not know any protocol
   name — full stop. Every protocol namespace is exported from its own
   projector package (§2), never authored in `node.ts`.
2. **Redeclare-replaces member loss.** A prior draft redeclared
   `LeafMeta.cli` and `LeafMeta.openapi` a second time with a narrower
   member set (dropping `hidden` from `cli`, dropping
   `security`/`securitySchemes` from `openapi`), which TypeScript silently
   treats as a replacement of that member's type, not a merge (§3a). Under
   this design there is only one augmentation file in the whole system, so
   there is no second file left to redeclare a member from — the hazard is
   removed structurally, not by discipline.
3. **All-optional taxonomy that makes requiredness inexpressible.** A
   design where every interface stays fully optional (including via a
   stray `Partial<>` wrapper) defeats the entire point of the split — the
   motivating consumer need (§5, §7) is a REQUIRED field at a specific role
   (`scopes` required on every op, not on branches). The split must
   preserve `op()`/`api()`'s existing `HasRequiredKeys`-driven arity flip,
   retargeted per-interface (§2a), not flatten it away.
4. **Projector-owned ambient augmentation.** The second (accepted-core,
   still-rejected) draft kept core protocol-blind but left every projector
   running its own `declare module` block, so the effective type of
   `LeafMeta`/`BranchMeta` depended on which projector packages happened to
   be transitively imported by a given compilation — a change nobody
   intended could flip on by adding an unrelated import. §2/§3 fix this:
   projectors export inert interfaces only; the deployment is the sole
   place any augmentation happens.
5. **Dual-meaning keys.** `openapi.security` meant a per-operation
   requirement at leaf position and a spec-level default at root position —
   the same key, two different meanings depending on where it was
   authored. §6 gives it one meaning (per-operation) and moves the other
   use out of `meta` entirely, into the document builder's own options.
6. **Handling code for retired directives.** `segment`, `when`,
   `legacyPath`, and the `dispatch` marker are parsed by `getHttpMeta` but
   read by no projector or consumer anywhere (§4's http-api-projector
   section) — this spec orders their parsing/resolution code deleted, not
   given a typed home that would let a future reader mistake them for live
   surface.
7. **A generic meta parameter threaded through `Node`.** Rejected: the
   augmentation mechanism in §3 makes it unnecessary — a deployment gets
   its own concrete, fully-merged `LeafMeta`/`BranchMeta`/`SharedMeta`
   without `Node` (or `op`/`api`) needing to be generic over a meta type
   parameter at every call site.
