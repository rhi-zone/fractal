// packages/mcp-api-projector/src/source.ts — @rhi-zone/fractal-mcp-api-projector
//
// `mcp.source(map)` — literal-preserving authoring helper for
// `meta.mcp.sourceMap`, the MCP counterpart to `http.source()`
// (http-api-projector/src/verbs.ts). The mapped type and shorthand-expansion
// logic this wraps are shared machinery, not a per-protocol copy — see
// api-tree's input.ts (`SourceMapInput<Store>`/`ResolvedSourceMap<M>`/
// `resolveSourceMap`) for the full rationale. This file only narrows the
// shared generic to MCP's own store names and wraps the result under
// `meta.mcp`.

import { resolveSourceMap } from "@rhi-zone/fractal-api-tree";
import type { ResolvedSourceMap, SourceMapInput } from "@rhi-zone/fractal-api-tree";

/**
 * MCP's own store names — the stores `mcp.source()`'s map accepts:
 * `argument` (tool-call arguments / prompt arguments, the primary store for
 * those surfaces), `uri-variable` (resource-template URI variables, the
 * primary store for that surface), and `caller` (core's shared per-request
 * store, declared once in api-tree's `CoreStores`).
 *
 * Not a declaration-mergeable registry the way HTTP's `HttpStoreRegistry`
 * is (http-api-projector/src/decode.ts) — MCP has no equivalent extension
 * point today, and this design doesn't introduce one.
 */
export type McpStoreName = "argument" | "uri-variable" | "caller";

/**
 * `mcp.source(map)` — declares which MCP store (`argument`, `uri-variable`,
 * `caller`) each of a leaf's params should be read from, overriding the
 * surface's default argument/uri-variable convention
 * (`assembleArgumentInput`/`assembleUriVariableInput`, server.ts) for just
 * the params listed here. Returns a bare `{ mcp: { sourceMap: M } }`
 * contribution — a key-merged map key, composing with other `meta.mcp`
 * contributions the same way `mergeMeta` composes every other sub-bag
 * (last-wins per key). See `http.source()` (http-api-projector/src/verbs.ts)
 * for the full worked rationale this mirrors, including why a helper —
 * rather than a raw object literal typed against
 * `McpLeafMetaProperties["sourceMap"]` — is what keeps `op()`'s static
 * `UncoveredSourceParams` coverage check honest.
 *
 * ```ts
 * op(getBook, mcp.source({ bookId: "uri-variable" }))
 * // → meta.mcp.sourceMap === { bookId: { store: "uri-variable", key: "bookId" } }
 * ```
 */
export function source<const M extends SourceMapInput<McpStoreName>>(
  map: M,
): { readonly mcp: { readonly sourceMap: ResolvedSourceMap<M> } } {
  return { mcp: { sourceMap: resolveSourceMap(map) } };
}

/** `mcp.*` authoring namespace — mirrors `http.*` (http-api-projector/src/verbs.ts). */
export const mcp = { source };
