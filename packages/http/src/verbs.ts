// packages/http/src/verbs.ts — @rhi-zone/fractal-http
//
// Verb-helper bundles: `http.get`, `http.post`, `http.put`, `http.patch`,
// `http.delete`, `http.head`, `http.options`.
//
// Each helper is a METADATA VALUE (a Meta object), NOT a function. It bundles:
//   - the verb pin (`meta.http.verb`) — wins over tag-derived verb in verbFromTags
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

// ============================================================================
// Verb-helper bundle type
// ============================================================================

/**
 * A verb-helper bundle: a Meta value carrying both a verb pin and implied tags.
 * Attach to a handler via `op(fn, http.put)` or compose with extra contributions
 * via `op(fn, http.put, { tags: { openWorld: true } })`.
 */
export type VerbBundle = Meta & {
  readonly http: { readonly verb: string }
  readonly tags: Record<string, boolean | undefined>
}

// ============================================================================
// Verb-helper bundles
// ============================================================================

/**
 * `http.get` — verb GET + readOnly tag.
 * readOnly ⇒ idempotent (via lattice in resolveTags).
 * Lights up: MCP readOnlyHint, CLI no-confirm, HTTP GET.
 */
const get: VerbBundle = {
  http: { verb: "GET" },
  tags: { readOnly: true },
}

/**
 * `http.post` — verb POST, no implied tags (plain mutation).
 * Conservative: unknown idempotency, unknown destructiveness.
 */
const post: VerbBundle = {
  http: { verb: "POST" },
  tags: {},
}

/**
 * `http.put` — verb PUT + idempotent tag.
 * Lights up: MCP idempotentHint, gRPC idempotency, HTTP PUT.
 */
const put: VerbBundle = {
  http: { verb: "PUT" },
  tags: { idempotent: true },
}

/**
 * `http.patch` — verb PATCH, no implied tags (plain mutation).
 * Conservative: unknown idempotency.
 */
const patch: VerbBundle = {
  http: { verb: "PATCH" },
  tags: {},
}

/**
 * `http.delete` — verb DELETE + destructive and idempotent tags.
 * Lights up: MCP destructiveHint + idempotentHint, CLI confirm, HTTP DELETE.
 */
const _delete: VerbBundle = {
  http: { verb: "DELETE" },
  tags: { destructive: true, idempotent: true },
}

/**
 * `http.head` — verb HEAD + readOnly tag (semantically identical to GET).
 * Rarely needed directly — autoMethodLayer derives HEAD from GET automatically.
 */
const head: VerbBundle = {
  http: { verb: "HEAD" },
  tags: { readOnly: true },
}

/**
 * `http.options` — verb OPTIONS + readOnly tag.
 * Rarely needed directly — autoMethodLayer handles OPTIONS automatically.
 */
const options: VerbBundle = {
  http: { verb: "OPTIONS" },
  tags: { readOnly: true },
}

// ============================================================================
// Exported namespace
// ============================================================================

/**
 * HTTP verb-helper bundles.
 *
 * Each is a metadata VALUE (not a wrapper fn) bundling a verb pin and the
 * behavioral tags that verb implies. Attach to a leaf node via `op`:
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
