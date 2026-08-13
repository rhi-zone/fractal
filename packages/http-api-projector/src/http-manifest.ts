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
//     carries a `meta.http.moveTo` value, resolved against that raw position
//     using the same relative-path algebra `applyMoveTo`'s `resolveMoveTo`
//     (route.ts) applies at runtime: split `moveTo` on `/`, `..` drops the
//     current position's last segment, `.` is a no-op, any other token is
//     pushed as a new segment.
//   - METHOD comes from the leaf's own flat `meta.http.method` scalar key —
//     already the single, fully-resolved value `op()`'s own `mergeMeta` fold
//     produces (last-wins; see node.ts's `MergeMetaValue`) — or `"POST"` when
//     absent (`naiveTransform`'s own default for a bare leaf, before
//     `applyMethods` would have renamed it). Before the http-directive-
//     dissolution migration (docs/design/wire-profiles-and-staged-
//     validation.md's "Prerequisite: meta unification" section), this walked
//     a `meta.http.directives` TUPLE for the FIRST `{ kind: "method" }` entry
//     (matching `applyMethods`'s own `.find()`, deliberately NOT
//     `getHttpMeta`'s "last wins" parse, since no fold had happened yet at
//     the type level) — the flat design needs no such tuple walk: the fold
//     already happened, by construction, the moment `op()`'s contributions
//     composed.
//
// This type-level resolution only reproduces the PER-LEAF half of
// `applyMoveTo` (route.ts): each leaf's OWN target path, computed from its
// OWN raw position and its OWN `moveTo` directive. `applyMoveTo`'s whole-tree
// bookkeeping — an existing `fallback.name` already sitting at a moved-to
// position wins over the `"param"` default (route.ts's `insertAt`) — needs
// knowing every OTHER node's tree position too, not just the moving leaf's
// own; this module resolves that by re-walking the FULL root tree (threaded
// through `CollectEntries` as `Root`, see `ResolveWildcardSegments` below)
// once a leaf's moveTo path has been applied, substituting any synthesized
// `:param` segment for whatever `fallback.name` is ACTUALLY authored at that
// position in `Root`, when one exists — the same preference `insertAt` gives
// a pre-existing fallback over the `"param"` default. This covers the
// documented common case: a `moveTo` target that lands on a position `Root`
// already has a real `children`/`fallback` chain for. It does NOT reproduce
// `insertAt`'s full runtime picture, which walks the PROGRESSIVELY-mutated
// tree across a whole `moves` sequence (so two `moveTo`s can converge with
// each other, not just with an already-authored fallback) — that ordering
// fact is inherently outside a per-leaf, non-sequential type computation.
// `applyMoveTo`'s runtime conflict-on-clash behavior (two leaves' resolved
// path+method colliding) is approximated the way `TreeManifest`/
// `HttpManifestRaw` always have: TypeScript's own structural intersection of
// the two entries' `{input, output}` shapes, which resolves to `never` when
// they're incompatible rather than throwing — see `BuildManifest` below.
//
// See:
//   packages/api-tree/src/tree-manifest.ts        — the protocol-agnostic analogue
//   packages/api-tree/src/node.ts                 — Node, Handler, SharedMeta, op()'s literal-preserving meta
//   packages/http-api-projector/src/project.ts    — HttpLeafMetaProperties
//   packages/http-api-projector/src/verbs.ts      — httpVerbBundle, http.*, moveTo
//   packages/http-api-projector/src/route.ts      — naiveTransform, applyMethods, applyMoveTo, resolveMoveTo

import type { Handler, Node } from "@rhi-zone/fractal-api-tree/node";

/**
 * Union-to-intersection — identical technique to `TreeManifest`'s own helper
 * (tree-manifest.ts): flattens a union of per-entry manifest fragments into
 * one object carrying every fragment's keys as siblings.
 */
type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (
  u: infer I,
) => void
  ? I
  : never;

/** Force eager evaluation of a mapped/intersection type into a plain object type. */
type Simplify<T> = { readonly [K in keyof T]: T[K] } & {};

/**
 * Resolve a leaf's HTTP method from its own `meta` — `M["http"]["method"]`
 * when present and literal (see verbs.ts's `httpVerbBundle`/`http.*` and
 * node.ts's `op()`, which together are what makes it survive as a literal
 * instead of widening to `string`); `"POST"` otherwise, matching
 * `naiveTransform`'s own baseline for a bare leaf with no method set.
 *
 * No tuple walk needed (unlike the pre-http-directive-dissolution version
 * this replaces, docs/design/wire-profiles-and-staged-validation.md's
 * "Prerequisite: meta unification" section): `meta.http.method` is already
 * the single, fully-resolved last-wins value the moment `op()`'s own
 * `mergeMeta` fold (node.ts) composes a leaf's contributions — there is
 * nothing left for this type to scan or fold itself.
 */
type ResolveMethod<M> = M extends { readonly http: infer H }
  ? H extends { readonly method: infer V extends string }
    ? V
    : "POST"
  : "POST";

/**
 * Resolve a leaf's `meta.http.moveTo` (as a literal, when present — see
 * verbs.ts's `moveTo()` and node.ts's `op()`), or `undefined` when the leaf
 * carries none. Same "no tuple walk needed" simplification as `ResolveMethod`
 * above applies here too — `meta.http.moveTo` is already the resolved,
 * last-wins value.
 *
 * Two-step (`M`'s own `http` key, THEN that value's `moveTo` key), both
 * written as REQUIRED-key patterns (no `?`, even though
 * `HttpLeafMetaProperties` declares both `http` and `moveTo` optional) —
 * deliberately: a structural conditional match against a REQUIRED-key
 * pattern only succeeds when the key is actually PRESENT in the checked
 * type, which is exactly the "does this leaf carry an `http` bag / a
 * `moveTo` within it at all" distinction needed. An OPTIONAL-key pattern
 * (`http?: {...}` or `moveTo?: infer P`) matches trivially against ANY
 * object type (an optional key is never required to be present) — verified
 * empirically (scratch `tsc`) to make the whole conditional vacuously true
 * and infer the constraint itself (`string`) rather than falling through to
 * this type's own fallback branch, which is why `ResolveMethod` above uses
 * the identical two-step required-key shape rather than a single optional
 * chain.
 */
type ResolveMoveTo<M> = M extends { readonly http: infer H }
  ? H extends { readonly moveTo: infer P extends string }
    ? P
    : undefined
  : undefined;

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
  ? Head extends ""
    ? SplitSegments<Rest>
    : [Head, ...SplitSegments<Rest>]
  : S extends ""
    ? []
    : [S];

/** Drop the last element of a tuple — the type-level `Array.prototype.pop`. */
type PopLast<Segs extends readonly string[]> = Segs extends readonly [
  ...infer Init extends readonly string[],
  string,
]
  ? Init
  : [];

/**
 * Apply `moveTo`'s relative-path tokens to a segment tuple, one token at a
 * time — mirrors `resolveMoveTo`'s `for (const tok of path.split("/")...)`
 * loop exactly: `.` is a no-op, `..` pops the last segment, any other token
 * is pushed as a new segment.
 *
 * `"*"` is special-cased to push a synthesized `:param` segment — the same
 * default `insertAt` (route.ts) falls back to when no existing `fallback`
 * already occupies the target position. `:param` here is provisional: since
 * `ApplyTokens` only ever sees ONE leaf's own path in isolation, it cannot
 * know whether some OTHER leaf's authored `fallback.name` already sits at
 * this exact converged-on position. `ResolveWildcardSegments` (below)
 * reconciles that afterward, walking the FULL tree to substitute the real
 * name when one exists — see this file's module doc.
 */
type ApplyTokens<
  Segs extends readonly string[],
  Tokens extends readonly string[],
> = Tokens extends readonly [infer Head extends string, ...infer Rest extends readonly string[]]
  ? Head extends "."
    ? ApplyTokens<Segs, Rest>
    : Head extends ".."
      ? ApplyTokens<PopLast<Segs>, Rest>
      : Head extends "*"
        ? ApplyTokens<[...Segs, ":param"], Rest>
        : ApplyTokens<[...Segs, Head], Rest>
  : Segs;

/**
 * Re-walk a `moveTo`-resolved segment tuple against the FULL, original
 * `Root` tree, substituting each synthesized `:param` marker (the literal
 * `ApplyTokens` always emits for a `"*"` token — `CollectEntries`'s own
 * fallback branch never independently produces that literal name unless a
 * fallback is genuinely authored as `"param"`, in which case substituting it
 * for itself is a no-op) with whatever `fallback.name` is ACTUALLY authored
 * at that position in `Root`, mirroring `insertAt`'s (route.ts)
 * `root.fallback?.name ?? "param"` preference for a pre-existing fallback
 * name over the synthesized default.
 *
 * Segments are matched structurally against `Root`'s own `children`/
 * `fallback` shape, descending one level per segment. Once a segment has no
 * matching branch in `Root` (a `moveTo` target that doesn't correspond to
 * any REAL tree position — e.g. `moveTo: "brand/new/path/*"`), the rest of
 * the tuple is returned untouched: with no known position left to check,
 * any later `:param` marker keeps `insertAt`'s own synthesized default.
 */
type ResolveWildcardSegments<
  Root extends Node,
  Segs extends readonly string[],
> = Segs extends readonly [infer Head extends string, ...infer Rest extends readonly string[]]
  ? Head extends `:${string}`
    ? Root extends {
        readonly fallback: {
          readonly name: infer Name extends string;
          readonly subtree: infer S extends Node;
        };
      }
      ? Head extends ":param"
        ? [`:${Name}`, ...ResolveWildcardSegments<S, Rest>]
        : [Head, ...ResolveWildcardSegments<S, Rest>]
      : [Head, ...Rest]
    : Root extends { readonly children: infer C extends Readonly<Record<string, Node>> }
      ? Head extends keyof C
        ? [Head, ...ResolveWildcardSegments<C[Head], Rest>]
        : [Head, ...Rest]
      : [Head, ...Rest]
  : [];

/** Join segments back into `route.ts`'s own path-string convention: `""` for zero segments, `/a/b` otherwise. */
type JoinSegments<Segs extends readonly string[]> = Segs extends readonly [
  infer Head extends string,
  ...infer Rest extends readonly string[],
]
  ? Rest extends readonly []
    ? Head
    : `${Head}/${JoinSegments<Rest>}`
  : "";

type JoinPath<Segs extends readonly string[]> = Segs extends readonly []
  ? ""
  : `/${JoinSegments<Segs>}`;

/**
 * Resolve a leaf's final path: unchanged when it carries no `moveTo`
 * directive, otherwise `Prefix`'s own segments with `MoveToPath`'s tokens
 * applied — the type-level `resolveMoveTo(itemPath, path)` — and any
 * synthesized `:param` wildcard reconciled against `Root`'s own tree via
 * `ResolveWildcardSegments`.
 */
type ResolvedPath<
  Prefix extends string,
  MoveToPath extends string | undefined,
  Root extends Node,
> = MoveToPath extends string
  ? JoinPath<
      ResolveWildcardSegments<Root, ApplyTokens<SplitSegments<Prefix>, SplitSegments<MoveToPath>>>
    >
  : Prefix;

// ============================================================================
// Collect phase — walk `N`, producing a UNION of per-leaf manifest entries
// (path, method, input, output), each already `moveTo`-resolved. A union
// (not `HttpManifestRaw`'s per-branch intersection) because the whole point
// of this phase is to gather every leaf's entry into one flat bag that the
// build phase can re-key by RESOLVED path — a leaf's resolved path may not
// have anything to do with its position in this recursive walk anymore.
// ============================================================================

type ManifestEntry = {
  readonly path: string;
  readonly method: string;
  readonly input: unknown;
  readonly output: unknown;
};

type CollectEntries<N extends Node, Prefix extends string, Root extends Node> =
  // Leaf part — this node's own entry, at its moveTo-resolved path.
  //
  // `infer M` is deliberately UNCONSTRAINED here (no `extends SharedMeta`) —
  // constraining it broke every leaf carrying a real meta contribution
  // (e.g. `op(fn, http.get)`, whose actual `meta` type is `Widen<...>` —
  // node.ts's `Widen`, `{...} & { readonly [key: string]: unknown }`)
  // silently to `never`: TypeScript's "weak type" inference check applies
  // to a CONSTRAINED `infer X extends Y` the same way it applies to a
  // function-argument assignability check (verified empirically, scratch
  // `tsc`) — `SharedMeta` has only one optional member (`description`), a
  // real leaf's folded meta (`{http:{...}, tags:{...}}`) shares NOT ONE
  // property name with it, and `Widen`'s own index signature on the SOURCE
  // does not exempt it (confirmed: an indexed source does not bypass this
  // check, only an indexed TARGET does — see node.ts's `Widen` doc for that
  // other direction). The whole `N extends {handler...; meta...}` check
  // then fails outright (not just the `M` binding), so the entire leaf
  // silently drops out of `CollectEntries`'s union — `E` collapses to
  // `never`, and `BuildManifest<never>` is the empty object `{}`, not an
  // error. `M`'s own uses below (`ResolveMethod`/`ResolveMoveTo`) already
  // defensively check `M extends {http?: {...}}` themselves, so no
  // constraint is needed here for them to work correctly.
  | (N extends { readonly handler: infer H extends Handler; readonly meta: infer M }
      ? H extends (input: infer I) => infer R
        ? {
            readonly path: ResolvedPath<Prefix, ResolveMoveTo<M>, Root>;
            readonly method: ResolveMethod<M>;
            readonly input: I;
            readonly output: Awaited<R>;
          }
        : never
      : never)
  // Children part — recurse per child under `${Prefix}/${key}`, union of entries.
  // `Root` is threaded through unchanged (always the whole-tree top, not the
  // recursed-into `N`) so `ResolveWildcardSegments` can look up ANY leaf's
  // authored fallback name, not just ones under the current subtree.
  | (N extends { readonly children: infer C extends Readonly<Record<string, Node>> }
      ? { [K in keyof C & string]: CollectEntries<C[K], `${Prefix}/${K}`, Root> }[keyof C & string]
      : never)
  // Fallback part — same recursion, keyed by `:name`, matching the
  // wildcard-segment convention `naiveTransform`/`applyMoveTo` both use.
  | (N extends {
      readonly fallback: {
        readonly name: infer Name extends string;
        readonly subtree: infer S extends Node;
      };
    }
      ? CollectEntries<S, `${Prefix}/:${Name}`, Root>
      : never);

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
            readonly [M in Entry["method"]]: {
              readonly input: Entry["input"];
              readonly output: Entry["output"];
            };
          }
        : never
      : never
  >
>;

type BuildManifest<E extends ManifestEntry> = Simplify<{
  readonly [P in E["path"]]: MethodsForPath<E, P>;
}>;

/**
 * Public entry point: `HttpManifest<N>` flattens `N` into `/`-path ->
 * HTTP-method -> `{input, output}`, `moveTo`-resolved — the type-level
 * equivalent of walking `applyMoveTo(naiveTransform(node))` and reading off
 * each leaf's final placement + method. `Prefix` accumulates the raw
 * (pre-`moveTo`) path on the way down; callers instantiate
 * `HttpManifest<typeof tree>` (`Prefix` defaults to `""`) and never supply
 * the second argument themselves. `N` doubles as `CollectEntries`'s `Root` —
 * the whole, un-recursed-into tree that `ResolveWildcardSegments` walks to
 * reconcile a `"*"` token's synthesized `:param` name against any other
 * leaf's own authored `fallback.name` at the same converged-on position (see
 * this file's module doc).
 */
export type HttpManifest<N extends Node, Prefix extends string = ""> = BuildManifest<
  CollectEntries<N, Prefix, N>
>;
