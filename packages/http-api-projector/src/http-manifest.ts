// packages/http-api-projector/src/http-manifest.ts — @rhi-zone/fractal-http-api-projector
//
// HttpManifest<N> — a protocol-specific counterpart to `TreeManifest<N>`
// (@rhi-zone/fractal-api-tree/tree-manifest): instead of flattening a `Node`
// tree into a dot-path -> {input, output} map, this flattens it into HTTP's
// own two-level shape: `/`-separated PATH -> HTTP METHOD -> {input, output}.
// `tree-manifest.ts`'s own module doc anticipated this and named the
// blocker: a faithful HTTP manifest needs literal, typed directives instead
// of the old `string`-typed `HttpDirective["value"]`/`["path"]` fields — see
// project.ts's `HttpDirective<M, P>` and verbs.ts's `httpVerbBundle`/
// `moveTo`, both landed alongside this file for exactly this purpose.
//
// What this type computes, walking `N` (the pre-projection API `Node` tree,
// the same input `TreeManifest` takes — NOT the post-projection `HttpRoute`):
//
//   - PATH comes from the tree's own shape: each child key becomes a
//     `/`-joined segment (`/books`), each fallback becomes `/:name`
//     (`/books/:bookId`) — mirroring `naiveTransform`'s own placement
//     baseline (route.ts), before any rewriter runs.
//   - METHOD comes from the leaf's own `meta.http.directives` — the FIRST
//     `{ kind: "method" }` directive found (matching `applyMethods`'s own
//     `.find()`, not `getHttpMeta`'s "last wins" parse — see route.ts), or
//     `"POST"` when none is present (`naiveTransform`'s own default for a
//     bare leaf, before `applyMethods` would have renamed it).
//
// What this type does NOT compute: `moveTo`-resolved placement. `applyMoveTo`
// (route.ts) relocates a subtree by parsing a relative-path directive
// (`".."`, `"../rename"`, `"*"`) against the node's OWN tree position, then
// re-inserting the detached subtree elsewhere — a two-phase, whole-tree
// algorithm (collect every move, THEN replay them against the accumulating
// result) with mutation-order dependencies (`mergeRoutes`'s conflict check
// depends on insertion order). Reproducing that as a pure recursive
// conditional type would mean re-deriving the entire tree's final shape from
// a set of relative-path template-literal parses scattered across arbitrarily
// many leaves, INCLUDING noticing when two different leaves converge on the
// same target (the co-located-REST-resource motivating example this
// package's own examples/library-api/src/tree.ts uses: `read`/`replace`/
// `remove`, each with its own `moveTo: ".."`, converging on their parent's
// position). That is not a narrower gap to close — it is a different kind of
// computation (a whole-tree fold with order-dependent conflict detection)
// than a per-leaf recursive walk can express. `HttpManifest<N>` therefore
// reports each leaf's RAW pre-`applyMoveTo` path; a leaf carrying a `moveTo`
// directive appears at its authored tree position, not its runtime-resolved
// one. Where that matters (the REST-resource pattern), the manifest under
// -reports: `read`/`replace`/`remove` show up as three separate paths
// (`/books/:bookId/read` etc.) instead of the one path three methods
// actually share at runtime (`/books/:bookId`). A manifest computed by
// walking the ACTUALLY-PROJECTED `HttpRoute` value at BUILD time (not as a
// pure type, but e.g. a codegen step reading the real route tree after
// `applyMoveTo` has run) would not have this gap — see TODO.md's "Route
// manifest" entry.
//
// See:
//   packages/api-tree/src/tree-manifest.ts        — the protocol-agnostic analogue
//   packages/api-tree/src/node.ts                 — Node, Handler, Meta, op()'s literal-preserving meta
//   packages/http-api-projector/src/project.ts    — HttpDirective<M, P>
//   packages/http-api-projector/src/verbs.ts      — httpVerbBundle, http.*, moveTo
//   packages/http-api-projector/src/route.ts      — naiveTransform, applyMethods, applyMoveTo

import type { Handler, Meta, Node } from "@rhi-zone/fractal-api-tree/node"

/**
 * Union-to-intersection — identical technique to `TreeManifest`'s own helper
 * (tree-manifest.ts): flattens a union of per-child manifest fragments into
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
 * `HttpManifest`'s recursive computation — see this file's module doc for
 * what it does and does not account for (raw tree position, not
 * `moveTo`-resolved). Structurally mirrors `TreeManifestRaw`
 * (tree-manifest.ts): a leaf part (keyed at `Prefix`, now further keyed by
 * its resolved METHOD), a children part (recurse per child, `/`-joined), and
 * a fallback part (recurse into the fallback subtree, keyed by `:name`).
 */
type HttpManifestRaw<N extends Node, Prefix extends string> =
  // Leaf part — this node's own entry, keyed at Prefix -> its own method.
  & (N extends { readonly handler: infer H extends Handler; readonly meta: infer M extends Meta }
      ? H extends (input: infer I) => infer R
        ? {
            readonly [P in Prefix]: {
              readonly [Method in ResolveMethod<M>]: { readonly input: I; readonly output: Awaited<R> }
            }
          }
        : object
      : object)
  // Children part — recurse per child under `${Prefix}/${key}`, then flatten
  // the resulting union so every child's path is a sibling key.
  & (N extends { readonly children: infer C extends Readonly<Record<string, Node>> }
      ? UnionToIntersection<
          { [K in keyof C & string]: HttpManifestRaw<C[K], `${Prefix}/${K}`> }[keyof C & string]
        >
      : object)
  // Fallback part — same recursion, keyed by `:name` (the wildcard-segment
  // convention `naiveTransform`/`applyMoveTo` both use for a fallback slot).
  & (N extends
      { readonly fallback: { readonly name: infer Name extends string; readonly subtree: infer S extends Node } }
      ? HttpManifestRaw<S, `${Prefix}/:${Name}`>
      : object)

/**
 * Public entry point: `HttpManifest<N>` flattens `N` into `/`-path ->
 * HTTP-method -> `{input, output}` — the type-level equivalent of walking
 * `naiveTransform(node)` and reading off each leaf's placement + method,
 * WITHOUT `applyMoveTo`'s runtime relocation (see this file's module doc for
 * why that part is out of scope for a pure type). `Prefix` accumulates the
 * path on the way down; callers instantiate `HttpManifest<typeof tree>`
 * (`Prefix` defaults to `""`) and never supply the second argument
 * themselves.
 */
export type HttpManifest<N extends Node, Prefix extends string = ""> = Simplify<
  HttpManifestRaw<N, Prefix>
>
