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

// Augment the shared StoreRegistry with HTTP's store names, so `Stores`
// (declaration-merged across all projectors that are loaded) exposes exactly
// these keys here — accessing any other store name is a compile-time error.
declare module "@rhi-zone/fractal-api-tree" {
  interface StoreRegistry {
    path: true
    query: true
    header: true
    body: true
  }
}

// `caller` itself is declared once, in api-tree's input.ts — shared across
// all three projectors (see that file's doc comment on StoreRegistry) —
// rather than re-declared here.

// ============================================================================
// HttpStoreRegistry — the store names `http.source()` (verbs.ts) accepts
// ============================================================================

/**
 * Registry of store names `http.source()` accepts, populated via declaration
 * merging — same mechanism as the shared `StoreRegistry` above, but scoped to
 * HTTP specifically. `StoreRegistry`/`Stores` is shared across every
 * projector (CLI's `flag`/`positional`, MCP's `argument`, ...) once they're
 * all part of the same compilation; `http.source()`'s own `store` field
 * should only accept HTTP's stores, not that whole cross-projector union —
 * this is a NARROWER, HTTP-only registry rather than a re-export of
 * `StoreRegistry`.
 *
 * Extend via:
 * ```ts
 * declare module "@rhi-zone/fractal-http-api-projector/decode" {
 *   interface HttpStoreRegistry { cookie: true }
 * }
 * ```
 *
 * Deliberately an interface (declaration-mergeable), not `string & {}` —
 * the latter widens to accept ANY string literal (TypeScript's usual
 * "nominal-ish primitive" escape hatch), which loses the "only registered
 * stores compile" property this type exists to enforce.
 */
export interface HttpStoreRegistry {
  path: true
  query: true
  header: true
  body: true
  caller: true
}

/** A registered HTTP store name — the key set of `HttpStoreRegistry`, open via merging. */
export type HttpStore = keyof HttpStoreRegistry

// ============================================================================
// Body parsing — Content-Type-driven request body decode
// ============================================================================
//
// `application/json` is the historical, still-default case. The rest
// (multipart, url-encoded, text, binary) are additive: each Content-Type is
// routed to the WHATWG API that already understands it (`req.formData()`,
// `req.text()`, `req.arrayBuffer()`) rather than a hand-rolled parser — Bun
// implements all three natively. No Content-Type (or a body-less request)
// falls through to `undefined`, matching the historical "no body parsed"
// state that `httpStores` already turns into an empty `body` store.

/**
 * Convert a `FormData` (from either `multipart/form-data` or
 * `application/x-www-form-urlencoded`, both parsed via `req.formData()`)
 * into a plain object suitable for the `body` store. A `File` entry is kept
 * as-is (the handler receives the WHATWG `File` object directly — no
 * special-casing needed downstream). Duplicate keys (e.g. multiple files
 * under the same field name) collect into an array rather than the last
 * value silently winning.
 */
function formDataToObject(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of fd.entries()) {
    if (key in out) {
      const existing = out[key]
      if (Array.isArray(existing)) existing.push(value)
      else out[key] = [existing, value]
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * Parse a request body according to its Content-Type, once, up front —
 * mirrors the `req.json()` call this replaces. Conventional keys `_text`/
 * `_binary` hold whole-body values (text/plain, application/octet-stream)
 * that don't naturally decompose into named fields the way form data does;
 * a handler pulls them via `sourceMap: { text: { store: "body", key: "_text" } }`
 * the same way it would any other body field. Returns `undefined` when the
 * Content-Type is absent or unrecognized — `httpStores` already treats a
 * non-object `parsedBody` as an empty `body` store, so this doesn't need its
 * own empty-object fallback.
 */
export async function parseRequestBody(req: Request): Promise<unknown> {
  const ct = req.headers.get("Content-Type") ?? ""
  if (ct.includes("application/json")) {
    return await req.json()
  }
  if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
    return formDataToObject(await req.formData())
  }
  if (ct.includes("text/plain")) {
    return { _text: await req.text() }
  }
  if (ct.includes("application/octet-stream")) {
    return { _binary: await req.arrayBuffer() }
  }
  return undefined
}

// ============================================================================
// HTTP stores factory
// ============================================================================

/**
 * Shared Proxy handler for method-backed sources (`URLSearchParams`,
 * `Headers`) — makes plain property access (`store[key]`) delegate to the
 * source's own `.get(key)` method. Module-level constant: allocated once,
 * reused across every request's Proxy rather than rebuilt per-call. Symbol
 * properties (e.g. `Symbol.toPrimitive`, `Symbol.iterator`) are NOT
 * delegated to `.get()` — a symbol is never a valid map key, so this
 * returns `undefined` for them rather than coercing to a string.
 */
const mapLikeHandler: ProxyHandler<{ get(key: string): unknown }> = {
  get: (target, prop) => (typeof prop === "string" ? target.get(prop) ?? undefined : undefined),
}

/**
 * Build the standard HTTP stores from a request, route slugs, and a pre-parsed
 * body. The body is parsed once (upstream) and passed in rather than re-parsed
 * here — this keeps the factory synchronous and allows the caller to handle
 * parse errors.
 *
 * `path`/`body`/`caller` are plain objects — direct property access, no
 * wrapping needed. `query`/`header` wrap method-backed sources
 * (`URLSearchParams`/`Headers`) in a Proxy (via the shared `mapLikeHandler`
 * above) so `stores.query.x` reads the same as `stores.query.get("x")` would
 * have — but only on first access: each is a lazy, self-memoizing getter
 * (`Object.defineProperty` swaps the getter for the constructed Proxy after
 * first read), so a request that never touches `query`/`header` never pays
 * for constructing them.
 *
 * `caller` is populated from raw request headers — `caller.authorization`
 * returns the `Authorization` header value, `caller.cookie` the `Cookie`
 * header value, and so on for any other auth-related header a consumer names.
 * This store is deliberately a thin pass-through over headers (same underlying
 * source as the `header` store): PARSING what's inside (decoding a JWT,
 * splitting a cookie string into individual cookies, ...) is the consumer's
 * job, not this factory's — see docs/design/middleware-and-caller-context.md.
 */
export function httpStores(
  req: Request,
  slugs: Readonly<Record<string, string>>,
  parsedBody: unknown,
): Stores {
  const caller: Record<string, unknown> = {}
  for (const [key, value] of req.headers.entries()) {
    caller[key] = value
  }
  return {
    path: slugs,
    body: (typeof parsedBody === "object" && parsedBody !== null)
      ? (parsedBody as Record<string, unknown>)
      : {},
    caller,
    get query(): Record<string, unknown> {
      const proxy = new Proxy(new URL(req.url).searchParams, mapLikeHandler) as unknown as Record<string, unknown>
      Object.defineProperty(this, "query", { value: proxy, configurable: false })
      return proxy
    },
    get header(): Record<string, unknown> {
      const proxy = new Proxy(req.headers, mapLikeHandler) as unknown as Record<string, unknown>
      Object.defineProperty(this, "header", { value: proxy, configurable: false })
      return proxy
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

