// packages/core/src/node.ts — @rhi-zone/fractal-core  (new model, alongside legacy spine)
//
// The new fractal authoring model: Node / Handler / Meta / ParamNode / ChildEntry +
// constructors (op / node / service / param) + mergeMeta + a runtime dispatch walker.
//
// Node shape:
//   - A LEAF node carries `handler` (the bare fn) and may have no `children`.
//   - A BRANCH node carries `children` and no handler.
//   - A node MAY carry both (uncommon but valid).
//   - Every node carries `meta` (the open metadata bag).
//
// `op(fn, meta?)` produces a leaf node.
// `node({ children?, meta? })` produces a branch node.
// `service(instance, opts?)` walks a class → children that are leaf nodes.
//
// This module is SEPARATE from the legacy function-core spine in index.ts.
// Import directly from "./node.ts" until the two are merged.
//
// See:
//   docs/artifacts/fc-op-kinds/concrete-api-v2.md  — types + constructors
//   docs/design/converged-model.md                  — certified constraints
// ============================================================================

import type { Tags } from "./tags.ts"

// ============================================================================
// Core types
// ============================================================================

/**
 * Open metadata bag — arbitrary keys, NOT a closed set.
 *
 * Two uses co-exist in this bag:
 *   1. Projection namespaces: `meta.http = { verb: "GET", segment: "users" }`
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
 * A parameterized child node (server-less: `slug_mounts`).
 * When the HTTP projection walks the tree it contributes `{name}` as a path
 * segment. At runtime dispatch, the actual segment value is merged into the
 * handler's input object under `name`, provenance-blind (the handler sees the
 * slug key in its input; it does not know whether it came from a path segment,
 * a query param, or the body).
 */
export type ParamNode = {
  readonly _tag: "param"
  readonly name: string
  readonly subtree: Node
}

/**
 * A child slot in a Node is either a static subtree or a parameterized subtree.
 * Distinguishable at runtime via `isParamNode`.
 */
export type ChildEntry = Node | ParamNode

/**
 * [CERTIFIED] One tree = grouping AND addressing.
 * A node's key IS its address segment; behavior (`handler`) carries none.
 * Both authoring surfaces (service / standalone) lower to this value.
 *
 * - LEAF: `handler` is present (a callable). May have no `children`.
 * - BRANCH: `children` is present. May have no `handler`.
 * - Both is valid (uncommon).
 * - `meta` is always present.
 */
export type Node = {
  readonly handler?: Handler
  readonly children?: Readonly<Record<string, ChildEntry>>
  readonly meta: Meta
}

// ============================================================================
// Discriminators
// ============================================================================

export const isNode = (v: unknown): v is Node =>
  typeof v === "object" &&
  v !== null &&
  "meta" in v &&
  !("_tag" in v)

export const isParamNode = (v: unknown): v is ParamNode =>
  typeof v === "object" &&
  v !== null &&
  "_tag" in v &&
  (v as ParamNode)._tag === "param"

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
 *
 * Generalization of the former `effectiveTags` closest-wins logic: accumulate
 * ancestor meta down the walk, not just tags.
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
 * Produce a branch node: a Node carrying children (and optional meta).
 * Leaf nodes (callables) belong in `children` keyed by name — they ARE nodes,
 * created with `op()`.
 *
 * `node({ children?, meta? })`.
 */
export const node = (def: {
  children?: Record<string, ChildEntry>
  meta?: Meta
}): Node => ({
  ...(def.children !== undefined ? { children: def.children } : {}),
  meta: def.meta ?? {},
})

/**
 * Parameterized child node. `name` becomes the `{name}` segment in the HTTP
 * path. The actual slug value is merged into descendant handler inputs at
 * runtime dispatch. TS equivalent of server-less `slug_mounts`.
 */
export const param = (name: string, subtree: Node): ParamNode =>
  ({ _tag: "param", name, subtree })

/**
 * Lower a service instance to a Node (the `impl`-block / method surface).
 *  - each method                  → children[name]  (a LEAF node — has handler)
 *  - each Node-valued field       → children[name]  (static mount)
 *  - each ParamNode-valued field  → children[name]  (slug mount)
 *  - opts.meta[name]              → that child leaf node's metadata bag
 *
 * Both `node()` and `service()` produce the identical `{handler?, children, meta}`
 * value — there is one Node primitive; both surfaces lower to it.
 */
export const service = (
  instance: object,
  opts: { meta?: Record<string, Meta> } = {},
): Node => {
  const children: Record<string, ChildEntry> = {}
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
    if (isNode(val) || isParamNode(val)) children[key] = val
  }
  return { children, meta: {} }
}

// ============================================================================
// Runtime dispatch / walk
//
// Traverses a Node tree, accumulating param-node slug values and merging them
// provenance-blind into a handler's input before calling it. This is the minimal
// dispatch primitive — the full HTTP projection lives in packages/http.
// ============================================================================

/**
 * Dispatch: walk a Node tree along `segments`, accumulate slug values from
 * `ParamNode` children, and call the terminal handler with `{ ...input, ...slugs }`.
 *
 * In the new model, a leaf node stored in `children[key]` is the terminal:
 *   dispatch(root, ["invoices", "inv-42", "checkout"], input)
 *   → enters children["invoices"] (branch)
 *   → finds ParamNode, extracts slug "inv-42"
 *   → enters subtree, finds children["checkout"] (leaf)
 *   → calls checkout.handler({ ...input, invoiceId: "inv-42" })
 *
 * Provenance-blind by design — the handler sees one flat input object and
 * cannot tell whether any field came from a path slug, query param, or body.
 *
 * @param n        - The node to dispatch into.
 * @param segments - Remaining path segments (e.g. ["invoiceId-value", "checkout"]).
 * @param input    - Request body / query merged object.
 * @param slugs    - Accumulated slug values from ancestor `param()` nodes.
 */
export function dispatch(
  n: Node,
  segments: string[],
  input: unknown,
  slugs: Record<string, string> = {},
): unknown {
  if (segments.length === 0) throw new Error("dispatch: no segments provided")
  const [head, ...tail] = segments
  if (head === undefined) throw new Error("dispatch: no segments provided")

  const children = n.children ?? {}

  if (tail.length === 0) {
    // Terminal: head names a leaf child (a node with handler)
    const child = children[head]
    if (child === undefined || isParamNode(child)) {
      throw new Error(`dispatch: op not found: ${head}`)
    }
    if ((child as Node).handler === undefined) {
      throw new Error(`dispatch: op not found: ${head}`)
    }
    return (child as Node).handler!({ ...(input as object), ...slugs })
  }

  // Non-terminal: head names a child branch; recurse.
  // Try static lookup first (key in children === segment name).
  const staticChild = children[head]
  if (staticChild !== undefined) {
    if (isParamNode(staticChild)) {
      return dispatch(staticChild.subtree, tail, input, { ...slugs, [staticChild.name]: head })
    }
    return dispatch(staticChild as Node, tail, input, slugs)
  }

  // No static match — scan for a ParamNode child. The child's slot-key is the
  // tree-authoring identifier (e.g. "invoiceId"); the current segment value
  // (head) is the actual runtime slug that gets merged into handler input.
  // (There should be at most one ParamNode per level in a well-formed tree.)
  const paramChild = Object.values(children).find(isParamNode)
  if (paramChild !== undefined) {
    return dispatch(paramChild.subtree, tail, input, { ...slugs, [paramChild.name]: head })
  }

  throw new Error(`dispatch: child not found: ${head}`)
}
