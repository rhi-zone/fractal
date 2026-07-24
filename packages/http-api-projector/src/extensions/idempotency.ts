// packages/http-api-projector/src/extensions/idempotency.ts — @rhi-zone/fractal-http-api-projector
//
// Built-in `ClientExtension`: attaches an `Idempotency-Key` header to
// mutating requests, so a retried/duplicated call (a network blip, `retry()`
// re-sending the same attempt, a doubled click) is safe to de-dupe server-
// side against `packages/http-api-projector/src/idempotency.ts`'s
// `idempotencyMiddleware()`/`IdempotencyStore`.
//
// Scope note: this extension operates on the transport-level `Request`
// (`wrapFetch`) / `fetch(url, init)` call (`codegen.wrap`) — same
// constraint `retry()`/`timeout()` already live under (see extension.ts's
// module doc: `wrapFetch` never sees the leaf's `meta`, only the composed
// client's shared fetch impl gets built once for every operation). It
// cannot consult `meta.tags.idempotent` (api-tree/src/tags.ts's
// `TAG_IDEMPOTENT`) per-request the way `decodeResponse` can via
// `DecodeContext.meta` — that hook only runs AFTER the request is already
// sent. Instead it uses the HTTP method as the idempotency proxy, which is
// exactly what `http-api-projector/src/tags.ts`'s `verbFromTags` already
// encodes at verb-selection time: `readOnly`/`idempotent` operations land on
// GET/PUT/DELETE (naturally idempotent per RFC 9110, no key needed), while
// operations whose idempotency is unknown or false land on POST (the
// conservative default) — POST is also where a genuinely-idempotent
// operation that was force-routed there via a `meta.http` verb override
// benefits most from a key. Default `methods` therefore targets every
// non-safe verb (POST/PUT/PATCH/DELETE), not just POST — cheap insurance on
// PUT/DELETE, since a caller-supplied key (see below) is a no-op to skip.
//
// A caller that already set the header itself — directly on a `Request` it
// builds, or via an earlier extension (e.g. `interceptors({ onRequest })`
// listed BEFORE this one in `extensions`) — is respected: this extension
// only fills in a key when the header is absent, never overwrites one.
//
// Ordering with `retry()`: list this extension OUTSIDE `retry()` (e.g.
// `extensions: [idempotencyKey(), retry()]`) so ONE key is generated per
// logical call and `retry()`'s repeated `inner(req.clone())` attempts all
// carry the same key — the point of an idempotency key is that every retry
// of the SAME logical request reuses it. Listed the other way around,
// `retry()` would call this extension's `wrapFetch` fresh on each attempt,
// minting a new key per attempt (defeats the purpose).

import type { ClientExtension, FetchImpl } from "../extension.ts"

const DEFAULT_HEADER = "Idempotency-Key"
const DEFAULT_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const

export type IdempotencyKeyOptions = {
  /** Header name to carry the key. Default `"Idempotency-Key"`. */
  readonly header?: string
  /**
   * HTTP methods (case-insensitive) to attach a key to. Default
   * `["POST", "PUT", "PATCH", "DELETE"]` — every mutating verb (see module
   * doc for why PUT/DELETE are included alongside POST). GET/HEAD requests
   * are never keyed — safe to retry with no side effect to de-dupe.
   */
  readonly methods?: readonly string[]
  /**
   * Key generator, called once per request that needs one. Default
   * `() => crypto.randomUUID()`. Runtime-only — codegen always uses
   * `crypto.randomUUID()` (a function value has no textual representation
   * to embed, same limitation `retry()`'s `retryOn` documents).
   */
  readonly generateKey?: () => string
}

/**
 * Idempotency-key extension: attaches an `Idempotency-Key` header to
 * mutating requests that don't already carry one (see module doc).
 *
 * @example
 * createClient(node, { baseUrl, extensions: [idempotencyKey(), retry()] })
 */
export function idempotencyKey(options: IdempotencyKeyOptions = {}): ClientExtension {
  const header = options.header ?? DEFAULT_HEADER
  const methods = new Set((options.methods ?? DEFAULT_METHODS).map((m) => m.toUpperCase()))
  const generateKey = options.generateKey ?? (() => crypto.randomUUID())

  const wrapFetch = (inner: FetchImpl): FetchImpl => async (req: Request): Promise<Response> => {
    if (!methods.has(req.method.toUpperCase()) || req.headers.has(header)) return inner(req)
    const headers = new Headers(req.headers)
    headers.set(header, generateKey())
    return inner(new Request(req, { headers }))
  }

  return {
    name: "idempotencyKey",
    wrapFetch,
    codegen: {
      helpers: IDEMPOTENCY_CODEGEN_HELPERS,
      wrap: (innerExpr) =>
        `__withIdempotencyKey(${innerExpr}, ${JSON.stringify({ header, methods: [...methods] })})`,
    },
  }
}

// ============================================================================
// Codegen helper source — mirrors `wrapFetch` above but against the platform
// `fetch(url, init)` shape (see codegen.ts's `__request`).
// ============================================================================

const IDEMPOTENCY_CODEGEN_HELPERS = `
type __IdempotencyKeyOptions = { header: string; methods: string[] }

function __withIdempotencyKey(inner: typeof fetch, options: __IdempotencyKeyOptions): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase()
    if (!options.methods.includes(method)) return inner(url, init)
    const headers = new Headers(init?.headers)
    if (headers.has(options.header)) return inner(url, init)
    headers.set(options.header, crypto.randomUUID())
    return inner(url, { ...init, headers })
  }) as typeof fetch
}`.trim()
