// packages/cli-api-projector/src/source.ts — @rhi-zone/fractal-cli-api-projector
//
// `cli.source(map)` — literal-preserving authoring helper for
// `meta.cli.sourceMap`, the CLI counterpart to `http.source()`
// (http-api-projector/src/verbs.ts). The mapped type and shorthand-expansion
// logic this wraps are shared machinery, not a per-protocol copy — see
// api-tree's input.ts (`SourceMapInput<Store>`/`ResolvedSourceMap<M>`/
// `resolveSourceMap`) for the full rationale. This file only narrows the
// shared generic to CLI's own store names and wraps the result under
// `meta.cli`.

import { resolveSourceMap } from "@rhi-zone/fractal-api-tree";
import type { ResolvedSourceMap, SourceMapInput } from "@rhi-zone/fractal-api-tree";

/**
 * CLI's own store names — the stores `cli.source()`'s map accepts. Mirrors
 * `CliStores` (cli.ts: `flag`/`path`/`env`) plus `caller` (core's shared
 * per-request store, declared once in api-tree's `CoreStores`).
 *
 * Not a declaration-mergeable registry the way HTTP's `HttpStoreRegistry`
 * is (http-api-projector/src/decode.ts) — CLI has no equivalent extension
 * point today, and this design doesn't introduce one; a deployment that
 * needs a custom CLI store name would need that extended here first.
 */
export type CliStoreName = "flag" | "path" | "env" | "caller";

/**
 * `cli.source(map)` — declares which CLI store (`flag`, `path`, `env`,
 * `caller`) each of a leaf's params should be read from, overriding the
 * default flag/slug convention (`buildInput`, cli.ts) for just the params
 * listed here. Returns a bare `{ cli: { sourceMap: M } }` contribution — a
 * key-merged map key, composing with other `meta.cli` contributions the same
 * way `mergeMeta` composes every other sub-bag (last-wins per key). See
 * `http.source()` (http-api-projector/src/verbs.ts) for the full worked
 * rationale this mirrors, including why a helper — rather than a raw object
 * literal typed against `CliLeafMetaProperties["sourceMap"]` — is what keeps
 * `op()`'s static `UncoveredSourceParams` coverage check honest.
 *
 * ```ts
 * op(getBook, cli.source({ apiKey: "env" }))
 * // → meta.cli.sourceMap === { apiKey: { store: "env", key: "apiKey" } }
 * ```
 */
export function source<const M extends SourceMapInput<CliStoreName>>(
  map: M,
): { readonly cli: { readonly sourceMap: ResolvedSourceMap<M> } } {
  return { cli: { sourceMap: resolveSourceMap(map) } };
}

/** `cli.*` authoring namespace — mirrors `http.*` (http-api-projector/src/verbs.ts). */
export const cli = { source };
