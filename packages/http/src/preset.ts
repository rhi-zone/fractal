// packages/http/src/preset.ts — @rhi-zone/fractal-http
//
// OOTB preset: composes the full HTTP stack into a ready-to-use fetch handler.
//
// Included layers (in order, each independently droppable):
//   1. makeRouter       — direct tree-walk dispatcher (verb+path only, O(depth))
//   2. autoMethodLayer  — HEAD-from-GET, OPTIONS→204+Allow, 405+Allow
//
// Optional (opt-in, off by default):
//   3. corsLayer        — CORS preflight + origin headers
//
// To drop the auto-method layer and use core routing only:
//   return makeRouter(node)
//
// To compose manually with CORS:
//   const router  = makeRouter(node)
//   const methods = autoMethodLayer(router, node)
//   return corsLayer({ origin: "https://app.example.com" })(methods)

import type { Node } from "@rhi-zone/fractal-core/node"
import { makeRouter } from "./project.ts"
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
  const router = makeRouter(node)
  const withMethods = autoMethodLayer(router, node)

  if (opts.cors !== undefined && opts.cors !== false) {
    const corsOpts: CorsOptions =
      typeof opts.cors === "boolean" ? {} : opts.cors
    return corsLayer(corsOpts)(withMethods)
  }

  return withMethods
}
