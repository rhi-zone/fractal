// packages/core/src/node.ts — @rhi-zone/fractal-core  (new model, alongside legacy spine)
//
// The new fractal authoring model: Node / Handler / Meta + constructors
// (op / node / service) + mergeMeta.
//
// Node shape:
//   - A LEAF node carries `handler` (the bare fn) and may have no `children`.
//   - A BRANCH node carries `children` and no handler.
//   - Both is valid (uncommon but valid).
//   - Every node carries `meta` (the open metadata bag).
//   - A node MAY carry `fallback: { name, subtree }` — when keyed dispatch at
//     this node finds no matching child, the fallback consumes the value,
//     binds it as a named parameter, and continues into `subtree`. Static
//     children always win; fallback fires only when no child matches.
//
// `op(fn, meta?)` produces a leaf node.
// `node({ children?, fallback?, meta? })` produces a branch node.
// `service(instance, opts?)` walks a class → children that are leaf nodes.
//   An instance field literally named `fallback` (shape `{ name, subtree }`)
//   becomes the resulting node's `fallback` rather than a keyed child.
//
// This module is SEPARATE from the legacy function-core spine in index.ts.
// Import directly from "./node.ts" until the two are merged.
//
// See:
//   docs/design/router-model.md — Node Shape (settled node shape + fallback)
// ============================================================================

import type { Tags } from "./tags.ts"

// ============================================================================
// Core types
// ============================================================================

/**
 * Open metadata bag — arbitrary keys, NOT a closed set.
 *
 * Two uses co-exist in this bag:
 *   1. Projection namespaces: `meta.http = { dispatch: {...}, directives: [...] }`
 *   2. Agnostic behavioral tags: `meta.tags = { readOnly: true }`
 *
 * Types (+ JSDoc) are the truth for domain data. This bag is ONLY for
 * non-type-expressible projection/taste concerns (verb, segment, idempotency,
 * auth). Never a second source for domain data.
 */
export type Meta = { tags?: Tags; readonly [key: string]: unknown }

/** The bare callable on a leaf node. Provenance-blind: handler sees one flat input. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler<I = any, O = any> = (input: I) => O | Promise<O>

/**
 * [CERTIFIED] One tree = grouping AND addressing.
 * A node's key IS its address segment; behavior (`handler`) carries none.
 * Both authoring surfaces (service / standalone) lower to this value.
 *
 * - LEAF: `handler` is present (a callable). May have no `children`.
 * - BRANCH: `children` is present. May have no `handler`.
 * - Both is valid (uncommon).
 * - `fallback`: optional wildcard-capture subtree. When keyed dispatch at this
 *   node finds no child matching the current request value, the fallback
 *   consumes that value, binds it as `fallback.name` in the handler input,
 *   and continues into `fallback.subtree`. Static children always win.
 * - `meta` is always present.
 */
export type Node = {
  readonly handler?: Handler
  readonly children?: Readonly<Record<string, Node>>
  readonly fallback?: { readonly name: string; readonly subtree: Node }
  readonly meta: Meta
}

// ============================================================================
// Discriminators
// ============================================================================

export const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && "meta" in v

/** True when `n` is a leaf node (carries a handler). */
export const isLeaf = (n: Node): boolean => n.handler !== undefined

// ============================================================================
// Meta merge
// ============================================================================

/**
 * Deep-merge meta bags with precedence: later bags win per key;
 * `undefined` defers (does not override a previously-set value).
 *
 * Per sub-bag (tags, http, …): keys are merged one level deep. Later wins.
 */
export function mergeMeta(...metas: Array<Meta | undefined>): Meta {
  const out: Record<string, unknown> = {}
  for (const m of metas) {
    if (m === undefined) continue
    for (const [key, value] of Object.entries(m)) {
      if (value === undefined) continue
      const existing = out[key]
      if (
        typeof existing === "object" && existing !== null &&
        typeof value === "object" && value !== null &&
        !Array.isArray(existing) && !Array.isArray(value)
      ) {
        // Both are plain objects: merge one level deeper (e.g. tags sub-bag)
        out[key] = { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) }
      } else {
        out[key] = value
      }
    }
  }
  return out as Meta
}

// ============================================================================
// Constructors
// ============================================================================

/**
 * Produce a leaf node: a Node carrying a handler and merged meta.
 *
 * `op(fn)` — bare fn → leaf with empty meta.
 * `op(fn, meta)` — leaf with a single meta bag.
 * `op(fn, ...contributions)` — leaf with multiple meta bags deep-merged
 *   left-to-right via `mergeMeta` (later wins per key; undefined defers).
 *   A verb-bundle + extra tags compose without either clobbering the other.
 *
 * The result IS a Node (not a separate `{fn, meta}` record). Projections
 * detect a leaf by `node.handler !== undefined`.
 */
export function op<I, O>(
  fn: (input: I) => O | Promise<O>,
  ...contributions: Array<Meta>
): Node {
  const meta = contributions.length === 0
    ? {}
    : contributions.length === 1
      ? contributions[0]!
      : mergeMeta(...contributions)
  return { handler: fn as Handler, meta }
}

/**
 * Produce a branch node: a Node carrying children (and optional meta/fallback).
 * Leaf nodes (callables) belong in `children` keyed by name — they ARE nodes,
 * created with `op()`.
 *
 * `node({ children?, fallback?, meta? })`.
 */
export const node = (def: {
  children?: Record<string, Node>
  fallback?: { name: string; subtree: Node }
  meta?: Meta
}): Node => ({
  ...(def.children !== undefined ? { children: def.children } : {}),
  ...(def.fallback !== undefined ? { fallback: def.fallback } : {}),
  meta: def.meta ?? {},
})

/** Duck-type check for the `{ name, subtree }` fallback shape. */
const isFallbackShape = (v: unknown): v is { name: string; subtree: Node } =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { name?: unknown }).name === "string" &&
  isNode((v as { subtree?: unknown }).subtree)

/**
 * Lower a service instance to a Node (the `impl`-block / method surface).
 *  - each method                        → children[name]  (a LEAF node — has handler)
 *  - each Node-valued field              → children[name]  (static mount)
 *  - a field literally named `fallback`
 *    with shape `{ name, subtree }`      → the resulting node's `fallback`
 *  - opts.meta[name]                     → that child leaf node's metadata bag
 *
 * Both `node()` and `service()` produce the identical `{handler?, children?,
 * fallback?, meta}` value — there is one Node primitive; both surfaces lower
 * to it.
 */
export const service = (
  instance: object,
  opts: { meta?: Record<string, Meta> } = {},
): Node => {
  const children: Record<string, Node> = {}
  let fallback: { name: string; subtree: Node } | undefined
  const proto = Object.getPrototypeOf(instance) as object
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === "constructor") continue
    const val = (instance as Record<string, unknown>)[key]
    if (typeof val === "function") {
      // Each method becomes a leaf node child
      children[key] = {
        handler: (val as Handler).bind(instance),
        meta: opts.meta?.[key] ?? {},
      }
    }
  }
  for (const key of Object.getOwnPropertyNames(instance)) {
    const val = (instance as Record<string, unknown>)[key]
    if (key === "fallback" && isFallbackShape(val)) {
      fallback = val
    } else if (isNode(val)) {
      children[key] = val
    }
  }
  return {
    children,
    ...(fallback !== undefined ? { fallback } : {}),
    meta: {},
  }
}
