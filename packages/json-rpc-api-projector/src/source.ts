// packages/json-rpc-api-projector/src/source.ts — @rhi-zone/fractal-json-rpc-api-projector
//
// `jsonrpc.source(map)` — literal-preserving authoring helper for
// `meta.jsonrpc.sourceMap`, the JSON-RPC counterpart to `http.source()`
// (http-api-projector/src/verbs.ts). The mapped type and shorthand-expansion
// logic this wraps are shared machinery, not a per-protocol copy — see
// api-tree's input.ts (`SourceMapInput<Store>`/`ResolvedSourceMap<M>`/
// `resolveSourceMap`) for the full rationale. This file only narrows the
// shared generic to JSON-RPC's own store names and wraps the result under
// `meta.jsonrpc`.

import { resolveSourceMap } from "@rhi-zone/fractal-api-tree"
import type { ResolvedSourceMap, SourceMapInput } from "@rhi-zone/fractal-api-tree"

/**
 * JSON-RPC's own store names — the stores `jsonrpc.source()`'s map accepts:
 * `params` (the request's `params` object/array — the primary store) and
 * `caller` (core's shared per-request store, declared once in api-tree's
 * `CoreStores`).
 *
 * Not a declaration-mergeable registry the way HTTP's `HttpStoreRegistry`
 * is (http-api-projector/src/decode.ts) — JSON-RPC has no equivalent
 * extension point today, and this design doesn't introduce one.
 */
export type JsonRpcStoreName = "params" | "caller"

/**
 * `jsonrpc.source(map)` — declares which JSON-RPC store (`params`,
 * `caller`) each of a leaf's params should be read from, overriding the
 * default `params` convention for just the params listed here. Returns a
 * bare `{ jsonrpc: { sourceMap: M } }` contribution — a key-merged map key,
 * composing with other `meta.jsonrpc` contributions the same way `mergeMeta`
 * composes every other sub-bag (last-wins per key). See `http.source()`
 * (http-api-projector/src/verbs.ts) for the full worked rationale this
 * mirrors, including why a helper — rather than a raw object literal typed
 * against `JsonRpcLeafMetaProperties["sourceMap"]` — is what keeps `op()`'s
 * static `UncoveredSourceParams` coverage check honest.
 *
 * ```ts
 * op(getBook, jsonrpc.source({ bookId: "params" }))
 * // → meta.jsonrpc.sourceMap === { bookId: { store: "params", key: "bookId" } }
 * ```
 */
export function source<const M extends SourceMapInput<JsonRpcStoreName>>(
  map: M,
): { readonly jsonrpc: { readonly sourceMap: ResolvedSourceMap<M> } } {
  return { jsonrpc: { sourceMap: resolveSourceMap(map) } }
}

/** `jsonrpc.*` authoring namespace — mirrors `http.*` (http-api-projector/src/verbs.ts). */
export const jsonrpc = { source }
