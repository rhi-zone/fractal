// packages/http/src/project.ts — @rhi-zone/fractal-http
//
// The HTTP projection surface: produces the `HttpRoute` tree from an API
// `Node` tree (`toHttpRoutes`, a thin wrapper over `naiveTransform` in
// route.ts) and builds a fetch handler from it (`makeRouter`, over
// `makeRouterFromRoute`). Also carries the `meta.http` DU types the
// rewriters (route.ts) and the projector's own re-exports interpret, and
// `verbFromTags` — verb derivation from the tag lattice, re-exported here
// from tags.ts for backwards-compatible import paths.
//
// meta.http is a DU interpreted by the rewriter pipeline (interpreter
// pattern), not a fixed record of named keys:
//   meta.http.directives  — an array of HttpDirective DU values, each tagged
//                           by `kind` ("verb" | "segment" | "when" |
//                           "legacyPath" | "method" | "place" | "response")
//
// `dispatch` markers (header/query/contentType attribute dispatch) and the
// `legacyPath`/`segment`/`when` directives were interpreted by a direct
// tree-walk dispatcher that has been retired in favor of the single
// `HttpRoute` pipeline below (naiveTransform → rewriters → makeRouterFromRoute,
// see route.ts). Attribute dispatch (header/query/contentType-based routing
// at the same path+method) has no equivalent in the new pipeline yet — it
// is an open design question, see TODO.md.
//
// See:
//   docs/design/router-model.md              — Node Shape, Dispatch, HTTP metadata
//   docs/design/routing-and-transforms.md    — HttpRoute pipeline, DX
//   docs/design/dispatch-extensibility.md    — DU + interpreter pattern

import { makeRouterFromRoute, naiveTransform } from "./route.ts"
import type { HttpRoute } from "./route.ts"
import type { Node } from "@rhi-zone/fractal-core/node"

export { verbFromTags } from "./tags.ts"
export type { HttpRoute, Pipeline } from "./route.ts"
export {
  applyMethods,
  applyPlacement,
  applyResponse,
  composeTransforms,
  httpRoute,
  isHttpRoute,
  isResponseOverride,
  makeRouterFromRoute,
  naiveTransform,
  routeCandidatesForUrl,
} from "./route.ts"
export type { ResponseOverride } from "./route.ts"

/**
 * Produce the HTTP route tree from an API tree — the naive transform (see
 * route.ts): every child becomes a path-segment child, every handler
 * becomes a single POST entry. The baseline the rewriters (`applyMethods`,
 * `applyPlacement`, `applyResponse`, chained via `composeTransforms`) start
 * from.
 */
export function toHttpRoutes(node: Node): HttpRoute {
  return naiveTransform(node)
}

// ============================================================================
// meta.http DU types
// ============================================================================

/**
 * A single HTTP directive — a tagged variant interpreted by the rewriter
 * pipeline (route.ts) or, for the retired variants below, by other
 * packages' own self-contained tree walks (openapi, client — see those
 * packages' `getHttpMeta`). Interpreter pattern: each variant is a
 * self-describing value, not a fixed record field.
 *
 * Interpreted by the HttpRoute rewriters in route.ts — see
 * docs/design/routing-and-transforms.md:
 *
 * - `{ kind: "method", value }` — sets the HTTP method on a route's method
 *   entry (read by `applyMethods`; renames the `methods` key).
 * - `{ kind: "place", path }` — relative node placement in the output route
 *   tree (read by `applyPlacement`; see route.ts for the path algebra — a
 *   plain relative segment doubles as a path/segment rename, since the base
 *   position already excludes the node's own key).
 * - `{ kind: "response", status?, headers? }` — response overrides,
 *   materialized into the handler via composition (read by `applyResponse`).
 *
 * Interpreted by `verbFromTags` (tags.ts):
 *
 * - `{ kind: "verb", value }` — explicit verb override; wins over tags.
 *
 * Retired from http's own dispatch (the direct tree-walk dispatcher that
 * read these has been deleted) but still read by other packages' own
 * self-contained Node-tree walks (openapi, client) for their own,
 * independent projections:
 *
 * - `{ kind: "segment", value }`    — explicit path-segment rename.
 * - `{ kind: "when", value }`       — per-child match-value override for
 *   non-method attribute dispatch (key ≠ match value).
 * - `{ kind: "legacyPath", value }` — [DEBT] full-path override, bypasses
 *   the tree-walk address entirely.
 */
export type HttpDirective =
  | { readonly kind: "verb"; readonly value: string }
  | { readonly kind: "segment"; readonly value: string }
  | { readonly kind: "when"; readonly value: string }
  | { readonly kind: "legacyPath"; readonly value: string }
  | { readonly kind: "method"; readonly value: string }
  | { readonly kind: "place"; readonly path: string }
  | {
      readonly kind: "response"
      readonly status?: number
      readonly headers?: Record<string, string>
    }

// ============================================================================
// Response helpers
// ============================================================================

/** Build a sorted Allow header string from a set of HTTP method strings. */
export function allowHeader(verbs: Iterable<string>): string {
  return [...new Set(verbs)].sort().join(", ")
}

export function jsonResponse(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers)
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }
  return new Response(JSON.stringify(value), { ...init, headers })
}

// ============================================================================
// Core router — exact verb+path dispatch over an HttpRoute tree
//
// No HEAD-from-GET, no OPTIONS auto-response, no 405+Allow.
// Those HTTP-correctness behaviors live in the auto-method layer (layers.ts)
// and are droppable: the router functions correctly as a pure dispatcher
// without them, returning 404 for any request with no exact match.
// ============================================================================

/** Build a fetch handler from an `HttpRoute` tree — see `makeRouterFromRoute` in route.ts. */
export function makeRouter(root: HttpRoute): (req: Request) => Promise<Response> {
  return makeRouterFromRoute(root)
}
