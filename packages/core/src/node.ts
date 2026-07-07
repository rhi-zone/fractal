// packages/core/src/node.ts — @rhi-zone/fractal-core  (new model, alongside legacy spine)
//
// The new fractal authoring model: Node / Op / Meta / ParamNode / ChildEntry +
// constructors (op / node / service / param) + a runtime dispatch walker.
//
// This module is SEPARATE from the legacy function-core spine in index.ts, which
// remains untouched. Import directly from "./node.ts" until the two are merged.
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

/** An operation IS a function T => U, carrying an open metadata bag. */
export type Op<I = unknown, O = unknown> = {
  readonly fn: (input: I) => O | Promise<O>
  readonly meta: Meta
}

/**
 * A parameterized child node (server-less: `slug_mounts`).
 * When the HTTP projection walks the tree it contributes `{name}` as a path
 * segment. At runtime dispatch, the actual segment value is merged into the
 * op's input object under `name`, provenance-blind (the handler sees the slug
 * key in its input; it does not know whether it came from a path segment, a
 * query param, or the body).
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
 * A node's key IS its address segment; behavior (`fn`) carries none.
 * Both authoring surfaces (service / standalone) lower to this value.
 */
export type Node = {
  readonly ops: Readonly<Record<string, Op>>
  readonly children: Readonly<Record<string, ChildEntry>>
  readonly meta: Meta
}

// ============================================================================
// Discriminators
// ============================================================================

export const isNode = (v: unknown): v is Node =>
  typeof v === "object" &&
  v !== null &&
  "ops" in v &&
  "children" in v &&
  !("_tag" in v)

export const isParamNode = (v: unknown): v is ParamNode =>
  typeof v === "object" &&
  v !== null &&
  "_tag" in v &&
  (v as ParamNode)._tag === "param"

// ============================================================================
// Constructors
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpLike = Op<any, any> | ((input: any) => unknown | Promise<unknown>)

const asOp = (o: OpLike): Op =>
  typeof o === "function" ? { fn: o as Op["fn"], meta: {} } : o

/** Wrap a function into an Op with metadata. Bare fn → empty meta bag. */
export const op = <I, O>(
  fn: (input: I) => O | Promise<O>,
  meta: Meta = {},
): Op<I, O> => ({ fn, meta })

/**
 * Parameterized child node. `name` becomes the `{name}` segment in the HTTP
 * path. The actual slug value is merged into descendant op inputs at runtime
 * dispatch. TS equivalent of server-less `slug_mounts`.
 */
export const param = (name: string, subtree: Node): ParamNode =>
  ({ _tag: "param", name, subtree })

/** [CERTIFIED] Standalone-function authoring surface. Keys are address segments. */
export const node = (def: {
  ops?: Record<string, OpLike>
  children?: Record<string, ChildEntry>
  meta?: Meta
}): Node => ({
  ops: Object.fromEntries(
    Object.entries(def.ops ?? {}).map(([k, v]) => [k, asOp(v)]),
  ),
  children: def.children ?? {},
  meta: def.meta ?? {},
})

/**
 * Lower a service instance to a Node (the `impl`-block / method surface).
 *  - each method                  → ops[name]      (server-less: &self leaf method)
 *  - each Node-valued field       → children[name] (server-less: static mount)
 *  - each ParamNode-valued field  → children[name] (server-less: slug mount)
 *  - opts.meta[name]              → that op's metadata bag
 *
 * Both `node()` and `service()` produce the identical `{ops, children, meta}`
 * value — there is one Node primitive; both surfaces lower to it.
 */
export const service = (
  instance: object,
  opts: { meta?: Record<string, Meta> } = {},
): Node => {
  const ops: Record<string, Op> = {}
  const children: Record<string, ChildEntry> = {}
  const proto = Object.getPrototypeOf(instance) as object
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === "constructor") continue
    const val = (instance as Record<string, unknown>)[key]
    if (typeof val === "function") {
      ops[key] = {
        fn: (val as Op["fn"]).bind(instance),
        meta: opts.meta?.[key] ?? {},
      }
    }
  }
  for (const key of Object.getOwnPropertyNames(instance)) {
    const val = (instance as Record<string, unknown>)[key]
    if (isNode(val) || isParamNode(val)) children[key] = val
  }
  return { ops, children, meta: {} }
}

// ============================================================================
// Runtime dispatch / walk
//
// Traverses a Node tree, accumulating param-node slug values and merging them
// provenance-blind into an op's input before calling fn. This is the minimal
// dispatch primitive — the full HTTP projection lives in packages/http.
// ============================================================================

/**
 * Dispatch: walk a Node tree along `segments`, accumulate slug values from
 * `ParamNode` children, and call the terminal op with `{ ...input, ...slugs }`.
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

  if (tail.length === 0) {
    // Terminal: head names the op; merge slugs into input and call
    const o = n.ops[head]
    if (o === undefined) throw new Error(`dispatch: op not found: ${head}`)
    return o.fn({ ...(input as object), ...slugs })
  }

  // Non-terminal: head names a child; recurse.
  // Try static lookup first (key in children === segment name).
  const staticChild = n.children[head]
  if (staticChild !== undefined) {
    if (isParamNode(staticChild)) {
      return dispatch(staticChild.subtree, tail, input, { ...slugs, [staticChild.name]: head })
    }
    return dispatch(staticChild, tail, input, slugs)
  }

  // No static match — scan for a ParamNode child. The child's slot-key is the
  // tree-authoring identifier (e.g. "invoiceId"); the current segment value
  // (head) is the actual runtime slug that gets merged into op input.
  // (There should be at most one ParamNode per level in a well-formed tree.)
  const paramChild = Object.values(n.children).find(isParamNode)
  if (paramChild !== undefined) {
    return dispatch(paramChild.subtree, tail, input, { ...slugs, [paramChild.name]: head })
  }

  throw new Error(`dispatch: child not found: ${head}`)
}
