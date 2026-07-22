// packages/api-tree/src/tree-manifest.ts — @rhi-zone/fractal-api-tree
//
// TreeManifest<N> — flattens a Node tree into a map from dot-separated path
// to that leaf's `{ input; output }` contract. Distinct from `TypedClient<N>`
// (typed-client.ts), which preserves the tree's nested shape as a callable
// object; this module discards the shape entirely and keeps only the flat
// path -> contract mapping — the artifact a route table, OpenAPI-style doc
// generator, or CLI help listing wants, where TypedClient's nested proxy
// shape is the wrong fit.
//
// Projector-agnostic: paths here are the tree's own child keys and fallback
// names joined with ".", not any protocol's URL segments or HTTP methods. A
// projector-specific manifest (e.g. HTTP's path/method structure) is a
// SEPARATE artifact this module does not attempt — see
// packages/http-api-projector/src/route.ts's module doc: `applyMoveTo`
// resolves a subtree's target path from a plain runtime string read out of
// the open `meta` bag (`directive.path`), so where a route ends up is
// genuinely unknowable from the `Node` type alone (that file's own
// `ApplyMoveTo`-adjacent doc comments say as much for the same reason
// `applyMethods` widens its method key to `Record<string, ...>` instead of
// tracking it statically). A faithful HTTP manifest type would need typed,
// literal directives instead of today's open string-keyed bag — a separate,
// larger design question, not a narrower fix here. An HTTP-specific manifest
// is therefore not implemented in this codebase yet; `TreeManifest` is the
// projector-agnostic piece a future runtime-derived HTTP manifest (walking
// the actually-projected `HttpRoute`, not the pre-projection `Node` type)
// could still reuse for its value shape.
//
// See:
//   packages/api-tree/src/typed-client.ts — the nested-shape analogue
//   packages/api-tree/src/node.ts         — Node, Handler, fallback, op/api

import type { Handler, Node } from "./node.ts"

/**
 * Join a path prefix and the next segment with ".". No leading dot when
 * `Prefix` is still empty — the root's first segment becomes the whole key,
 * not `.segment`.
 */
type ExtendPath<Prefix extends string, Segment extends string> = Prefix extends ""
  ? Segment
  : `${Prefix}.${Segment}`

/**
 * Union-to-intersection: flattens a union of object types into one object
 * type carrying every member's keys simultaneously. `TreeManifest`'s branch
 * case computes one manifest fragment per child — naturally a union, since
 * TypeScript indexing a mapped type by `keyof C` produces the union of its
 * values — but the whole point of flattening is that every child's disjoint
 * dot-path keys must coexist as sibling keys on ONE result object, not
 * remain a tagged alternative the way `TypedClient`'s per-child map does.
 * This is the standard distributive-conditional trick for that flip: a
 * union `A | B` distributes over `U extends unknown ? (u: U) => void : never`
 * into `(u: A) => void | (u: B) => void`, and inferring a single parameter
 * type from that (contravariant) function-type union forces it back into
 * `A & B`.
 */
type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends
  (u: infer I) => void ? I : never

/**
 * Force eager evaluation of a mapped/intersection type into a single plain
 * object type. Without this, `TreeManifest`'s recursive union-then-intersect
 * construction leaves behind an unresolved intersection of mapped types that
 * is structurally equal to the flat object it represents (any one leaf's
 * property, e.g. `Manifest["books.list"]["input"]`, checks out fine on its
 * own) but that structural-equality checkers comparing the WHOLE object in
 * one shot (`expectTypeOf(...).toEqualTypeOf<...>()`) see as a different
 * shape than a literal object type with the same properties — until it's
 * been run through a key-remapping identity like this one, which forces TS
 * to resolve the intersection down to concrete properties before comparison.
 */
type Simplify<T> = { readonly [K in keyof T]: T[K] } & {}

/**
 * Flattens `N`'s tree into a map from dot-separated path to
 * `{ input; output }` — the handler's input type and its (already-`Awaited`,
 * so a `Promise`-returning handler's `R` collapses to its resolved value,
 * not `Promise<R>`) output type. `Prefix` accumulates the path on the way
 * down; callers instantiate `TreeManifest<N>` (`Prefix` defaults to `""`)
 * and never supply the second argument themselves.
 *
 * - A leaf (carries `handler`) contributes one entry keyed at its own
 *   `Prefix`.
 * - A branch's children each recurse with the child's own key appended to
 *   `Prefix` via `ExtendPath`; the per-child manifest fragments are combined
 *   with `UnionToIntersection` so every descendant path lands as a sibling
 *   key on one object.
 * - A fallback recurses the same way, keyed by `fallback.name` — appearing
 *   by its authored name, same as an ordinary child key (mirrors
 *   `TypedClient`'s fallback handling: the segment name comes from
 *   authoring, not from any synthesized wildcard token).
 * - A node with both `handler` and `children` (the "both" shape `Node`
 *   allows — see node.ts) contributes its own leaf entry AND its children's
 *   entries; the three parts below intersect exactly like `TypedClient`'s
 *   three parts do.
 */
type TreeManifestRaw<N extends Node, Prefix extends string> =
  // Leaf part — this node's own entry, keyed at Prefix
  & (N extends { readonly handler: infer H extends Handler }
      ? H extends (input: infer I) => infer R
        ? { readonly [K in Prefix]: { readonly input: I; readonly output: Awaited<R> } }
        : object
      : object)
  // Children part — recurse per child, then flatten the resulting union
  // into one object so every child's path is a sibling key.
  & (N extends { readonly children: infer C extends Readonly<Record<string, Node>> }
      ? UnionToIntersection<
          { [K in keyof C & string]: TreeManifestRaw<C[K], ExtendPath<Prefix, K>> }[keyof C & string]
        >
      : object)
  // Fallback part — same recursion, keyed by the fallback's authored name.
  & (N extends
      { readonly fallback: { readonly name: infer Name extends string; readonly subtree: infer S extends Node } }
      ? TreeManifestRaw<S, ExtendPath<Prefix, Name>>
      : object)

/**
 * Public entry point: recurses via `TreeManifestRaw`, then runs the result
 * through `Simplify` exactly once at the top. `TreeManifestRaw` recurses
 * into itself directly (not through `Simplify`) — wrapping every recursive
 * step in `Simplify` makes TS report the alias as circularly referencing
 * itself, since `Simplify`'s `keyof T` needs `T` resolved eagerly instead of
 * staying deferred the way a plain conditional-type self-reference does.
 */
export type TreeManifest<N extends Node, Prefix extends string = ""> = Simplify<
  TreeManifestRaw<N, Prefix>
>
