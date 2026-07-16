// packages/http/src/verbs.ts — @rhi-zone/fractal-http
//
// Verb-helper bundles: `http.get`, `http.post`, `http.put`, `http.patch`,
// `http.delete`, `http.head`, `http.options`.
//
// Each helper is a METADATA VALUE (a Meta object), NOT a function. It bundles:
//   - the verb pin (a `{kind:"verb",value}` directive in `meta.http.directives`)
//     — wins over tag-derived verb in verbFromTags
//   - the behavioral tags that verb implies (`meta.tags`)
//
// Usage:
//   op(fn, http.put)                    — verb PUT + idempotent tag
//   op(fn, http.put, { tags: { ... } }) — merges via mergeMeta, later-wins
//
// The bundled tags are what light up other projections for free:
//   http.get  → readOnly:true  → MCP readOnlyHint, CLI no-confirm
//   http.put  → idempotent:true → MCP idempotentHint
//   http.delete → destructive:true + idempotent:true → MCP destructiveHint + idempotentHint
//
// See docs/design/router-model.md §"Verb helpers are verb+implied-tags BUNDLES"

import type { Meta } from "@rhi-zone/fractal-core/node"
import type { HttpDirective } from "./project.ts"

// ============================================================================
// HttpMethods — extensible method union
// ============================================================================

/**
 * The known HTTP methods, as an interface so users can extend it via
 * declaration merging (e.g. WebDAV's PROPFIND/MKCOL) without forking this
 * package:
 *
 * ```ts
 * declare module "@rhi-zone/fractal-http/verbs" {
 *   interface HttpMethods { PROPFIND: "PROPFIND"; MKCOL: "MKCOL" }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface HttpMethods {
  GET: "GET"
  POST: "POST"
  PUT: "PUT"
  PATCH: "PATCH"
  DELETE: "DELETE"
  HEAD: "HEAD"
  OPTIONS: "OPTIONS"
}

/** A known HTTP method name — the key set of `HttpMethods`, open via merging. */
export type Method = keyof HttpMethods

// ============================================================================
// Verb-helper bundle type
// ============================================================================

/**
 * A verb-helper bundle: a Meta value carrying both a verb directive and
 * implied tags. Attach to a handler via `op(fn, http.put)` or compose with
 * extra contributions via `op(fn, http.put, { tags: { openWorld: true } })`.
 */
export type VerbBundle = Meta & {
  readonly http: { readonly directives: readonly HttpDirective[] }
  readonly tags: Record<string, boolean | undefined>
}

const verbBundle = (verb: string, tags: Record<string, boolean | undefined>): VerbBundle => ({
  // Carries BOTH the `kind: "verb"` directive (read by `verbFromTags` in
  // tags.ts — also used by openapi/client's own self-contained tree walks)
  // and the `kind: "method"` directive (read by `applyMethods`, the
  // HttpRoute rewriter in route.ts). Both directives describe the same
  // fact; two projectors read two shapes.
  http: { directives: [{ kind: "verb", value: verb }, { kind: "method", value: verb }] },
  tags,
})

// ============================================================================
// Verb-helper bundles
// ============================================================================

/**
 * `http.get` — verb GET + readOnly tag.
 * readOnly ⇒ idempotent (via lattice in resolveTags).
 * Lights up: MCP readOnlyHint, CLI no-confirm, HTTP GET.
 */
const get: VerbBundle = verbBundle("GET", { readOnly: true })

/**
 * `http.post` — verb POST, no implied tags (plain mutation).
 * Conservative: unknown idempotency, unknown destructiveness.
 */
const post: VerbBundle = verbBundle("POST", {})

/**
 * `http.put` — verb PUT + idempotent tag.
 * Lights up: MCP idempotentHint, gRPC idempotency, HTTP PUT.
 */
const put: VerbBundle = verbBundle("PUT", { idempotent: true })

/**
 * `http.patch` — verb PATCH, no implied tags (plain mutation).
 * Conservative: unknown idempotency.
 */
const patch: VerbBundle = verbBundle("PATCH", {})

/**
 * `http.delete` — verb DELETE + destructive and idempotent tags.
 * Lights up: MCP destructiveHint + idempotentHint, CLI confirm, HTTP DELETE.
 */
const _delete: VerbBundle = verbBundle("DELETE", { destructive: true, idempotent: true })

/**
 * `http.head` — verb HEAD + readOnly tag (semantically identical to GET).
 * Rarely needed directly — autoMethodLayer derives HEAD from GET automatically.
 */
const head: VerbBundle = verbBundle("HEAD", { readOnly: true })

/**
 * `http.options` — verb OPTIONS + readOnly tag.
 * Rarely needed directly — autoMethodLayer handles OPTIONS automatically.
 */
const options: VerbBundle = verbBundle("OPTIONS", { readOnly: true })

// ============================================================================
// Exported namespace
// ============================================================================

/**
 * HTTP verb-helper bundles.
 *
 * Each is a metadata VALUE (not a wrapper fn) bundling a verb directive and
 * the behavioral tags that verb implies. Attach to a leaf node via `op`:
 *
 * ```ts
 * op(getBook,    http.get)
 * op(createBook, http.post)
 * op(replaceBook, http.put)
 * op(patchBook,  http.patch)
 * op(deleteBook, http.delete)
 * ```
 *
 * Compose with additional meta contributions (deep-merged, later-wins):
 * ```ts
 * op(fn, http.put, { tags: { openWorld: true } })
 * // → verb PUT, idempotent:true (from bundle), openWorld:true (from extra)
 * ```
 */
export const http = {
  get,
  post,
  put,
  patch,
  delete: _delete,
  head,
  options,
} as const satisfies Record<string, VerbBundle>
