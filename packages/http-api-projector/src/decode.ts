// packages/http-api-projector/src/decode.ts — @rhi-zone/fractal-http-api-projector
//
// Stores-based input extraction: a request is exposed as named stores —
// uniform key-value interfaces over all input sources (path, query, header,
// body). An assembler reads params from stores based on conventions + optional
// per-param overrides.
//
// See docs/design/routing-and-transforms.md § "Input extraction" (TODO.md
// notes this as an open architecture gap — this is the resolution).
//
// The convention: each HTTP method implies a "primary store" for non-path
// params:
//   GET, HEAD, DELETE → "query" (params come from the URL query string)
//   POST, PUT, PATCH → "body"  (params come from the parsed request body)
//
// Path params (from route slugs) always come from the "path" store,
// determined by matching param names against the routing-resolved slug names.
//
// The Store/Stores/ParamSource/SourceMap types and the `assemble` function
// itself now live in @rhi-zone/fractal-api-tree's input.ts (this file was the
// first well-factored version of that pipeline, since generalized so CLI and
// MCP projectors can share it). Re-exported below for backward compat.

export type { Store, Stores, ParamSource, SourceMap } from "@rhi-zone/fractal-api-tree"
export { assemble } from "@rhi-zone/fractal-api-tree"

import type { Stores } from "@rhi-zone/fractal-api-tree"

// ============================================================================
// HTTP stores factory
// ============================================================================

/**
 * Build the standard HTTP stores from a request, route slugs, and a pre-parsed
 * body. The body is parsed once (upstream) and passed in rather than re-parsed
 * here — this keeps the factory synchronous and allows the caller to handle
 * parse errors.
 */
export function httpStores(
  req: Request,
  slugs: Readonly<Record<string, string>>,
  parsedBody: unknown,
): Stores {
  const url = new URL(req.url)
  return {
    path: { get: (k) => slugs[k] },
    query: { get: (k) => url.searchParams.get(k) ?? undefined },
    header: { get: (k) => req.headers.get(k) ?? undefined },
    body: {
      get: (k) =>
        typeof parsedBody === "object" && parsedBody !== null
          ? (parsedBody as Record<string, unknown>)[k]
          : undefined,
    },
  }
}

// ============================================================================
// Primary store convention
// ============================================================================

/**
 * Returns the default store name for non-path params, based on HTTP method.
 * GET/HEAD/DELETE read from query; POST/PUT/PATCH read from body.
 */
export function primaryStoreForMethod(method: string): string {
  switch (method) {
    case "GET":
    case "HEAD":
    case "DELETE":
      return "query"
    default:
      return "body"
  }
}

