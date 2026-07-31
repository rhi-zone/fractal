# Splitting `Meta` into `SharedMeta` / `LeafMeta` / `BranchMeta`

Status: design spec, not yet implemented. Scope: `packages/api-tree/src/node.ts`'s
`Meta` interface and every projector's `declare module` augmentation of it
(`http-api-projector`, `mcp-api-projector`, `cli-api-projector`,
`graphql-api-projector`, `json-rpc-api-projector`).

## 1. Motivation

Today `Meta` is one open, all-optional interface (`node.ts:43-53`):

```ts
export interface Meta {
  tags?: Tags
  description?: string
}
```

Every projector declaration-merges its own namespace onto it (`meta.http`,
`meta.cli`, `meta.mcp`, `meta.graphql`, `meta.jsonrpc`, `meta.openapi`), and a
consumer can declaration-merge further — e.g. a required `scopes: readonly
string[]` on an op, so an authorization check has something to enforce
instead of silently treating absence as "no scope required."

`HasRequiredKeys<Meta>` (`node.ts:55-65`) already exists to make this legal:
`op()` (`node.ts:357-359`) and `api()` (`node.ts:441-443`) both flip their
meta-parameter arity from "optional, folds contributions" to "one required
`Meta` argument" the moment `HasRequiredKeys<Meta>` is `true`. But the flip is
global — a consumer can't require a member on OPERATIONS only. A
`declare module` block that adds `scopes: readonly string[]` to `Meta` makes
every `api()` branch call require it too, even though a branch has no scope
of its own to check. Splitting `Meta` by ROLE (shared / leaf-only /
branch-only) and running `HasRequiredKeys` per-interface instead of once
lets a consumer target the requirement at the position where it's
meaningful.

## 2. Shape

Three interfaces, no `Partial<>`:

```ts
export interface SharedMeta {
  tags?: Tags
  description?: string
  cli?: { hidden?: boolean; /* ...rest of CliMeta, still optional per-key */ }
  http?: { moveTo?: string; /* ...rest of HttpMeta, still optional per-key */ }
  openapi?: { security?: OpenApiSecurityRequirement[]; securitySchemes?: Record<string, OpenApiSecurityScheme> }
}

export interface LeafMeta extends SharedMeta {
  tags?: Tags // already on SharedMeta; op()'s FoldMeta<C> requirement is enforced HERE
  http?: SharedMeta["http"] & {
    method?: string
    verb?: string
    response?: { status?: number; headers?: Record<string, string> }
    paginated?: { style?: "cursor" | "offset"; inputCursorParam?: string; inputOffsetParam?: string; inputLimitParam?: string }
    validate?: StandardSchemaV1
    sourceMap?: SourceMap
  }
  mcp?: { name?: string; title?: string; annotations?: McpAnnotations; as?: "tool" | "resource" | "prompt"; uri?: string; mimeType?: string; description?: string; sourceMap?: SourceMap }
  jsonrpc?: { name?: string; description?: string; errorDataSchema?: JsonSchema; sourceMap?: SourceMap }
  graphql?: { operation?: "query" | "mutation" | "subscription"; name?: string; deprecated?: boolean; deprecatedReason?: string; description?: string; sourceMap?: SourceMap }
  cli?: { name?: string; alias?: string; paginated?: { inputCursorParam?: string; inputOffsetParam?: string }; sourceMap?: SourceMap }
  openapi?: { operationId?: string; summary?: string; description?: string; tags?: string[]; deprecated?: boolean }
}

export interface BranchMeta extends SharedMeta {
  mcp?: { segment?: string }
  jsonrpc?: { segment?: string }
  graphql?: { namespace?: string } // declared, currently unwired — §5
}
```

Every key stays optional AT THE KEY (`?`) on all three interfaces —
directives are intrinsically optional; `Partial<>` is not used anywhere.
`op()`'s `FoldMeta<C> extends LeafMeta` check (`node.ts:183-189`, `357-363`)
enforces required members on the FOLDED contribution, not per-element — the
per-element `C extends readonly Meta[]` constraint on `op()`'s rest
parameter is what currently breaks composition: a required member on `Meta`
makes `http.get`'s own `VerbBundle` (a single `{ http: {...}, tags: {...} }`
contribution) fail to typecheck against `Meta` on its own, before it's ever
composed with anything that supplies the required field. Retyping that
constraint as `C extends readonly LeafMeta[]` doesn't fix this — the
individual `VerbBundle` element still doesn't carry the required member.
Fixing it needs the same right-to-left fold `FoldMeta<C>` already computes to
run BEFORE the `extends LeafMeta` check, not per-element — the composed
result must satisfy `LeafMeta`, not each ingredient.

`api()`'s `opts.meta` (`node.ts:441-443`) is single-valued (no fold), so its
`HasRequiredKeys<BranchMeta>` check is unchanged in kind, just retargeted
from `Meta` to `BranchMeta`.

## 3. Key-by-key table

Grounded in read sites, not the type declarations alone — a key only counts
as "read at position X" if some projector actually reads it off a node at
that position. Corrections to the initial usage inventory are called out
inline (see also §6).

### SharedMeta

| Key | Read at | Evidence |
|---|---|---|
| `description` | leaf and branch | `cli.ts:487-492`'s `descriptionFrom` is called on the current node at `buildHelp` top (branch, `cli.ts:502`) AND on leaf/branch children (`cli.ts:516,532`) |
| `cli.hidden` | leaf and branch | `cli.ts:515` (leaf child), `cli.ts:531,537` (branch child, and the fallback subtree) |
| `http.moveTo` | leaf and branch | `route.ts` §2b `applyMoveTo` (`route.ts:379-524`) relocates both single method-entries and whole subtrees — see §4 for the open question this still raises |
| `openapi.security` | leaf/method-entry and root (dual meaning) | field doc `openapi.ts:179-184`; per-operation read alongside `summary`/`tags` in the destructure at `openapi.ts:461-467`; root-as-spec-default read at `openapi.ts:414-416` |
| `openapi.securitySchemes` | any node | `collectSecuritySchemes` walks the whole tree, methods included (`openapi.ts:221-238`; merges every node's and every method entry's bag) |

### LeafMeta (extends SharedMeta)

| Key | Evidence |
|---|---|
| `tags` | read directly off each leaf's own meta, no ancestor inheritance (`directive-contract.md` §Agnostic tags; `tags.ts`) |
| `http.method` | `applyMethods` rewriter, per method-entry (`route.ts`, HttpMeta field `project.ts:222-223`) |
| `http.verb` | `verbFromTags` precedence step 1 (`tags.ts`; `HttpMeta.verb`, `project.ts:214-215`) |
| `http.response` | `applyResponse` rewriter, per method-entry (`HttpMeta.response`, `project.ts:226-227`) |
| `http.paginated` | `extensions/pagination.ts:253-256` reads `getHttpMeta(ctx.meta).paginated` off the matched (leaf) route |
| `http.validate` | `validateOf`/`route.ts:170-177` resolves the last `validate` directive off a leaf/method-entry's meta into `sources.validate` |
| `http.sourceMap` | `sourceMapOf` resolves `meta.http`'s `source` directives per leaf (`route.ts:145`); **not read at branch position anywhere** |
| `mcp.{name,title,annotations,as,uri,mimeType}` | `getMcpMeta(child.meta)` in the three per-surface leaf walks (`project.ts` `projectTools`/`projectResources`/`projectPrompts`) |
| `mcp.description` | leaf-only override, ranked above `meta.description`: `project.ts:396-404,645-648,817-825` |
| `mcp.sourceMap` | `Dispatch.sourceMap` built per leaf handler (`project.ts:449,674,841`); **not read at branch position** |
| `jsonrpc.{name,errorDataSchema}` | `JsonRpcMeta` fields, read per method during the tree walk (`project.ts:124-136`) |
| `jsonrpc.description` | leaf-only override, ranked above `meta.description` (`project.ts:208-213`) |
| `jsonrpc.sourceMap` | `Dispatch.sourceMap` per leaf (`project.ts:226`); **not read at branch position** |
| `graphql.{operation,name,deprecated}` | `deriveOperationType` (`project.ts`, precedence step 1), field-name override, deprecation override — all per-field (leaf) |
| `graphql.deprecatedReason` | only meaningful alongside `deprecated`, same leaf scope (`directive-contract.md` §GraphQL) |
| `graphql.description` | leaf-only override, ranked above `meta.description` (`project.ts:310-314`) |
| `graphql.sourceMap` | `GraphQLMeta.sourceMap`, resolved per field's arg assembly; **not read at branch position** |
| `cli.{name,alias,paginated}` | leaf-only display/behavior overrides (`cli.ts:517-520`, `CliMeta.paginated` doc `cli.ts:339-354`) |
| `cli.sourceMap` | `getCliMeta(target.leafMeta).sourceMap` (`cli.ts:1103`) — resolved against the matched LEAF's meta only |
| `openapi.{operationId,summary,deprecated}` | per-operation fields, destructured per method-entry (`openapi.ts:461-467`) |
| `openapi.description` | per-operation override, same destructure (`openapi.ts:464,482`) — **missing from the initial inventory** |
| `openapi.tags` | per-operation override, same destructure (`openapi.ts:465,483`) — **missing from the initial inventory** |

### BranchMeta (extends SharedMeta)

| Key | Evidence |
|---|---|
| `mcp.segment` | wired: `project.ts:452-454,691,845` — a static child's own contribution to the name/URI prefix |
| `jsonrpc.segment` | wired: `project.ts:229` — a static child's own contribution to the dot-joined prefix |
| `graphql.namespace` | declared (`GraphQLMeta.namespace`, `project.ts:73-74`) but **currently unwired** — the leaf-centric Query walk explicitly doesn't visit branch nodes to read it (`project.ts:483-488`: "branch-level `meta.graphql.namespace` is a later-phase refinement") |

Retired/dead `http` directive kinds (`segment`, `when`, `legacyPath`,
`dispatch`) are not placed in any of the three interfaces above — they are
parsed but read by no current projector (`directive-contract.md` §HTTP,
rows `segment`/`when`/`legacyPath`). Whether they belong in `LeafMeta` as
dead-but-typed members, or should be dropped from `HttpMeta` entirely as
part of this split, is open — not decided here.

## 4. Open judgment calls (not decided here)

1. **`http.moveTo` is assigned `SharedMeta`**, since both single-operation
   and whole-subtree relocation are real, evidenced uses (`route.ts` §2b).
   But `moveTo` describes where THIS node goes, not where its descendants
   go — semantically it's "placement-of-self," a different axis than
   "placement-of-descendants" (which nothing currently expresses). Someone
   may argue this makes it a bad fit for a bag whose other Shared members
   (`description`, `cli.hidden`, `openapi.security`) are genuinely dual-read
   for the same reason at both positions, rather than dual-read because one
   node happens to relocate itself regardless of role. No alternative
   placement is proposed here.

2. **`openapi.security` is assigned `SharedMeta`**, but its MEANING differs
   by position: on a leaf/method-entry it's a per-operation requirement
   (`openapi.ts:179-181`); on the root it's the spec-level default
   (`openapi.ts:182-184`, applied at `openapi.ts:414-416`). Nothing else in
   `SharedMeta` has position-dependent MEANING (only `moveTo` and
   `description` have position-dependent APPLICABILITY, which is a weaker
   claim). This needs a doc line wherever `SharedMeta` is introduced to
   readers. Whether that difference in kind — same key, different meaning
   in different positions — warrants a real type split (e.g. a
   root-flagged variant vs. a plain per-operation one) instead of a shared
   optional key is an open question, not resolved here.

## 5. Consumer-facing effects

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
- **Motivating consumer**: a deployer wants `scopes: readonly string[]`
  required on every op, so an authorization wrapper can stop treating an
  absent `scopes` as "no enforcement" (a silent open route). Declaration-
  merging that requirement onto `LeafMeta` (not `Meta`) makes every
  scope-less `op()` call a compile error, without also demanding a `scopes`
  field from `api()` branch calls that have none to check.

## 6. Migration surface

The role axis (shared / leaf / branch) is orthogonal to the existing
per-protocol namespace axis (`meta.http`, `meta.mcp`, …) — each namespace
already spans leaf, branch, and (for `http`/`cli`/`openapi`) shared keys (§3).
So every projector's `declare module` augmentation of `Meta` splits into up
to three separate augmentations (one onto `SharedMeta`, one onto `LeafMeta`,
one onto `BranchMeta`), and every read site that currently takes a bare
`Meta` re-anchors to whichever of the three actually applies at that call
site.

Known collateral, found during feasibility testing:

- `mergeMeta`'s erasure casts (`node.ts:280-287`) — `mergeMeta` returns the
  erased `Meta`; with three interfaces, either three merge functions or one
  merge function whose return type is threaded from the call site.
- `httpRoute`'s `meta: {}` placeholder nodes (`route.ts:110-125`,
  specifically `meta: def.meta ?? {}` at `route.ts:122`) — an empty object
  literal must satisfy whichever interface is asked for at that call site;
  trivial for an all-optional interface, but every such placeholder needs
  its type re-checked once the interface it satisfies is no longer always
  the single `Meta`.
- `dx.ts`'s `crud()` (`http-api-projector/src/dx.ts`) composes multiple
  `op(handler, http.get, ...)`-style calls, each contributing a `VerbBundle`
  (`verbs.ts:87-160`) through `op()`'s folded rest parameter — this is
  exactly the composition path §2 shows breaking today when `LeafMeta` gains
  a required member, since each individual `VerbBundle` contribution doesn't
  itself carry that member.
- Test fixtures using bare `api({})` (`node.test.ts:61,203`,
  `project.test.ts:198,255`) — `{}` must satisfy `BranchMeta` at these call
  sites; still trivial while every `BranchMeta` key stays optional, but worth
  enumerating since these are exactly the call sites `HasRequiredKeys`
  changes the arity of.

## 7. What this spec does not decide

- The two open judgment calls in §4.
- Whether the four dead `http` directive fields (`segment`, `when`,
  `legacyPath`, `dispatch`) get typed placement or get dropped.
- Whether `mergeMeta` becomes three functions or one generic one.
- Implementation order / rollout sequencing across the five projector
  packages.
