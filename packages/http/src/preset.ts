// packages/http/src/preset.ts — @rhi-zone/fractal-http
//
// OOTB preset: composes the full HTTP stack into a ready-to-use fetch handler.
//
// Pipeline (in order, each independently droppable):
//   1. httpProjection  — Node => HttpRoute (naiveTransform + applyMethods +
//                         applyMoveTo + applyResponse, see dx.ts)
//   2. makeRouter      — exact path/method dispatcher over the HttpRoute tree
//   3. autoMethodLayer — HEAD-from-GET, OPTIONS→204+Allow, 405+Allow
//
// Optional (opt-in, off by default):
//   4. corsLayer        — CORS preflight + origin headers
//
// To drop the auto-method layer and use core routing only:
//   return makeRouter(httpProjection(node))
//
// To compose manually with CORS:
//   const routes  = httpProjection(node)
//   const router  = makeRouter(routes)
//   const methods = autoMethodLayer(router, routes)
//   return corsLayer({ origin: "https://app.example.com" })(methods)

import type { Node } from "@rhi-zone/fractal-core/node"
import { makeRouter } from "./project.ts"
import { httpProjection } from "./dx.ts"
import type { HttpProjectionOptions } from "./dx.ts"
import { autoMethodLayer, corsLayer } from "./layers.ts"
import type { CorsOptions } from "./layers.ts"

export type { CorsOptions }

export type PresetOptions = {
  /**
   * Enable CORS. Pass `true` for permissive defaults (`origin: "*"`) or a
   * `CorsOptions` object to configure origin, credentials, and maxAge.
   * Defaults to off.
   */
  readonly cors?: CorsOptions | boolean
  /**
   * Override the `Node => HttpRoute` rewriter pipeline (see `httpProjection`
   * in dx.ts). Defaults to `[applyMethods, applyMoveTo, applyResponse]`.
   */
  readonly projection?: HttpProjectionOptions
}

/**
 * Build an OOTB fetch handler from a Node tree.
 *
 * The returned handler is a WHATWG `fetch`-compatible function suitable
 * for `Bun.serve`, `Deno.serve`, a Cloudflare Worker, or any runtime that
 * accepts `(req: Request) => Promise<Response>`.
 */
export function createFetch(
  node: Node,
  opts: PresetOptions = {},
): (req: Request) => Promise<Response> {
  const routes = httpProjection(node, opts.projection)
  const router = makeRouter(routes)
  const withMethods = autoMethodLayer(router, routes)

  if (opts.cors !== undefined && opts.cors !== false) {
    const corsOpts: CorsOptions =
      typeof opts.cors === "boolean" ? {} : opts.cors
    return corsLayer(corsOpts)(withMethods)
  }

  return withMethods
}
