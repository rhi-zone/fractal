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

import { api, fallback, op } from "@rhi-zone/fractal-api-tree";
import type { Handler, Node } from "@rhi-zone/fractal-api-tree/node";
import { http } from "./verbs.ts";
import {
  applyMethods,
  applyMoveTo,
  applyResponse,
  composeTransforms,
  naiveTransform,
} from "./route.ts";
import type { HttpRoute } from "./route.ts";

// ============================================================================
// crud() — convention constructor for the standard 5-op REST resource
// ============================================================================

/**
 * Standard CRUD handler set. All optional — pass only the operations the
 * resource supports; `crud()` wires the rest for you.
 */
export type CrudHandlers = {
  readonly list?: Handler;
  readonly create?: Handler;
  readonly get?: Handler;
  readonly update?: Handler;
  readonly delete?: Handler;
};

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
  const children: Record<string, Node> = {};
  if (handlers.list !== undefined) children.list = op(handlers.list, http.get);
  if (handlers.create !== undefined) children.create = op(handlers.create, http.post);
  if (handlers.get !== undefined) children.get = op(handlers.get, http.get);
  if (handlers.update !== undefined) children.update = op(handlers.update, http.put);
  if (handlers.delete !== undefined) children.delete = op(handlers.delete, http.delete);
  return api(children);
}

// ============================================================================
// restCrud() — convention constructor for the actual REST-shaped 5-op
// resource (list/create at the collection root, get/update/delete co-located
// onto the dynamic id segment via moveTo)
// ============================================================================

/** `restCrud()`'s own options. */
export type RestCrudOptions = {
  /**
   * Name of the dynamic id segment's fallback param, e.g. `"bookId"` binds
   * `input.bookId` for `get`/`update`/`delete`. Defaults to `"id"`.
   */
  readonly idParam?: string;
};

/**
 * Convention constructor, sibling to `crud()` above but producing the actual
 * REST resource shape instead of `crud()`'s flat sibling-key shape:
 *
 * ```
 * GET    /          — list
 * POST   /          — create
 * GET    /:id       — get
 * PUT    /:id       — update
 * DELETE /:id       — delete
 * ```
 *
 * `crud()` stays exactly as-is (its flat `list`/`create`/`get`/`update`/
 * `delete` sibling-key shape is a real, still-used convention for whoever
 * wants it) — this is a genuinely different combinator, not a
 * backwards-compatible upgrade to it.
 *
 * Built from three pieces, none of them new machinery:
 *   - `list`/`create` are each authored as a child of the resource node
 *     carrying `http.moveTo("..")` — `applyMoveTo` (route.ts) resolves `".."`
 *     relative to the child's own position, which is exactly the resource
 *     node's own position, so both collapse onto the resource root itself as
 *     two distinct methods (`GET`, `POST`) on the same node — the identical
 *     "child moves up onto its own parent" mechanic `library-api`'s
 *     `readBook`/`replaceBook`/`removeBook` already use one level deeper (see
 *     examples/library-api/src/tree.ts's own module doc for that motivating
 *     example).
 *   - `get`/`update`/`delete` are each authored the same way one level
 *     deeper — as children of the id fallback's own subtree, each with
 *     `http.moveTo("..")` — so they collapse onto the fallback subtree's own
 *     root instead of getting their own `/get`, `/update`, `/delete`
 *     sub-segments.
 *   - `fallback()` (api-tree's node.ts) constructs the `{ name, subtree }`
 *     shape for the id segment from that children map directly, instead of
 *     this function hand-rolling the raw `{ name, subtree: api({...}) }`
 *     literal itself.
 *
 * `opts.fallback` is only set when at least one of `get`/`update`/`delete` is
 * provided — a `restCrud({ list, create })` call (no id-scoped operations at
 * all) produces a resource with no fallback segment, matching `crud()`'s own
 * "only wire what's provided" behavior for a partial handler set.
 *
 * ```ts
 * api({ books: restCrud({ list: listBooks, create: addBook, get: getBook,
 *   update: replaceBook, delete: removeBook }, { idParam: "bookId" }) })
 * ```
 */
export function restCrud(handlers: CrudHandlers, opts: RestCrudOptions = {}): Node {
  const idParam = opts.idParam ?? "id";

  const rootChildren: Record<string, Node> = {};
  if (handlers.list !== undefined)
    rootChildren.list = op(handlers.list, http.get, http.moveTo(".."));
  if (handlers.create !== undefined)
    rootChildren.create = op(handlers.create, http.post, http.moveTo(".."));

  const idChildren: Record<string, Node> = {};
  if (handlers.get !== undefined) idChildren.get = op(handlers.get, http.get, http.moveTo(".."));
  if (handlers.update !== undefined)
    idChildren.update = op(handlers.update, http.put, http.moveTo(".."));
  if (handlers.delete !== undefined)
    idChildren.delete = op(handlers.delete, http.delete, http.moveTo(".."));

  return Object.keys(idChildren).length > 0
    ? api(rootChildren, { fallback: fallback(idParam, idChildren) })
    : api(rootChildren);
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
  readonly transforms?: ReadonlyArray<(route: HttpRoute) => HttpRoute>;
};

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
  const transforms = opts?.transforms ?? [applyMethods, applyMoveTo, applyResponse];
  const rewrite = composeTransforms(...transforms);
  return rewrite(naiveTransform(tree));
}
