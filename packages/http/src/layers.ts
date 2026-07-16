// packages/http/src/layers.ts — @rhi-zone/fractal-http
//
// Composable HTTP layers that wrap a core fetch handler.
// Each layer is independently droppable — the core router works without them.
//
// Layers:
//   autoMethodLayer  — HEAD-from-GET, OPTIONS→204+Allow, 405+Allow on wrong method
//   corsLayer        — minimal CORS / preflight, opt-in

import { allowHeader } from "./project.ts"
import { routeCandidatesForUrl } from "./route.ts"
import type { HttpRoute } from "./route.ts"

type Fetch = (req: Request) => Promise<Response>

// ============================================================================
// autoMethodLayer
//
// Adds HTTP-correctness behaviors that are absent from the core router:
//   - Auto-HEAD-from-GET: HEAD served from the GET handler, body stripped
//   - OPTIONS → 204 + Allow header listing all verbs for the path
//   - Wrong method on a known path → 405 + Allow (not 404)
//
// Droppability proof: the core router returns 404 for HEAD, OPTIONS, and
// wrong-method requests (no exact match). This layer is the only source of
// the HTTP-correct 200/204/405 responses for those cases.
// ============================================================================

/**
 * Wrap a core fetch handler with HTTP-correctness behaviors.
 *
 * @param inner - The core router produced by `makeRouter`.
 * @param root  - The same `HttpRoute` tree passed to `makeRouter` —
 *                re-walked (guided by the request path, O(depth)) to
 *                determine the methods available at this exact path.
 */
export function autoMethodLayer(inner: Fetch, root: HttpRoute): Fetch {
  return async (req) => {
    // Find all candidates whose path matches (ignoring method)
    const pathMatches = routeCandidatesForUrl(root, req.url)

    // No path match at all — let the inner handler return 404
    if (pathMatches.length === 0) return inner(req)

    const verbs = new Set(pathMatches.map((r) => r.method))

    // OPTIONS: 204 + Allow (HEAD and OPTIONS are always implied)
    if (req.method === "OPTIONS") {
      const all = new Set(verbs)
      all.add("OPTIONS")
      if (verbs.has("GET")) all.add("HEAD")
      return new Response(null, {
        status: 204,
        headers: { Allow: allowHeader(all) },
      })
    }

    // HEAD: derive from GET handler, strip body
    if (req.method === "HEAD" && verbs.has("GET")) {
      const getReq = new Request(req, { method: "GET" })
      const res = await inner(getReq)
      return new Response(null, {
        status: res.status,
        statusText: res.statusText,
        headers: new Headers(res.headers),
      })
    }

    // Exact verb present — delegate to inner
    if (verbs.has(req.method)) return inner(req)

    // Path exists but verb not registered → 405 + Allow
    const all = new Set(verbs)
    all.add("OPTIONS")
    if (verbs.has("GET")) all.add("HEAD")
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: allowHeader(all) },
    })
  }
}

// ============================================================================
// corsLayer
//
// Minimal CORS support. Opt-in — off by default in the preset.
// Wraps any Fetch handler; fully composable and droppable.
//
// Handles:
//   - CORS preflight (OPTIONS + Access-Control-Request-Method header)
//   - Access-Control-Allow-Origin on all non-preflight responses
// ============================================================================

export type CorsOptions = {
  /**
   * Allowed origins. `"*"` (default) permits any origin.
   * Pass a string or array of strings for explicit origin allowlisting.
   */
  readonly origin?: string | readonly string[]
  /** Include `Access-Control-Allow-Credentials: true`. Default false. */
  readonly credentials?: boolean
  /** `Access-Control-Max-Age` for preflight cache. Default 86400 (1 day). */
  readonly maxAge?: number
}

/**
 * CORS layer factory. Returns a function that wraps an inner handler.
 *
 * @example
 * const handler = corsLayer({ origin: "https://app.example.com" })(innerFetch)
 */
export function corsLayer(opts: CorsOptions = {}): (inner: Fetch) => Fetch {
  const rawOrigins = opts.origin
  const origins: readonly string[] =
    rawOrigins === undefined
      ? ["*"]
      : typeof rawOrigins === "string"
        ? [rawOrigins]
        : rawOrigins

  const resolveOrigin = (reqOrigin: string | null): string => {
    if (origins.includes("*")) return "*"
    if (reqOrigin !== null && origins.includes(reqOrigin)) return reqOrigin
    return ""
  }

  return (inner) => async (req) => {
    const reqOrigin = req.headers.get("Origin")
    const allowedOrigin = resolveOrigin(reqOrigin)

    // CORS preflight: OPTIONS with Access-Control-Request-Method
    if (
      req.method === "OPTIONS" &&
      req.headers.has("Access-Control-Request-Method")
    ) {
      const headers: Record<string, string> = {
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
        "Access-Control-Allow-Headers":
          req.headers.get("Access-Control-Request-Headers") ?? "Content-Type",
        "Access-Control-Max-Age": String(opts.maxAge ?? 86400),
      }
      if (allowedOrigin.length > 0) {
        headers["Access-Control-Allow-Origin"] = allowedOrigin
        if (opts.credentials === true) {
          headers["Access-Control-Allow-Credentials"] = "true"
        }
      }
      return new Response(null, { status: 204, headers })
    }

    const res = await inner(req)

    // No matching origin — return response without CORS headers
    if (allowedOrigin.length === 0) return res

    const out = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: new Headers(res.headers),
    })
    out.headers.set("Access-Control-Allow-Origin", allowedOrigin)
    if (opts.credentials === true) {
      out.headers.set("Access-Control-Allow-Credentials", "true")
    }
    return out
  }
}
