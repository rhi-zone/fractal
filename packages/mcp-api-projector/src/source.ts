// `mcp.source(map)` — the authoring helper that says which store each of a
// leaf's parameters is read from, MCP's counterpart to `http.source()`
// (http-api-projector/src/verbs.ts).
//
// The mapped type and shorthand expansion behind it are shared, not copied per
// protocol: api-tree's input.ts owns `SourceMapInput`, `ResolvedSourceMap` and
// `resolveSourceMap`, and explains why. All this file adds is MCP's own store
// names and the `meta.mcp` wrapper around the result.

import { resolveSourceMap } from "@rhi-zone/fractal-api-tree";
import type { ResolvedSourceMap, SourceMapInput } from "@rhi-zone/fractal-api-tree";

/**
 * The stores an `mcp.source()` map may name: `argument`, holding a tool call's
 * or prompt's arguments; `uri-variable`, holding what a resource template's URI
 * captured; and `caller`, the per-request store core declares for every
 * projector.
 *
 * A closed union, unlike HTTP's declaration-mergeable `HttpStoreRegistry`
 * (http-api-projector/src/decode.ts). MCP has no extension point for a
 * deployment to add a store of its own to.
 */
export type McpStoreName = "argument" | "uri-variable" | "caller";

/**
 * Declare where a leaf's parameters come from, for the ones that do not come
 * from where their surface would otherwise look.
 *
 * ```ts
 * op(getBook, mcp.source({ bookId: "uri-variable" }))
 * // → meta.mcp.sourceMap === { bookId: { store: "uri-variable", key: "bookId" } }
 * ```
 *
 * Parameters left out keep the surface's own convention — a tool or prompt
 * reads its arguments, a resource template reads what its URI captured
 * (server.ts's `assembleArgumentInput` and `assembleUriVariableInput`).
 *
 * The returned contribution merges into `meta.mcp` key by key, last one
 * winning, as every other meta contribution does. Going through this helper
 * rather than writing the object literal directly is what preserves the literal
 * types `op()` needs for its static coverage check — `http.source()`
 * (http-api-projector/src/verbs.ts) works that argument through in full.
 */
export function source<const M extends SourceMapInput<McpStoreName>>(
  map: M,
): { readonly mcp: { readonly sourceMap: ResolvedSourceMap<M> } } {
  return { mcp: { sourceMap: resolveSourceMap(map) } };
}

/** The `mcp.*` authoring namespace, as `http.*` is for HTTP (http-api-projector/src/verbs.ts). */
export const mcp = { source };
