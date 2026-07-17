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

// ============================================================================
// Store interface
// ============================================================================

/** A named key-value interface over a single input source. */
export interface Store {
  get(key: string): unknown
}

/** All input stores available for a given request. */
export type Stores = Readonly<Record<string, Store>>

// ============================================================================
// Per-param source override
// ============================================================================

/**
 * Declares where a specific parameter should be read from, overriding the
 * default convention. Used for cases like pulling a param from a header or
 * from a query param on a POST request.
 */
export interface ParamSource {
  readonly store: string
  readonly key?: string // defaults to param name when omitted
}

/**
 * Map of param names to their source overrides. Only params listed here
 * diverge from the convention; all others follow the primary-store rule.
 */
export type SourceMap = Readonly<Record<string, ParamSource>>

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

// ============================================================================
// Assembler
// ============================================================================

/**
 * Build the handler's input bag by reading named params from stores.
 *
 * Resolution order for each param:
 *   1. If the param name matches a path slug → read from "path" store.
 *   2. If the param has an explicit override in `sourceMap` → read from that.
 *   3. Otherwise → read from the primary store (method-derived convention).
 *
 * When `paramNames` is empty (no schema info available), falls back to
 * bulk-collecting all available values from the primary store and path —
 * this preserves backward compat with the old defaultDecode behavior.
 */
export function assemble(
  stores: Stores,
  paramNames: readonly string[],
  sourceMap: SourceMap,
  primaryStore: string,
  pathParamNames: readonly string[],
): Record<string, unknown> {
  const bag: Record<string, unknown> = {}
  for (const name of paramNames) {
    if (pathParamNames.includes(name)) {
      bag[name] = stores.path?.get(name)
    } else if (name in sourceMap) {
      const src = sourceMap[name]!
      bag[name] = stores[src.store]?.get(src.key ?? name)
    } else {
      bag[name] = stores[primaryStore]?.get(name)
    }
  }
  return bag
}

// ============================================================================
// Bulk collect — backward-compat fallback when no param names are known
// ============================================================================

/**
 * Collect all available values from the path and primary source stores,
 * producing the same flat bag that the old `defaultDecode` returned. Used
 * when no schema/paramNames information is available (the common case until
 * codegen-derived param lists are wired in).
 */
export function bulkCollect(
  slugs: Readonly<Record<string, string>>,
  queryParams: URLSearchParams,
  parsedBody: unknown,
  primaryStore: string,
): Record<string, unknown> {
  const bag: Record<string, unknown> = { ...slugs }
  if (primaryStore === "query") {
    for (const [k, v] of queryParams) bag[k] = v
  } else {
    // body is primary — merge body fields, but also merge query params
    // (backward compat: old defaultDecode merged query for all methods)
    for (const [k, v] of queryParams) bag[k] = v
    if (typeof parsedBody === "object" && parsedBody !== null) {
      Object.assign(bag, parsedBody)
    }
  }
  return bag
}
