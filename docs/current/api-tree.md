> Rejected. Not a template and not a reference.
>
> First attempt at a per-package understanding doc. Wrong on register, wrong on density, and its file:line citations go stale on the next edit. Kept only as something for the next attempt to be measured against.

# `@rhi-zone/fractal-api-tree`

`packages/api-tree` — the tree model every protocol projector (`http-api-projector`,
`cli-api-projector`, `mcp-api-projector`, `graphql-api-projector`, …) projects from. This
doc is not an export listing (see `docs/api/index.md` and the `.d.ts` files for that); it's
what a consumer needs to know that the type signatures alone won't tell them: the model this
package commits to, the decisions baked into it, the invariants callers must respect, and the
things that would genuinely surprise someone who only read the exports.

Cross-references in this doc are to `packages/api-tree/src/*.ts` unless stated otherwise.

## What this package is

Two things live in it, kept in one package because everything downstream is either the model
itself or built directly on it:

1. **The function-core spine** (`index.ts`) — `Fn`, `compose`/`pipe`, `Result<T,E>`, and the
   derived Kleisli/applicative combinators (`composeK`/`collect`). The base is plain `T => U`
   plus function composition; Kleisli forms are derived and strictly less general, never the
   primitive (`docs/design/invariants.md`'s "Core = plain functions + composition").
2. **The Node/Op/Meta tree model** (`node.ts`, `tree.ts`, `tags.ts`, `input.ts`, and the
   build-time extraction/codegen support around them) — `op()`/`api()` as the only two node
   constructors, an open per-node metadata bag, and a type-level tree walker that recovers
   tree structure and each leaf's true handler signature from TypeScript's checker rather
   than from AST pattern-matching on `op(...)`/`api(...)` call shapes.

A protocol projector (HTTP, CLI, MCP, GraphQL) never lives in this package — it depends on
`api-tree`, never the reverse (`apply-validation.ts`'s module doc comment). That asymmetry is why several
mechanisms here (validation wiring, context shapes, OTel/auth adapters) are built to work
_structurally_, without importing a single type from any projector package — see "Staying at
the bottom of the dependency graph" below.

## The model

**One node shape, two constructors, no third kind.** `op(fn, ...contributions)` produces a
leaf (carries `handler`); `api(children, opts?)` produces a branch (carries `children`).
Earlier constructor names (`node({children})`, `service()`) were unified away — current code
has only these two (`docs/design/invariants.md`'s "Stale constructor names" note, confirmed
current in `node.ts`'s module doc comment).

**A node can carry both `handler` and `children`.** The module doc calls this out explicitly
as "uncommon but valid" (`node.ts`'s module doc comment) — nesting is never automatically flattened or merged;
the tree is exactly what's authored. A consumer building a generic recursive projection over
an arbitrary `Node` should not assume leaf-xor-branch; `op()`'s return type does mark
`handler` as required (narrower than `Node`'s own optional `handler?`) specifically so a
conditional type can distinguish "produced by `op()`" from "produced by `api()` alone"
(`node.ts`'s `op()` doc comment, and `op()`'s/`api()`'s return types) — but that's a discriminator for _construction provenance_, not a
guarantee that a node lacks the other field.

**Metadata is an open, per-node bag — not a second source of truth.** `meta` holds only
non-type-expressible projection/taste concerns (verb, segment, idempotency, auth); domain data
is always inferred TS types + JSDoc, never re-stated in `meta` (`node.ts`'s `SharedMeta` interface doc comment,
`docs/design/invariants.md`). Core itself declares no protocol namespace (no `meta.http`
etc.) and performs no `declare module` augmentation of its own role interfaces — each
projector exports its own namespaced fragment as an inert interface, and exactly one
deployment-owned file is expected to merge them all in via `extends`
(same `SharedMeta` doc comment; see `docs/design/meta-role-split-spec.md`).

**Tags do not inherit by tree position.** `meta.tags` (`tags.ts`) is a small, three-valued
(`true`/`false`/`undefined` — never a default-`false` inference) set of standard behavioral
tags (`readOnly`, `idempotent`, `destructive`, `openWorld`, `streaming`, `deprecated`) plus a
fixed implication/conflict pass, `resolveTags`:

- `readOnly ⇒ idempotent`: lifts `idempotent` from unset to `true`, never overrides an
  explicit value (`resolveTags`).
- `readOnly ∧ destructive` (both asserted `true`) resolves to a `conflict` string on the
  result — not thrown, not auto-corrected; the caller decides what to do with it
  (`resolveTags`).
- A derived-return-type `stream` shape (`AsyncIterable<T>`) implies `streaming: true` only
  when the tag is unasserted either way; an explicit `true` or `false` always wins over the
  derivation (`resolveTags`).
- `openWorld` is declared as a "standard" tag alongside the others but its only defined effect
  is forwarding to MCP's `openWorldHint` — it has no HTTP projection at all (`TAG_OPEN_WORLD`'s
  doc comment in `tags.ts`).
  A reader treating all "standard" tags as protocol-agnostic by default would be surprised by
  this one asymmetry.

Tag inheritance-by-position (a node picking up its nearest ancestor's tags) was deliberately
_removed_: "a node's tags are exactly what's on the node — they do not depend on ancestors.
Inheritance-by-position would break composability: moving a subtree would silently change its
behavior" (`tags.ts`, near `resolveTags`). `mapNodes`, a pre-order tree visitor, is the documented
replacement primitive for a transform that explicitly wants to propagate something downward —
this is a real design reversal a reader of `tags.ts`'s exports alone would have no way to
know had ever been tried the other way.

`unvalidated` is a seventh entry in the `Tags` bag but is **not part of the implication
lattice** — `resolveTags` never reads it. It's a build-time-only escape hatch, read directly
off `meta.tags` by the validation-coverage check (`TAG_UNVALIDATED`'s doc comment in `tags.ts`,
`apply-validation.ts`) to
exempt a leaf from requiring a generated validator.

## `mergeMeta`: the precedence rule a caller composing contributions must know

`op()`/`api()` both accept a variadic list of meta contributions
(`op(fn, http.get, extraTags)`), deep-merged left-to-right via `mergeMeta`/`mergeRecords`
(`node.ts`'s `mergeMeta` and `mergeRecords` functions). The rules:

- Later argument wins per key. `undefined` in a later bag _defers_ — it does not clobber an
  already-set value (`mergeMeta`'s doc comment, enforced by `mergeRecords`'s `undefined` check).
- Plain objects merge recursively; arrays concatenate, they don't replace (`mergeRecords`).
- **Recursion is capped at depth 2.** A `meta.x.y` collision merges field-by-field, but a
  3-level-deep value (`meta.http.sourceMap.<paramName>`, e.g. two composed `http.source()`
  calls naming the same param) replaces **wholesale** on collision — the later call's
  `{store, key?}` fully replaces the earlier one's, it does not inherit a `key` the later call
  omitted. This is not an incidental limitation: an earlier unbounded runtime merge actually
  shipped, and it silently diverged from the (also depth-capped) type-level fold — composing
  two `http.source()` calls on the same param, where the second omits `key` relying on
  `assemble()`'s "defaults to param name" behavior, resurrected the _first_ call's stale `key`
  at runtime while the type checker reported the correct (wholesale-replaced, no-`key`)
  result. The depth cap was added specifically to make the runtime match the type level
  (`mergeRecords`'s doc comment on the depth cap). **Consequence for an author:** composing two `meta.http.sourceMap`
  (or any other 3-level-deep keyed-map) contributions on the same node is a full-value
  overwrite per colliding key, never a field-level merge — don't rely on a later contribution
  supplying only the field it wants to change.

## `op()` checks the _merged_ result, not each contribution individually

When `op()`'s contributions declare required `LeafMeta` fields (e.g. a deployment that
declaration-merges a required `scopes` field onto `LeafMeta`), the check runs against the
`mergeMeta`'d result of all contributions together, not against each one separately
(`node.ts`'s `op()` doc comment and parameter type — see the surrounding doc comment). This is why a verb bundle
(`http.get`) that carries no `scopes` of its own can still compose with a _sibling_
contribution that does — checking each contribution in isolation would reject that
composition even though the combined meta is valid.

## Static param-coverage checking is real but has a documented blind spot

`op()` statically rejects (a compile error naming the offending param) a `source()`-declared
param name the handler doesn't actually take as input (`node.ts`'s `CheckedContributions` type, `input.ts`'s
`UncoveredSourceParams` type). This check **only fires when the handler's input keys are
statically known**; a handler typed against `Record<string, unknown>`, or with no typed input
at all, makes the check vacuous. A consumer relying on this to catch a `sourceMap` typo needs
a concretely-typed handler input — an untyped one gets no such protection.

That check also can never catch the other two resolution paths `assemble()` uses (see next
section) — only an explicit `source()` override is checkable this way; a path-slug-name match
or the primary-store convention depend on the live tree position / live request and are
invisible to a single leaf's own static type.

## `assemble()`'s field resolution order is fixed, not configurable per call

`assemble()` (`input.ts`) is the one function every projector's request-time input resolution
funnels through. Its resolution order is exactly three steps, in this order, and is not
something a caller can reorder per call (`assemble()`'s doc comment in `input.ts`):

1. A path/positional param name match → bound from the `"path"` store.
2. An explicit `sourceMap` override.
3. The primary-store convention for that protocol/method.

**Consequence:** a handler param that happens to share a name with a path slug is _always_
bound from `path`, even if the author's intent was a `sourceMap` override for that same name —
step 1 wins outright, before step 2 is even consulted. This has no compile-time signal; it's a
runtime resolution-order fact, not visible from `assemble`'s or `op`'s type signatures.

A related, explicitly-documented imprecision: for an HTTP field with no explicit `sourceMap`
entry, on a non-GET/HEAD/DELETE method, `op()`'s own isolated-leaf view can only report a
_union_ of possible wire encodings (`WireOf<T,"query"> | WireOf<T,"json">`), because `op()`
cannot see the tree position it will eventually be mounted at, and a same-named path slug vs.
a JSON-body field can decode differently (`input.ts`'s `EncodingMapWireOf` type). This is called out in source as
sound-but-imprecise, and is resolved _exactly_ — not just narrowed — by `wire-derive.ts` at
codegen time, which has full tree-position visibility (see below). A consumer hand-authoring
a custom decoder function against `op()`'s own inferred parameter type should expect the
union, not a single resolved type.

## `http.moveTo` never changes which store a field binds to

`wire-derive.ts`, which computes each leaf's protocol/store binding at codegen time, reads a
leaf's **local, pre-projection path segments** — never its final, post-`moveTo` mounted
position — to derive the binding (`wire-derive.ts`'s module doc comment, implemented in `deriveFieldProfiles`). `http.moveTo` is purely an address
transform; a leaf's field↔store binding is a pure function of its own _authored_ ancestry,
fixed before `moveTo` ever runs. This supersedes an earlier design where a relocated leaf's
binding depended on where it ended up mounted — a real "why is it this way and not the
obvious other way" decision: the obvious alternative (bind against final position) was tried
and walked back.

## Validation wiring: `applyValidation`, not `wrapValidators`

**Comment-rot flag, confirmed by direct read, not carried forward as fact elsewhere in this
package:** a number of comments across this package (`discover.ts` near its top and near
`findEntryFiles`, `tags.ts` near `TAG_UNVALIDATED`, and — checked further while confirming
this note — also `otel.ts`, `index.ts`, `tree.ts`, `extract.test.ts`,
`otel.integration.test.ts`, and a couple of test fixture files) still describe validators as
wired by a `build.ts` function called `wrapValidators` throwing an `UnvalidatedLeafError`.
This is broader than a single-file comment-rot spot; it's a naming convention that rotted
package-wide when the mechanism was replaced. That function no longer exists — `build.ts`
currently contains only the `GeneratedEntry` type. `build.ts`'s own module doc already
states the current mechanism correctly: `applyValidation(key, projectedTree, protocol?)` in
`apply-validation.ts` is "the only validation mechanism" (`apply-validation.ts`'s module doc
comment) — `createFetch`, `createMcpServer`, `runCli`, and `createGraphQLServer` all wire
through it. The current coverage check is `assertValidationCoverage`, which throws
`UncoveredLeafError` (not `UnvalidatedLeafError`) — a second naming drift alongside the
`wrapValidators` rot. The stale references are exactly the kind of comment rot this doc
effort exists to catch; a reader should trust `apply-validation.ts`'s own doc comments over
the older references still sitting in the files named above.

The current mechanism, as actually implemented:

- `createApplyValidation(validators, wireValidators?)` returns a rewriter,
  `applyValidation(key, tree, protocol?)`, that structurally walks a _projected_ tree (an
  `HttpRoute`, or the raw `Node` tree for protocols with no separate projected type) and wraps
  each matching leaf's handler to run a generated `parse` before the real handler
  (`apply-validation.ts`'s module doc comment).
- **2-arg vs. 3-arg calls resolve against different maps, and the precedence is a real
  contract, not just documentation:** a 2-arg call (`protocol` omitted) resolves first against
  the hand-authored `ValidatorMap`, and only if absent there, falls back to `WireValidatorMap`
  tagged `"identity"` — an omitted `protocol` argument is sugar for `"identity"` _at the
  codegen layer itself_, not merely a documentation convention (`resolveForKey`).
  A hand-authored `ValidatorMap` entry for a key always takes precedence over generated
  `identity`-profile coverage for that same key, even after codegen has run. A 3-arg call
  resolves exclusively against `WireValidatorMap`.
- **Each `key` may be used at most once per `createApplyValidation` result, regardless of
  `protocol`.** A second `applyValidation(sameKey, …)` call throws — `usedKeys` is tracked by
  key alone, not key+protocol, specifically so reusing one key under two different protocols
  is an error rather than a silent last-write-wins (`createApplyValidation`'s doc comment and
  body). A
  tree that needs validation under two protocols must use two distinct keys.
- **The pass-through stub (`createApplyValidation({})`) is silent by design.** A freshly
  scaffolded project's stub generated module leaves every tree unchanged with no error — this
  lets the one import compile and run before codegen has ever produced anything. Coverage is
  enforced only by a separate, explicitly-called `assertValidationCoverage`
  (`UncoveredLeafError`) — never automatically by `applyValidation` itself
  (`createApplyValidation`'s doc comment). A consumer who forgets to call
  `assertValidationCoverage` in their build gets silently-unvalidated leaves with no runtime
  signal.
- **Function-form `encodingMap` decoders are checked eagerly, at wrap time, not lazily at
  first request.** If codegen's static expectations and the live tree's actual decoder
  functions disagree in either direction, resolving hooks throws immediately when
  `applyValidation` runs, not on the first request that would have hit the mismatched field —
  a deliberate "loud, not silent" choice.
- **The decoder function itself never moves through codegen.** Codegen only detects whether a
  callable exists at a given `encodingMap` field (an existence check); the real closure is
  read off the _live_ tree's `meta` at wrap time. This is why a decoder can safely close over
  runtime values (e.g. a request-scoped cache) even though codegen is aware of its presence
  (`GeneratedEntry`'s doc comment in `build.ts`).
- `GeneratedEntry` and `schema-build.ts`'s JSON-Schema `SchemaMap` are the only reified
  artifacts in this package that look schema-shaped, but both are mechanically _derived_ from
  the same extracted `TypeRef` (itself derived from real TS types + JSDoc) — never
  independently authored. They're kept as two separate generated modules specifically so a
  JSDoc-only edit doesn't dirty the compiled-validator module's generated bytes
  (`schema-build.ts`'s module doc comment). Neither contradicts the "types + JSDoc are the only source of
  truth" invariant; both are compiled derivatives of it, regenerated by codegen.

## Extraction (`extract.ts`, `tree.ts`): types + JSDoc, no exceptions, degrade honestly

`tree.ts` walks an authored tree **at the TypeScript type level** — via the checker, not by
pattern-matching `op(...)`/`api(...)` call expressions in the AST — because `op()`/`api()`'s
return types are themselves literal-preserving (`const` type params), so the checker's
resolved type of an exported tree already carries the full leaf/branch/meta-literal structure
without needing to trace intermediate local variables or generic instantiations
(`tree.ts`'s `walkNodeType` function). The leaf/branch discriminator this walker uses is structural: a required
`handler` on the resolved type means leaf, a required `children` means branch — which is
exactly why `op()`'s return type deliberately narrows `handler` from `Node`'s
declared-optional to required (`node.ts`'s `op()`/`api()` return types).

A small amount of AST access is still unavoidable: a leaf's underlying function _node_ (for
JSDoc text and parameter/return annotations) has to come from the handler type's call
signature's own `.declaration`, since the type system alone only ever gives back a resolved
type, never the original source node (`tree.ts`'s `functionNodeOfHandler` function).

**Only two exported-tree shapes are recognized:** a top-level `export const x = api(...)`, or
a top-level `export function f(...)` whose _last statement_ is an unconditional return. Any
other export shape — conditional returns, a multi-branch body — silently doesn't count as a
tree export (`tree.ts`'s `returnExpressionOfFactoryBody` and `forEachTreeCandidate` functions,
which `hasTreeExport` builds on). A consumer writing a more elaborate tree-factory function needs to keep it to
this shape or it won't be picked up by `hasTreeExport`/discovery at all.

`extract.ts` genuinely takes only TS types + JSDoc as input — there is no hand-authored
schema anywhere in it. Anything it can't confidently resolve degrades to `unknown` with a
`$comment` marker, visible in the emitted artifact — it never fails silently and never falls
back to a second source of domain truth. Two things worth knowing if you author handlers with
elaborate types:

- **`Result<T,E>` unwrapping is genuinely two-path**, forced by `skipLibCheck: true`: under
  that setting, TypeScript leaves alias instantiations like `Result<T,E>` "unresolved," so
  the primary path is _syntactic_ — it walks the function's own return-type annotation AST
  node looking for a `TypeReference` literally named `"Result"` (handling
  `Promise<Result<T,E>>`, renamed re-exports, and further local aliases). A _structural_
  fallback (exact `{kind:"ok"|"err"}` shape match) only fires for inferred/unannotated return
  types. A handler whose return type is annotated via a renamed local alias with no
  traceable `Result<...>` body in reach of the syntactic patterns will punt to `unknown`
  (visibly, via `$comment`) rather than error (`extract.ts`'s `typeRefFromReturnType` function,
  which combines the syntactic `resultTypeArgNodeFrom` path with the structural
  `structuralResultValueType` fallback).
- A named type's declaration-file provenance (`meta.typeName`/`meta.declarationFile`) is
  attached only to the outer handler-parameter type, never recursively to nested named types
  — a nested field typed `Address` is always inlined structurally with no import-tracing
  metadata of its own (`extract.ts`'s `typeProvenanceOf` function).

## Name-collision safety: `escapeJoin` fixes derived-name collisions, not authored-override ones

Every projector's flat-name derivation (MCP tool names, JSON-RPC methods, GraphQL keys, CLI
completion levels) needs to join tree-position segments into one string. A naive
`prefix + delimiter + segment` join is not injective: two structurally different trees can
collide on the same string whenever an authored segment itself contains the delimiter
character (e.g. delimiter `"_"`: branch `"books"` → leaf `"get"` joins to `"books_get"`, the
same string a leaf literally named `"books_get"` at the root also produces) — `path.ts`'s module doc comment (see `escapeJoin`).
`escapeJoin` closes this with backslash-escaping, proven injective by a round-trip test
(`unescapeJoin(escapeJoin(x)) === x`) rather than merely asserted. The delimiter is
constrained to exactly one character — a multi-character delimiter breaks the scheme's own
injectivity (concrete counterexample in `assertValidDelimiter`'s doc comment in `path.ts`); every real caller in the codebase
uses a single character, so this is a real but currently-inert constraint.

**This closes only derived-name collisions, not authored-override collisions.**
`assertUniqueName` (`tree.ts`) still exists and still throws when two tree positions'
_authored_ overrides (`meta.mcp.name`/`meta.mcp.segment`/`meta.mcp.uri`) collide, because an
override supplies a final string outright, bypassing `escapeJoin` entirely
(`assertUniqueName`'s doc comment in `tree.ts`, and the leaf-name-override call sites
`nameOverride ?? escapeJoin(...)`). A reader might assume `escapeJoin`'s injectivity makes
`assertUniqueName` redundant; it does not — they cover two different collision sources.

Also worth knowing: a bare tool/leaf name recovered by `extractToolSchemas`/
`extractToolTypeRefs` is unique only _within one standalone tree_, "by convention" — it is not
safe to merge names across multiple files' trees composed into one root.
`extractRouteSchemas`/`extractRouteTypeRefs`'s `treeId`-prefixed path keying exists
specifically for that composed-root case (`extractRouteSchemas`'s doc comment in `tree.ts`); a first-time consumer building
a multi-file composed tree needs the path-keyed variant, not the name-keyed one.

## `reachability.ts` is build-tooling reachability, not tree/routing reachability

Despite the name, this module has nothing to do with which API-tree nodes are reachable via
dispatch. It's a build-time TypeScript **module-graph** reachability utility: given one shared
`ts.Program` spanning many entry files (a batch-codegen setup — one entry per domain slice), it
computes each entry's own transitive _import closure_ so the incremental build cache
(`cache.ts`) can invalidate only the entries whose source actually changed, not the whole
shared batch (`reachability.ts`'s module doc comment). It works by reading `ts.SourceFile.imports` — an
internal, undocumented field, not part of the public `SourceFile` interface, but verified
present at runtime against the pinned TypeScript version and isolated behind one narrow cast
specifically so a future TypeScript upgrade that removes or renames it fails loudly (every
cache entry permanently misses, visible as "always rebuilds") rather than silently
miscompiling (`reachability.ts`'s `moduleSpecifiersOf` function). A known, explicitly-flagged gap: triple-slash
reference directives and ambient `.d.ts` files reached only through tsconfig `types`/`include`
(never a real `import`) are not captured — verified not to currently matter in this monorepo
(no triple-slash directives exist under `packages/`), but flagged in source as a real
limitation if that ever changes (`reachability.ts`'s module doc comment, "Not captured" section).

## `discover.ts`: autodetection with a deliberate include/exclude order

`findEntryFiles` recursively scans one or more roots and keeps the files `hasTreeExport`
confirms actually export a tree, replacing a hand-maintained entry-file list (the failure mode
it closes: a new file silently gets no validators until someone remembers to add it to a
list). `exclude` is applied before `include`, so an explicit `include` always wins on the same
file — called out in source as an intentional choice to avoid a silent ordering accident, not
an arbitrary pick (`discover.ts:39-41`). A `string` `include` can force in any file (and throws
loudly if it doesn't exist); a `RegExp` `include`/`exclude` can only re-select among files the
scan under `roots` already found — it cannot reach outside `roots` (`discover.ts:23-38`).
`.d.ts` and `.test.ts`/`.spec.ts` files are excluded from candidacy unconditionally, regardless
of the `extensions` option passed (`discover.ts:97-99, 138-142`).

## Staying at the bottom of the dependency graph

`context.ts`, `auth.ts`, and `otel.ts` all use the same trick to integrate tightly with
projector-specific shapes (CLI/MCP context, auth adapters, OTel spans) without ever importing
a type from a projector package (which would create the package cycle `api-tree` is supposed
to sit underneath): each module redeclares the shape it needs _structurally_ and relies on
TypeScript's structural typing to make the real projector type assignable with no import or
cast. This is a consistent, named architectural pattern across the package, not three
unrelated tricks — worth recognizing as one thing if you see it again elsewhere.

One concrete behavioral contract riding on this: `auth.ts`'s `authLayer`/`authMiddleware`,
given the same adapter object, transparently dedupe `adapter.resolve()` to at most one call
per `(adapter, request)` pair via a `WeakMap` keyed on `Request` object identity. This only
works because the framework threads the _same_ `Request` instance unchanged through the whole
`createFetch` composition chain — a caller who reconstructs a new `Request` object partway
through their own middleware stack silently defeats the cache (it just re-resolves), with no
error or signal that the dedup stopped applying.

## Not covered here (left out for lack of direct verification)

A few things the investigation for this doc touched but couldn't confirm confidently enough to
state as fact, flagged here rather than guessed:

- Exactly how `DirectApi`/`TypedClient`/`TreeManifest` behave at runtime if they're handed a
  genuine hybrid node (both `handler` and `children` set) — their type-level shapes treat
  leaf/branch as mutually exclusive, but the runtime discriminator (`isLeaf`, `node.ts:367`)
  is a simple `handler !== undefined` check that doesn't itself special-case the hybrid case
  one way or the other. Not traced through `direct.ts`'s `buildApi` closely enough to state
  what actually happens.
- Whether `apply-validation-build.ts`'s call-site scan rejects (loudly) or silently skips an
  `applyValidation(...)` tree expression whose declaration lives in a different file from the
  call site — only the module doc's framing and the call-site-identification logic were read,
  not the full tracing implementation.
- `otel.ts`'s tree-wrapping mechanism's wrap-order relative to `applyValidation` (does tracing
  wrap validation, or validation wrap tracing, when a tree uses both) — only the header/type
  section of `otel.ts` was read, not the wrapping implementation itself.
- `cli.ts`'s command-dispatch behavior beyond argument parsing, and `auth.ts`'s client-side
  `AuthClientAdapter`/`authExtension` — not read in enough depth to report on.

If any of these matter for the comment-rot pass, they're worth a targeted follow-up read
rather than carrying forward a guess.
