// packages/graphql-api-projector/src/source.ts — @rhi-zone/fractal-graphql-api-projector
//
// `graphql.source(map)` — literal-preserving authoring helper for
// `meta.graphql.sourceMap`, the GraphQL counterpart to `http.source()`
// (http-api-projector/src/verbs.ts). The mapped type and shorthand-expansion
// logic this wraps are shared machinery, not a per-protocol copy — see
// api-tree's input.ts (`SourceMapInput<Store>`/`ResolvedSourceMap<M>`/
// `resolveSourceMap`) for the full rationale. This file only narrows the
// shared generic to GraphQL's own store names and wraps the result under
// `meta.graphql`.

import { resolveSourceMap } from "@rhi-zone/fractal-api-tree";
import type { ResolvedSourceMap, SourceMapInput } from "@rhi-zone/fractal-api-tree";

/**
 * GraphQL's own store names — the stores `graphql.source()`'s map accepts:
 * `argument` (the resolver's flattened `args` bag — the primary store, named
 * `"argument"` by convention to match MCP's tool-argument store name, see
 * project.ts's own doc note on that convention) and `caller` (core's shared
 * per-request store, declared once in api-tree's `CoreStores`).
 *
 * Not a declaration-mergeable registry the way HTTP's `HttpStoreRegistry`
 * is (http-api-projector/src/decode.ts) — GraphQL has no equivalent
 * extension point today, and this design doesn't introduce one.
 */
export type GraphQLStoreName = "argument" | "caller";

/**
 * `graphql.source(map)` — declares which GraphQL store (`argument`,
 * `caller`) each of a leaf's args should be read from, overriding the
 * default argument convention (`assembleGraphQLInput`, resolve.ts) for just
 * the params listed here. Returns a bare `{ graphql: { sourceMap: M } }`
 * contribution — a key-merged map key, composing with other `meta.graphql`
 * contributions the same way `mergeMeta` composes every other sub-bag
 * (last-wins per key). See `http.source()` (http-api-projector/src/verbs.ts)
 * for the full worked rationale this mirrors, including why a helper —
 * rather than a raw object literal typed against
 * `GraphQLLeafMetaProperties["sourceMap"]` — is what keeps `op()`'s static
 * `UncoveredSourceParams` coverage check honest.
 *
 * ```ts
 * op(getBook, graphql.source({ bookId: "argument" }))
 * // → meta.graphql.sourceMap === { bookId: { store: "argument", key: "bookId" } }
 * ```
 */
export function source<const M extends SourceMapInput<GraphQLStoreName>>(
  map: M,
): { readonly graphql: { readonly sourceMap: ResolvedSourceMap<M> } } {
  return { graphql: { sourceMap: resolveSourceMap(map) } };
}

/** `graphql.*` authoring namespace — mirrors `http.*` (http-api-projector/src/verbs.ts). */
export const graphql = { source };
