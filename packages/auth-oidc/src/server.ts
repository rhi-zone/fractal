// packages/auth-oidc/src/server.ts — @rhi-zone/fractal-auth-oidc/server
//
// Server-side OIDC adapter: implements `AuthAdapter<OidcClaims>`
// (@rhi-zone/fractal-api-tree/auth) by validating the `Authorization:
// Bearer <jwt>` header against a JWKS. Wire it into any projector's ALS via
// `authLayer`:
//
// ```ts
// import { oidc } from "@rhi-zone/fractal-auth-oidc"
// import { authLayer, authMiddleware } from "@rhi-zone/fractal-api-tree/auth"
//
// const auth = oidc.server({ issuer: "https://auth.example.com", audience: "my-api" })
// createFetch(tree, {
//   als: { storage, init: authLayer(auth) },
//   middleware: [authMiddleware(auth)], // optional: 401 on missing/invalid token
// })
// ```

import type { AuthAdapter } from "@rhi-zone/fractal-api-tree/auth"
import { createJwksCache, resolveJwksUri } from "./jwks.ts"
import type { JwksCache } from "./jwks.ts"
import { checkClaims, isSupportedAlg, parseJwt, verifyJwtSignature } from "./jwt.ts"
import type { JwtClaims } from "./jwt.ts"
import type { FetchLike } from "./jwks.ts"

/** Decoded JWT claims, handed back as `TUser` by `resolve` — every registered claim plus whatever the provider adds. */
export type OidcClaims = JwtClaims

export type OidcServerOptions = {
  /** The provider's issuer URL — used for `.well-known/openid-configuration` discovery (unless `jwksUri` is given) and for `iss` claim validation. */
  readonly issuer?: string
  /** Direct JWKS endpoint URL — skips discovery entirely when given. */
  readonly jwksUri?: string
  /** Expected `aud` claim — a single value or any-of a list. Unchecked when omitted. */
  readonly audience?: string | readonly string[]
  /** Clock skew leeway (seconds) for `exp`/`nbf` comparisons. Default 0. */
  readonly clockToleranceSec?: number
  /** JWKS cache TTL (ms). Default 10 minutes — see `./jwks.ts`. */
  readonly jwksCacheTtlMs?: number
  /** Overrides `fetch` for discovery + JWKS requests. Defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike
  /** Injectable clock for tests. Defaults to `Date.now`. */
  readonly now?: () => number
}

/**
 * Drops keys whose value is `undefined` — `exactOptionalPropertyTypes`
 * distinguishes "key absent" from "key present with value `undefined`", and
 * `OidcServerOptions`'s fields are all optional-when-absent, not optional-
 * when-`undefined`. Building call-site objects field-by-field (rather than
 * spreading `options` directly) would work too, but this keeps each call
 * site a single object literal.
 */
function omitUndefined<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out = {} as Record<string, unknown>
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value
  }
  return out as { [K in keyof T]: Exclude<T[K], undefined> }
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.get("authorization")
  if (header === null) return null
  const [scheme, token] = header.split(" ", 2)
  if (scheme?.toLowerCase() !== "bearer" || token === undefined || token.length === 0) return null
  return token
}

/**
 * Builds an `AuthAdapter<OidcClaims>` that validates Bearer JWTs against
 * `options`'s JWKS. `resolve` never throws — any failure (missing header,
 * malformed token, unsupported alg, bad signature, expired/wrong-issuer/
 * wrong-audience claims, unreachable JWKS endpoint) is treated as
 * "unauthenticated" and resolves to `null`, per `AuthAdapter`'s contract
 * (see `@rhi-zone/fractal-api-tree/auth`).
 */
export function oidcServer(options: OidcServerOptions): AuthAdapter<OidcClaims> {
  const fetchImpl = options.fetchImpl ?? fetch

  // JWKS URI resolution (discovery, when needed) happens at most once —
  // memoized as a promise so concurrent first-requests share it instead of
  // each kicking off their own discovery fetch.
  let jwksUriPromise: Promise<string> | undefined
  let cache: JwksCache | undefined

  async function getCache(): Promise<JwksCache> {
    if (cache !== undefined) return cache
    jwksUriPromise ??= resolveJwksUri(omitUndefined({ issuer: options.issuer, jwksUri: options.jwksUri }), fetchImpl)
    const jwksUri = await jwksUriPromise
    cache = createJwksCache(jwksUri, omitUndefined({ ttlMs: options.jwksCacheTtlMs, fetchImpl }))
    return cache
  }

  async function resolve(req: Request): Promise<OidcClaims | null> {
    const token = extractBearerToken(req)
    if (token === null) return null

    try {
      const parsed = parseJwt(token)
      if (!isSupportedAlg(parsed.header.alg)) return null

      const jwksCache = await getCache()
      const jwk = await jwksCache.getKey(parsed.header.kid)

      const validSignature = await verifyJwtSignature(parsed, jwk)
      if (!validSignature) return null

      checkClaims(parsed.claims, omitUndefined({
        issuer: options.issuer,
        audience: options.audience,
        clockToleranceSec: options.clockToleranceSec,
        now: options.now,
      }))

      return parsed.claims
    } catch {
      return null
    }
  }

  /**
   * Default guard: rejects with `401` when `resolve` produced no user
   * (missing header, invalid/expired token, etc.). Enforced only when this
   * adapter is also wired through `authMiddleware` (see module doc) — using
   * `authLayer` alone (no `authMiddleware`) makes auth informational-only,
   * for routes that want to know WHO is calling without requiring it.
   */
  function guard(_req: Request, user: OidcClaims | null): Response | void {
    if (user === null) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    }
    return undefined
  }

  return { resolve, guard }
}
