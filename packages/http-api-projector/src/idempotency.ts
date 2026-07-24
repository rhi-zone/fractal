// packages/http-api-projector/src/idempotency.ts — @rhi-zone/fractal-http-api-projector
//
// Server-side counterpart to `extensions/idempotency.ts`'s client
// `idempotencyKey()`: an `HttpHandlerMiddleware` (route.ts) that de-dupes a
// retried call carrying the same `Idempotency-Key` header — first call runs
// the handler and caches its result; every subsequent call with the same key
// returns the cached result without running the handler again.
//
// Deliberately keyed off the HEADER'S PRESENCE, not `meta.tags.idempotent`
// (api-tree/src/tags.ts's `TAG_IDEMPOTENT`): `HttpHandlerMiddleware` (see
// route.ts's module doc) is `(input, stores) => result` — it never receives
// the matched leaf's `meta`, only the assembled input bag and the raw
// pre-assembly stores (same constraint the client-side extension's module
// doc documents for `wrapFetch`). A request that carries the header is
// asking for de-dupe regardless of whether the operation's own tags say
// `idempotent` — this is the same convention `Idempotency-Key` uses in
// practice (Stripe, and RFC draft-ietf-httpapi-idempotency-key-header): the
// CLIENT opts in per-request, the server's job is to honor the header when
// present, not to gate on a tag it can't see here. An operation that never
// receives the header (a GET, or a client that doesn't send one) behaves
// exactly as if this middleware weren't installed.
//
// See:
//   packages/http-api-projector/src/extensions/idempotency.ts — client half
//   packages/http-api-projector/src/route.ts                  — HttpHandlerMiddleware, Stores

import type { HttpHandlerMiddleware } from "./route.ts"
import type { Stores } from "@rhi-zone/fractal-api-tree"

// ============================================================================
// Store interface — pluggable, matching this package's other extension-point
// shapes (e.g. `ClientExtension`, `HttpErrorEncoder`): a plain structural
// interface, so any backing store (Redis, a database table, ...) can
// implement it without depending on this package.
// ============================================================================

/**
 * Pluggable cache for idempotent replay. `get` returns `undefined` for a
 * cache miss — including, as a documented limitation, when a previously
 * cached value was itself literally `undefined` (a handler that legitimately
 * returns `undefined` is indistinguishable from a miss here; store a
 * sentinel wrapper instead if that distinction matters to a given handler).
 * `ttl` (milliseconds) is advisory: a store that doesn't expire entries
 * (or expires them a different way) may ignore it.
 */
export type IdempotencyStore = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown, ttl?: number): Promise<void>
}

/**
 * Default `IdempotencyStore`: an in-process `Map`, so `idempotencyMiddleware()`
 * works out of the box with no external dependency. NOT suitable across
 * multiple processes/instances (each has its own `Map`) or across restarts
 * (cleared on process exit) — pass a shared store (Redis-backed, a database
 * table, ...) implementing the same `IdempotencyStore` interface for a
 * multi-instance deployment.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, { readonly value: unknown; readonly expiresAt: number | undefined }>()

  async get(key: string): Promise<unknown> {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    const expiresAt = ttl !== undefined ? Date.now() + ttl : undefined
    this.entries.set(key, { value, expiresAt })
  }

  /** Number of entries currently held — test/diagnostic use. */
  get size(): number {
    return this.entries.size
  }
}

// ============================================================================
// Middleware
// ============================================================================

export type IdempotencyMiddlewareOptions = {
  /** Backing store. Default a fresh `InMemoryIdempotencyStore()` (per call to `idempotencyMiddleware()`, not shared globally). */
  readonly store?: IdempotencyStore
  /** Header carrying the key (case-insensitive — `stores.header` is a `Headers` pass-through). Default `"idempotency-key"`. */
  readonly header?: string
  /** TTL (milliseconds) passed to `store.set` for each cached result. Default: none (store's own default, if any). */
  readonly ttl?: number
}

function headerValue(stores: Stores, header: string): string | undefined {
  const value = (stores.header as Record<string, unknown> | undefined)?.[header]
  return typeof value === "string" ? value : undefined
}

/**
 * `HttpHandlerMiddleware` that caches a handler's result per `Idempotency-Key`
 * header value: the first request bearing a given key runs the handler
 * normally and caches its result; every later request bearing the SAME key
 * short-circuits `next` entirely, returning the cached result instead. A
 * request with no key (or an empty store) always runs `next` — this
 * middleware is a pure pass-through until a caller opts in via the header.
 *
 * @example
 * makeRouterFromRoute(route, [idempotencyMiddleware()])
 * // or, sharing one store across multiple middleware/handlers:
 * const store = new InMemoryIdempotencyStore()
 * makeRouterFromRoute(route, [idempotencyMiddleware({ store })])
 */
export function idempotencyMiddleware(options: IdempotencyMiddlewareOptions = {}): HttpHandlerMiddleware {
  const store = options.store ?? new InMemoryIdempotencyStore()
  const header = (options.header ?? "idempotency-key").toLowerCase()
  const ttl = options.ttl

  return (next) => async (input, stores) => {
    const key = headerValue(stores, header)
    if (key === undefined) return next(input, stores)

    const cached = await store.get(key)
    if (cached !== undefined) return cached

    const result = await next(input, stores)
    await store.set(key, result, ttl)
    return result
  }
}
