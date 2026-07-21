// packages/api-tree/src/node.ts — @rhi-zone/fractal-api-tree  (new model, alongside legacy spine)
//
// The new fractal authoring model: Node / Handler / Meta + constructors
// (op / api) + mergeMeta.
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
// `api(children, opts?)` produces a branch node.
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
export interface Meta {
  tags?: Tags
  /**
   * Agnostic description text — read by every projector (cli, mcp, graphql,
   * …) as a fallback beneath their own namespaced `description` override
   * (e.g. `meta.mcp.description`). See docs/design/converged-model.md's
   * precedence chain: `meta.mcp.description > meta.description >
   * derived.description > ...`.
   */
  description?: string
}

/** The bare callable on a leaf node. Provenance-blind: handler sees one flat input. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler<I = any, O = any> = (input: I) => O | Promise<O>

/**
 * [CERTIFIED] One tree = grouping AND addressing.
 * A node's key IS its address segment; behavior (`handler`) carries none.
 * Both `op()` and `api()` lower to this value.
 *
 * - LEAF: `handler` is present (a callable). May have no `children`.
 * - BRANCH: `children` is present. May have no `handler`.
 * - Both is valid (uncommon).
 * - `fallback`: optional wildcard-capture subtree. When keyed dispatch at this
 *   node finds no child matching the current request value, the fallback
 *   consumes that value, binds it as `fallback.name` in the handler input,
 *   and continues into `fallback.subtree`. Static children always win.
 * - `meta` is always present.
 *
 * Generic over `H` (this node's own handler type), defaulting to the erased
 * `Handler` so `Node` keeps working everywhere it's used as a plain type
 * (projections, `Record<string, Node>`, etc.) — only `op()` call sites that
 * want the concrete handler type preserved need to lean on the generic;
 * nothing downstream has to opt in.
 *
 * `children`'s declared type here is intentionally the erased
 * `Record<string, Node>` — a `children` map keyed to each child's own exact
 * `Node<H>` can't be expressed as a *default* on a second type parameter
 * without TS rejecting it as a circular default (a generic parameter
 * defaulting to a map of the enclosing type is a known TS limitation, unlike
 * ordinary recursive aliases). `api()` instead preserves the concrete
 * children map by intersecting it onto its return type at the call site —
 * see `api()`'s own doc comment.
 */
export type Node<H extends Handler = Handler> = {
  readonly handler?: H
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
 * Recursively merge two record-like values with precedence: `value` wins
 * per key. Plain objects merge deeper; arrays concatenate; anything else
 * (including a type mismatch) resolves to `value`.
 */
function mergeRecords(
  existing: Record<string, unknown>,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing }
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue
    const e = out[key]
    if (Array.isArray(e) && Array.isArray(v)) {
      out[key] = [...e, ...v]
    } else if (
      typeof e === "object" && e !== null && !Array.isArray(e) &&
      typeof v === "object" && v !== null && !Array.isArray(v)
    ) {
      out[key] = mergeRecords(e as Record<string, unknown>, v as Record<string, unknown>)
    } else {
      out[key] = v
    }
  }
  return out
}

/**
 * Deep-merge meta bags with precedence: later bags win per key;
 * `undefined` defers (does not override a previously-set value).
 *
 * Merge is fully recursive: plain objects merge deeper (e.g. tags, http
 * sub-bags), arrays concatenate (e.g. `http.directives`), and scalars are
 * overwritten by the later bag.
 */
export function mergeMeta(...metas: Array<Meta | undefined>): Meta {
  let out: Record<string, unknown> = {}
  for (const m of metas) {
    if (m === undefined) continue
    out = mergeRecords(out, m as Record<string, unknown>)
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
 *
 * Generic in `H` (the exact handler type): `op(fn)`'s result carries `fn`'s
 * real signature as `["handler"]`, not the erased `Handler`. This is
 * what lets `api({ getBook: op((input: {id: string}) => ...) })` produce a
 * tree whose `children.getBook.handler` still has `fn`'s real input/output
 * types instead of `Handler`'s `(input: any) => any`.
 *
 * The return type marks `handler` as present (not the optional `handler?`
 * `Node<H>` declares) — `op()` always sets it, and callers that need to
 * distinguish a leaf from a branch generically (e.g. a recursive projection
 * over an arbitrary tree, computing its own return type from the input's
 * shape) can key a conditional type off "does this type have a required
 * `handler`," which a branch produced by `api()` alone never structurally
 * satisfies.
 */
export function op<H extends Handler>(
  fn: H,
  ...contributions: Array<Meta>
): Omit<Node, "handler"> & { readonly handler: H } {
  const meta = contributions.length === 0
    ? {}
    : contributions.length === 1
      ? contributions[0]!
      : mergeMeta(...contributions)
  return { handler: fn, meta }
}

/**
 * Produce a branch node: a Node carrying children (and optional meta/fallback).
 * Leaf nodes (callables) belong in `children` keyed by name — they ARE nodes,
 * created with `op()`.
 *
 * `api(children, opts?)` — positional children for the common case, an
 * options object for the rare stuff (meta, fallback).
 *
 * `api()` is the (only) branch-node constructor.
 *
 * Generic in `C` (the exact children map): the input `children` object's
 * per-key `Node<H>` types survive into the result's `children`, instead of
 * widening to `Record<string, Node>`. So `api({ getBook: op(fn) })` yields a
 * `Node` whose `children.getBook.handler` is still `fn`'s real type.
 *
 * Generic in `F` (the exact fallback shape) the same way: `opts.fallback`'s
 * literal `{ name, subtree }` — subtree included — survives into the
 * result's `fallback`, instead of widening `subtree` to the erased `Node`
 * OR widening `name` to plain `string`. Defaults to `undefined` (no
 * `fallback` key on the result at all) when `opts.fallback` isn't passed, so
 * a plain `api(children)` call doesn't grow a spurious optional `fallback`
 * field.
 *
 * `F` is a `const` type parameter (TS 5.0+) — without `const`, TS widens a
 * literal it infers for an object property whose declared type, at the
 * generic-inference site, is a bare (non-generic) `string`; `name: string`
 * inside `F`'s constraint is exactly that site, so `api(children, {
 * fallback: { name: "bookId", subtree } })` would infer `F["name"]` as
 * `string`, not `"bookId"`. `const F` tells inference to keep the argument's
 * literal types (as if every literal in it were written `as const`) rather
 * than widening to their base types — the same effect `as const` has on a
 * value, applied automatically to this parameter's inference. With it,
 * `fallback.name` survives as a literal all the way through `checker
 * .getTypeOfSymbolAtLocation` in tree.ts's walker, no AST fallback needed.
 *
 * See docs/design/routing-and-transforms.md § DX — constructor sugar.
 */
export function api<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  C extends Readonly<Record<string, Node<any>>>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const F extends { readonly name: string; readonly subtree: Node<any> } | undefined = undefined,
>(
  children: C,
  opts?: { meta?: Meta; fallback?: F },
): Omit<Node, "children" | "fallback"> & { readonly children: C } & (F extends undefined ? object : { readonly fallback: F }) {
  return {
    ...(children !== undefined ? { children } : {}),
    ...(opts?.fallback !== undefined ? { fallback: opts.fallback } : {}),
    meta: opts?.meta ?? {},
  } as Omit<Node, "children" | "fallback"> & { readonly children: C } & (F extends undefined ? object : { readonly fallback: F })
}
