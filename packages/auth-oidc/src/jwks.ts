// packages/auth-oidc/src/jwks.ts — @rhi-zone/fractal-auth-oidc/jwks
//
// JWKS discovery + caching. An OIDC provider publishes its signing keys at
// a JWKS endpoint (RFC 7517) — either given directly (`jwksUri`) or
// discovered from the provider's `.well-known/openid-configuration` document
// (`issuer` + `/.well-known/openid-configuration`, whose `jwks_uri` field
// points at the real JWKS). Both the discovery document and the JWKS
// itself are cached: discovery essentially never changes for a given
// issuer, so it's fetched at most once per adapter instance; the JWKS is
// cached with a configurable TTL and force-refreshed once on an unknown
// `kid` (the standard key-rotation recovery: a provider that just rotated
// keys may hand out a `kid` the cache hasn't seen yet).

import type { Jwk, Jwks } from "./jwt.ts"

export type { Jwk, Jwks } from "./jwt.ts"

/**
 * The minimal `fetch`-shaped signature every `fetchImpl` override in this
 * package accepts — deliberately NOT `typeof fetch` (Bun's global `fetch`
 * type additionally requires a `preconnect` static property, which a plain
 * test double / mock function doesn't have and has no reason to implement).
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const DEFAULT_TTL_MS = 10 * 60 * 1000 // 10 minutes

export class JwksFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JwksFetchError"
  }
}

/**
 * Resolves the JWKS URI: `jwksUri` if given directly, otherwise fetched
 * from `${issuer}/.well-known/openid-configuration`'s `jwks_uri` field.
 * `fetchImpl` defaults to the global `fetch` — overridable for tests.
 */
export async function resolveJwksUri(
  options: { readonly issuer?: string; readonly jwksUri?: string },
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  if (options.jwksUri !== undefined) return options.jwksUri
  if (options.issuer === undefined) {
    throw new JwksFetchError("neither \"jwksUri\" nor \"issuer\" was provided")
  }
  const discoveryUrl = `${options.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`
  const res = await fetchImpl(discoveryUrl)
  if (!res.ok) throw new JwksFetchError(`discovery document fetch failed: ${res.status} ${res.statusText}`)
  const doc = (await res.json()) as { jwks_uri?: string }
  if (typeof doc.jwks_uri !== "string") throw new JwksFetchError("discovery document missing \"jwks_uri\"")
  return doc.jwks_uri
}

export type JwksCache = {
  /** Fetches the JWKS, serving from cache unless `forceRefresh` or the TTL has elapsed. */
  readonly getJwks: (forceRefresh?: boolean) => Promise<Jwks>
  /**
   * Finds the key matching `kid` (or the sole key, when the JWKS has
   * exactly one and `kid` is `undefined` — a common minimal-provider setup).
   * On a cache miss with a defined `kid`, force-refreshes once before
   * giving up (key-rotation recovery — see module doc). Throws
   * `JwksFetchError` when no matching key is found even after refresh.
   */
  readonly getKey: (kid: string | undefined) => Promise<Jwk>
}

/**
 * Builds a cache around one JWKS endpoint. Concurrent callers during a
 * cache miss share the SAME in-flight fetch (no duplicate requests) —
 * `inflight` is cleared once that fetch settles, success or failure.
 */
export function createJwksCache(
  jwksUri: string,
  options: { readonly ttlMs?: number; readonly fetchImpl?: FetchLike } = {},
): JwksCache {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const fetchImpl = options.fetchImpl ?? fetch

  let cached: { readonly jwks: Jwks; readonly fetchedAt: number } | undefined
  let inflight: Promise<Jwks> | undefined

  async function doFetch(): Promise<Jwks> {
    const res = await fetchImpl(jwksUri)
    if (!res.ok) throw new JwksFetchError(`JWKS fetch failed: ${res.status} ${res.statusText}`)
    const jwks = (await res.json()) as Jwks
    if (!Array.isArray(jwks.keys)) throw new JwksFetchError("JWKS response missing \"keys\" array")
    return jwks
  }

  async function getJwks(forceRefresh = false): Promise<Jwks> {
    if (!forceRefresh && cached !== undefined && Date.now() - cached.fetchedAt < ttlMs) {
      return cached.jwks
    }
    if (inflight !== undefined) return inflight
    inflight = doFetch()
      .then((jwks) => {
        cached = { jwks, fetchedAt: Date.now() }
        return jwks
      })
      .finally(() => {
        inflight = undefined
      })
    return inflight
  }

  function findKey(jwks: Jwks, kid: string | undefined): Jwk | undefined {
    if (kid === undefined) return jwks.keys.length === 1 ? jwks.keys[0] : undefined
    return jwks.keys.find((k) => k.kid === kid)
  }

  async function getKey(kid: string | undefined): Promise<Jwk> {
    const jwks = await getJwks()
    const key = findKey(jwks, kid)
    if (key !== undefined) return key

    // Unknown kid (or ambiguous no-kid lookup against a multi-key set) —
    // force one refresh in case the provider just rotated keys, then give up.
    const refreshed = await getJwks(true)
    const retried = findKey(refreshed, kid)
    if (retried !== undefined) return retried
    throw new JwksFetchError(`no JWKS key found for kid "${String(kid)}"`)
  }

  return { getJwks, getKey }
}
