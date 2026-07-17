// packages/http-api-projector/src/dx.ts — @rhi-zone/fractal-http-api-projector
//
// DX sugar built on top of the core Node model and the HttpRoute rewriter
// pipeline (route.ts):
//   - `crud(handlers)`    — convention constructor for the 5-op REST-resource
//                           shape, wiring `http.*` method bundles for you.
//   - `httpProjection()`  — one-call `Node => HttpRoute` with the standard
//                           rewriters (`applyMethods`, `applyMoveTo`,
//                           `applyResponse`) pre-composed, still swappable.
//
// See docs/design/routing-and-transforms.md § DX — constructor sugar.

import { api, op } from "@rhi-zone/fractal-api-tree"
import type { Handler, Node } from "@rhi-zone/fractal-api-tree/node"
import { http } from "./verbs.ts"
import { applyMethods, applyMoveTo, applyResponse, composeTransforms, naiveTransform } from "./route.ts"
import type { HttpRoute } from "./route.ts"

// ============================================================================
// crud() — convention constructor for the standard 5-op REST resource
// ============================================================================

/**
 * Standard CRUD handler set. All optional — pass only the operations the
 * resource supports; `crud()` wires the rest for you.
 */
export type CrudHandlers = {
  readonly list?: Handler
  readonly create?: Handler
  readonly get?: Handler
  readonly update?: Handler
  readonly delete?: Handler
}

/**
 * Convention constructor: returns a node with standard CRUD operations and
 * HTTP method metadata pre-wired via `http.*` bundles. Accepts a partial
 * handler set — not all five operations are required.
 *
 * ```ts
 * api({ users: crud({ list: listUsers, create: createUser, get: getUser }) })
 * ```
 *
 * Users can define their own `crud()` trivially — it's ~7 lines over
 * `api()` + `op()` + `http.*`. This is the batteries-included default.
 */
export function crud(handlers: CrudHandlers): Node {
  const children: Record<string, Node> = {}
  if (handlers.list !== undefined) children.list = op(handlers.list, http.get)
  if (handlers.create !== undefined) children.create = op(handlers.create, http.post)
  if (handlers.get !== undefined) children.get = op(handlers.get, http.get)
  if (handlers.update !== undefined) children.update = op(handlers.update, http.put)
  if (handlers.delete !== undefined) children.delete = op(handlers.delete, http.delete)
  return api(children)
}

// ============================================================================
// httpProjection() — pre-composed Node => HttpRoute preset
// ============================================================================

export type HttpProjectionOptions = {
  /**
   * Override the rewriter pipeline applied after `naiveTransform`. Defaults
   * to `[applyMethods, applyMoveTo, applyResponse]`. Order matters —
   * `composeTransforms` runs them left to right.
   */
  readonly transforms?: ReadonlyArray<(route: HttpRoute) => HttpRoute>
}

/**
 * One-call `Node => HttpRoute` projection with the standard rewriter
 * pipeline pre-composed:
 *
 * ```ts
 * const routes = httpProjection(apiTree)
 * // Equivalent to:
 * const routes = composeTransforms(applyMethods, applyMoveTo, applyResponse)(naiveTransform(apiTree))
 * ```
 *
 * Swap individual transforms via `opts.transforms`:
 *
 * ```ts
 * const routes = httpProjection(apiTree, {
 *   transforms: [applyMethods, myCustomPlacement, applyResponse],
 * })
 * ```
 */
export function httpProjection(tree: Node, opts?: HttpProjectionOptions): HttpRoute {
  const transforms = opts?.transforms ?? [applyMethods, applyMoveTo, applyResponse]
  const rewrite = composeTransforms(...transforms)
  return rewrite(naiveTransform(tree))
}
