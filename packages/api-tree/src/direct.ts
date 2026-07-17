// packages/api-tree/src/direct.ts — @rhi-zone/fractal-api-tree
//
// createDirectApi(tree) — the zero-protocol-overhead projection.
//
// Same nested-proxy shape as the HTTP client (packages/http-api-projector/
// src/client.ts): branch nodes become nested objects, a `fallback` becomes a
// `(slugValue) => subApi` function, and a leaf becomes an async callable.
// Unlike the client, this walks the raw `Node` tree directly — there is no
// HttpRoute pipeline, no verb/path derivation, no fetch/serialization.
//
// Bound slug values: on the HTTP side, `runPipeline`'s `bulkCollect` seeds
// the decoded input bag with the request's captured slugs before merging in
// query/body fields (slugs first, explicit fields win on conflict — see
// packages/http-api-projector/src/decode.ts `bulkCollect`). A handler like
// `readBook` in examples/library-api declares `input: { bookId: string }`
// and relies on that seeding — it is never passed `bookId` explicitly by a
// caller. `api.books.bookId("123").read()` only works if this projection
// reproduces that seeding: each `fallback` call accumulates its slug value,
// and every leaf beneath it merges the accumulated slugs into the input
// object it hands the handler (accumulated slugs first, caller-supplied
// fields win — same precedence as `bulkCollect`).
//
// A node carrying BOTH a handler and children (an uncommon but valid Node
// shape, see node.ts) becomes a callable function with the child API
// members attached as properties on it — same pattern the client uses for a
// route position with co-located methods and children.
//
// See:
//   packages/api-tree/src/node.ts                 — Node, Handler, fallback, isLeaf
//   packages/http-api-projector/src/client.ts     — the HTTP-backed analogue
//   packages/http-api-projector/src/decode.ts      — bulkCollect (slug-seeding precedent)

import { isLeaf } from "./node.ts"
import type { Node } from "./node.ts"

// A leaf's callable form (`(input?) => Promise<unknown>`) and a branch's
// object form are structurally incompatible as a TS union for property
// access (`api.books.list()` needs `AnyApi` to be indexable at every level,
// including the callable-with-attached-children case) — same shape/tradeoff
// as `AnyClient` in http-api-projector's client.ts. Callers index into it dynamically;
// internal builders cast to `AnyApi` at each return site (mirrors
// `buildClientNode`'s own `as AnyClient` casts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyApi = Record<string, any>

type Slugs = Readonly<Record<string, string>>

/** True for a plain mergeable object — not null, not an array. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * Merge accumulated slug values into the caller-supplied input, slugs first
 * so explicit fields win on conflict — mirrors `bulkCollect`'s precedence.
 * With no accumulated slugs, the input passes through unchanged (including
 * non-object inputs, which a slug bag can't merge into).
 */
function withSlugs(slugs: Slugs, input: unknown): unknown {
  if (Object.keys(slugs).length === 0) return input
  if (input === undefined) return { ...slugs }
  if (isPlainObject(input)) return { ...slugs, ...input }
  return input
}

/** Wrap a leaf's handler as an async callable: `(input?) => Promise<unknown>`. */
function makeCaller(node: Node, slugs: Slugs): (input?: unknown) => Promise<unknown> {
  return async (input?: unknown): Promise<unknown> => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return await node.handler!(withSlugs(slugs, input))
  }
}

function buildApi(tree: Node, slugs: Slugs): AnyApi {
  const hasChildren = tree.children !== undefined && Object.keys(tree.children).length > 0
  const hasFallback = tree.fallback !== undefined

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base: any = isLeaf(tree) ? makeCaller(tree, slugs) : {}

  if (hasChildren) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    for (const [key, child] of Object.entries(tree.children!)) {
      base[key] = buildApi(child, slugs)
    }
  }

  if (hasFallback) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const { name, subtree } = tree.fallback!
    base[name] = (slugValue: string): AnyApi => buildApi(subtree, { ...slugs, [name]: slugValue })
  }

  return base as AnyApi
}

/**
 * Recursively build a direct-call API from a `Node` tree.
 *
 * - Leaf (handler, no children/fallback): an async callable.
 * - Branch (children and/or fallback, no handler): a nested object.
 * - Both handler and children: a callable function with children attached
 *   as properties on it.
 * - `fallback`: a `(slugValue: string) => subApi` function keyed by
 *   `fallback.name`, mirroring the client's wildcard-capture handling. The
 *   slug value is threaded down and merged into every descendant leaf's
 *   input (see module doc — `bulkCollect` precedent).
 */
export function createDirectApi(tree: Node): AnyApi {
  return buildApi(tree, {})
}
