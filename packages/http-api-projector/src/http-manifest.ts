// packages/http-api-projector/src/http-manifest.ts — @rhi-zone/fractal-http-api-projector
//
// HttpManifest<N> — a protocol-specific counterpart to `TreeManifest<N>`
// (@rhi-zone/fractal-api-tree/tree-manifest): instead of flattening a `Node`
// tree into a dot-path -> {input, output} map, this flattens it into HTTP's
// own two-level shape: `/`-separated PATH -> HTTP METHOD -> {input, output}.
//
// What this type computes, walking `N` (the pre-projection API `Node` tree,
// the same input `TreeManifest` takes — NOT the post-projection `HttpRoute`):
//
//   - PATH comes from the tree's own shape: each child key becomes a
//     `/`-joined segment (`/books`), each fallback becomes `/:name`
//     (`/books/:bookId`) — mirroring `naiveTransform`'s own placement
//     baseline (route.ts), before any rewriter runs — THEN, when the leaf
//     carries a `moveTo` directive, resolved against that raw position using
//     the same relative-path algebra `applyMoveTo`'s `resolveMoveTo` (route.ts)
//     applies at runtime: split the directive's `path` on `/`, `..` drops the
//     current position's last segment, `.` is a no-op, any other token is
//     pushed as a new segment.
//   - METHOD comes from the leaf's own `meta.http.directives` — the FIRST
//     `{ kind: "method" }` directive found (matching `applyMethods`'s own
//     `.find()`, not `getHttpMeta`'s "last wins" parse — see route.ts), or
//     `"POST"` when none is present (`naiveTransform`'s own default for a
//     bare leaf, before `applyMethods` would have renamed it).
//
// This type-level resolution only reproduces the PER-LEAF half of
// `applyMoveTo` (route.ts): each leaf's OWN target path, computed from its
// OWN raw position and its OWN `moveTo` directive. What it does not (and, as
// a pure recursive-over-`N` type, cannot) reproduce is `applyMoveTo`'s
// whole-tree bookkeeping: an existing `fallback.name` already sitting at a
// moved-to position wins over the `"param"` default (route.ts's `insertAt`),
// but discovering that requires knowing every OTHER node's tree position too,
// not just the moving leaf's own — a cross-entry, whole-tree fact. This type
// picks the same default `insertAt` picks when the target position has no
// competing pre-existing fallback name to defer to: a `moveTo` token of `"*"`
// resolves to a synthesized `:param` segment. When some other leaf's OWN
// authored `fallback.name` differs from `"param"` at the exact spot a `moveTo`
// converges on, this type's `:param` and that other path's `:realName` are
// two different keys in the output where `applyMoveTo` would have merged them
// under one — a narrower, named gap, not the whole-computation gap this
// module used to report. `applyMoveTo`'s runtime conflict-on-clash behavior
// (two leaves' resolved path+method colliding) is approximated the way
// `TreeManifest`/`HttpManifestRaw` always have: TypeScript's own structural
// intersection of the two entries' `{input, output}` shapes, which resolves
// to `never` when they're incompatible rather than throwing — see `BuildManifest`
// below.
//
// See:
//   packages/api-tree/src/tree-manifest.ts        — the protocol-agnostic analogue
//   packages/api-tree/src/node.ts                 — Node, Handler, Meta, op()'s literal-preserving meta
//   packages/http-api-projector/src/project.ts    — HttpDirective<M, P>
//   packages/http-api-projector/src/verbs.ts      — httpVerbBundle, http.*, moveTo
//   packages/http-api-projector/src/route.ts      — naiveTransform, applyMethods, applyMoveTo, resolveMoveTo

import type { Handler, Meta, Node } from "@rhi-zone/fractal-api-tree/node"

/**
 * Union-to-intersection — identical technique to `TreeManifest`'s own helper
 * (tree-manifest.ts): flattens a union of per-entry manifest fragments into
 * one object carrying every fragment's keys as siblings.
 */
type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends
  (u: infer I) => void ? I : never

/** Force eager evaluation of a mapped/intersection type into a plain object type. */
type Simplify<T> = { readonly [K in keyof T]: T[K] } & {}

/**
 * Scan a directives tuple for the FIRST `{ kind: "method" }` entry's `value`
 * — matching `applyMethods`'s own `.find()` (route.ts), which is what
 * actually determines a leaf's HTTP method at runtime. (`getHttpMeta` in
 * project.ts instead keeps the LAST match when resolving `meta.http` for
 * doc/inspection purposes — a different, already-documented divergence
 * between the two readers; this manifest follows the one that drives
 * dispatch.)
 */
type FindMethodDirective<D extends readonly unknown[]> = D extends
  readonly [infer First, ...infer Rest extends readonly unknown[]]
  ? First extends { readonly kind: "method"; readonly value: infer V extends string }
    ? V
    : FindMethodDirective<Rest>
  : never

/**
 * Resolve a leaf's HTTP method from its own `meta` — `M["http"]["directives"]`
 * when present and literal (see verbs.ts's `httpVerbBundle`/`http.*` and
 * node.ts's `op()`, which together are what makes a directive's `value`
 * survive as a literal instead of widening to `string`); `"POST"` otherwise,
 * matching `naiveTransform`'s own baseline for a bare leaf with no method
 * directive.
 */
type ResolveMethod<M> = M extends { readonly http?: { readonly directives?: infer D } }
  ? D extends readonly unknown[]
    ? [FindMethodDirective<D>] extends [never] ? "POST" : FindMethodDirective<D>
    : "POST"
  : "POST"

/**
 * Scan a directives tuple for the FIRST `{ kind: "moveTo" }` entry's `path` —
 * matching `applyMoveTo`'s own `detach()` (route.ts), which reads
 * `directivesOf(meta).find(isMoveToDirective)` — first match, same tuple
 * order as `FindMethodDirective` above. `never` (no match) is distinguished
 * from an ABSENT directives array by the same `[X] extends [never]` idiom
 * `ResolveMethod` uses, since a bare `never` union member disappears silently
 * in an ordinary conditional check.
 *
 * The `string extends P ? ... : P` guard below is load-bearing, NOT
 * defensive-programming excess: `VerbBundle<V>` (verbs.ts) types BOTH of its
 * tuple slots as the bare `HttpDirective<V>` — the entire 7-variant union,
 * not the specific variant actually stored at runtime — because nothing
 * narrows a tuple SLOT to a single variant positionally. `First extends
 * {kind:"moveTo"; path: infer P}` is therefore a conditional over a naked
 * (unioned) type parameter, which DISTRIBUTES: for a slot that is really a
 * `{kind:"verb"}` or `{kind:"method"}` value at runtime, the check still
 * spuriously matches that same slot's UNUSED `moveTo`-shaped union member,
 * inferring `P` as `HttpDirective`'s default `path: string` — a real but
 * WRONG match, present only because the static type admits a possibility the
 * runtime value doesn't carry. A genuine `http.moveTo(path)` directive
 * (verbs.ts's `moveTo()`) is instead ALREADY narrowed via `Extract<..., {kind
 * :"moveTo"}>` to exactly one variant with `path` bound to a literal — so
 * `string extends P` is true only for the spurious, unnarrowed match (reject,
 * keep scanning) and false for a genuine literal `path` (accept).
 */
type FindMoveToDirective<D extends readonly unknown[]> = D extends
  readonly [infer First, ...infer Rest extends readonly unknown[]]
  ? First extends { readonly kind: "moveTo"; readonly path: infer P extends string }
    ? string extends P ? FindMoveToDirective<Rest> : P
    : FindMoveToDirective<Rest>
  : never

/**
 * Resolve a leaf's `moveTo` directive path (as a literal, when present —
 * see verbs.ts's `moveTo()` and node.ts's `op()`), or `undefined` when the
 * leaf carries none.
 */
type ResolveMoveTo<M> = M extends { readonly http?: { readonly directives?: infer D } }
  ? D extends readonly unknown[]
    ? [FindMoveToDirective<D>] extends [never] ? undefined : FindMoveToDirective<D>
    : undefined
  : undefined

// ============================================================================
// Path-string algebra — template-literal counterpart to route.ts's
// `resolveMoveTo(itemPath: readonly string[], path: string): string[]`.
// `Prefix` (the leaf's raw, pre-moveTo tree position, e.g.
// "/books/:bookId/read") plays the role of `itemPath` there — it already IS
// the node's own full authored path, exactly what `resolveMoveTo` resolves
// a `moveTo` directive relative to.
// ============================================================================

/**
 * Split a `/`-joined path string into its non-empty segments — the
 * type-level equivalent of `path.split("/").filter(t => t.length > 0)`
 * (used both by `route.ts`'s `splitPath` for a request URL and by
 * `resolveMoveTo` for a directive's `path`). A leading `/` (every `Prefix`
 * this module builds has one, e.g. `/books/list`) produces an empty `Head` on
 * the first split, which is skipped rather than kept as a `""` segment.
 */
type SplitSegments<S extends string> = S extends `${infer Head}/${infer Rest}`
  ? Head extends "" ? SplitSegments<Rest> : [Head, ...SplitSegments<Rest>]
  : S extends "" ? [] : [S]

/** Drop the last element of a tuple — the type-level `Array.prototype.pop`. */
type PopLast<Segs extends readonly string[]> =
  Segs extends readonly [...infer Init extends readonly string[], string] ? Init : []

/**
 * Apply `moveTo`'s relative-path tokens to a segment tuple, one token at a
 * time — mirrors `resolveMoveTo`'s `for (const tok of path.split("/")...)`
 * loop exactly: `.` is a no-op, `..` pops the last segment, any other token
 * is pushed as a new segment.
 *
 * `"*"` is special-cased to push a synthesized `:param` segment — matching
 * `insertAt`'s (route.ts) own default fallback-parameter name when no
 * existing `fallback` already occupies the target position. See this file's
 * module doc for the one case this default can diverge from `applyMoveTo`'s
 * actual runtime result: when some OTHER leaf's own authored `fallback.name`
 * at that exact position isn't `"param"`, a fact this per-leaf type has no
 * way to see.
 */
type ApplyTokens<Segs extends readonly string[], Tokens extends readonly string[]> =
  Tokens extends readonly [infer Head extends string, ...infer Rest extends readonly string[]]
    ? Head extends "."
      ? ApplyTokens<Segs, Rest>
      : Head extends ".."
        ? ApplyTokens<PopLast<Segs>, Rest>
        : Head extends "*"
          ? ApplyTokens<[...Segs, ":param"], Rest>
          : ApplyTokens<[...Segs, Head], Rest>
    : Segs

/** Join segments back into `route.ts`'s own path-string convention: `""` for zero segments, `/a/b` otherwise. */
type JoinSegments<Segs extends readonly string[]> =
  Segs extends readonly [infer Head extends string, ...infer Rest extends readonly string[]]
    ? Rest extends readonly [] ? Head : `${Head}/${JoinSegments<Rest>}`
    : ""

type JoinPath<Segs extends readonly string[]> = Segs extends readonly [] ? "" : `/${JoinSegments<Segs>}`

/**
 * Resolve a leaf's final path: unchanged when it carries no `moveTo`
 * directive, otherwise `Prefix`'s own segments with `MoveToPath`'s tokens
 * applied — the type-level `resolveMoveTo(itemPath, path)`.
 */
type ResolvedPath<Prefix extends string, MoveToPath extends string | undefined> =
  MoveToPath extends string
    ? JoinPath<ApplyTokens<SplitSegments<Prefix>, SplitSegments<MoveToPath>>>
    : Prefix

// ============================================================================
// Collect phase — walk `N`, producing a UNION of per-leaf manifest entries
// (path, method, input, output), each already `moveTo`-resolved. A union
// (not `HttpManifestRaw`'s per-branch intersection) because the whole point
// of this phase is to gather every leaf's entry into one flat bag that the
// build phase can re-key by RESOLVED path — a leaf's resolved path may not
// have anything to do with its position in this recursive walk anymore.
// ============================================================================

type ManifestEntry = {
  readonly path: string
  readonly method: string
  readonly input: unknown
  readonly output: unknown
}

type CollectEntries<N extends Node, Prefix extends string> =
  // Leaf part — this node's own entry, at its moveTo-resolved path.
  | (N extends { readonly handler: infer H extends Handler; readonly meta: infer M extends Meta }
      ? H extends (input: infer I) => infer R
        ? {
            readonly path: ResolvedPath<Prefix, ResolveMoveTo<M>>
            readonly method: ResolveMethod<M>
            readonly input: I
            readonly output: Awaited<R>
          }
        : never
      : never)
  // Children part — recurse per child under `${Prefix}/${key}`, union of entries.
  | (N extends { readonly children: infer C extends Readonly<Record<string, Node>> }
      ? { [K in keyof C & string]: CollectEntries<C[K], `${Prefix}/${K}`> }[keyof C & string]
      : never)
  // Fallback part — same recursion, keyed by `:name`, matching the
  // wildcard-segment convention `naiveTransform`/`applyMoveTo` both use.
  | (N extends
      { readonly fallback: { readonly name: infer Name extends string; readonly subtree: infer S extends Node } }
      ? CollectEntries<S, `${Prefix}/:${Name}`>
      : never)

// ============================================================================
// Build phase — fold the entries union into `{ [path]: { [method]: {input,
// output} } }`. Two entries converging on the same path (whether via
// `moveTo` or simply authored there) become sibling `method` keys on the same
// path object, via the same distribute-then-intersect technique
// `HttpManifestRaw`'s own children part already uses; two entries converging
// on the same path AND method intersect their `{input, output}` shapes
// instead — `never` for an incompatible pair, a structural (not thrown)
// conflict signal.
// ============================================================================

/**
 * The methods map for one already-grouped `path` — `Extract<E, {path: P}>`
 * narrows the entries union down to just the ones resolving to `P` first, so
 * the distribute-then-`UnionToIntersection` step below only ever combines
 * SIBLING methods at that one path (never a stray method from an unrelated
 * path). `Simplify`d here, not just once at the very top — leaving a
 * multi-method path as the raw `{GET:...} & {DELETE:...}` intersection
 * `UnionToIntersection` produces is structurally equivalent to the flattened
 * object but not IDENTICAL to it as a type value, the same gap `Simplify`
 * itself exists to close (see its own doc comment); a whole-manifest
 * `Simplify` only forces evaluation one level deep; a converged (>1 method)
 * path needs its own.
 */
type MethodsForPath<E extends ManifestEntry, P extends string> = Simplify<
  UnionToIntersection<
    Extract<E, { readonly path: P }> extends infer Entry extends ManifestEntry
      ? Entry extends unknown
        ? {
            readonly [M in Entry["method"]]: { readonly input: Entry["input"]; readonly output: Entry["output"] }
          }
        : never
      : never
  >
>

type BuildManifest<E extends ManifestEntry> = Simplify<
  { readonly [P in E["path"]]: MethodsForPath<E, P> }
>

/**
 * Public entry point: `HttpManifest<N>` flattens `N` into `/`-path ->
 * HTTP-method -> `{input, output}`, `moveTo`-resolved — the type-level
 * equivalent of walking `applyMoveTo(naiveTransform(node))` and reading off
 * each leaf's final placement + method. `Prefix` accumulates the raw
 * (pre-`moveTo`) path on the way down; callers instantiate
 * `HttpManifest<typeof tree>` (`Prefix` defaults to `""`) and never supply
 * the second argument themselves. See this file's module doc for the one
 * named gap in `moveTo` resolution (a `"*"` token's synthesized `:param`
 * name can diverge from another leaf's own authored `fallback.name` at the
 * same converged-on position).
 */
export type HttpManifest<N extends Node, Prefix extends string = ""> = BuildManifest<
  CollectEntries<N, Prefix>
>
