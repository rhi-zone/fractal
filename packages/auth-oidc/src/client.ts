// packages/auth-oidc/src/client.ts — @rhi-zone/fractal-auth-oidc/client
//
// Client-side OIDC adapter: implements `AuthClientAdapter`
// (@rhi-zone/fractal-api-tree/auth) via the OAuth2 `client_credentials`
// grant (server-to-server; a `clientSecret` is required) — the grant an
// unattended fractal client (a backend service calling another fractal
// service) uses. An interactive user-delegated grant (authorization code +
// PKCE) is a DIFFERENT flow with a browser redirect in the middle; it isn't
// in scope here — this adapter is for machine-to-machine calls.
//
// ```ts
// import { oidc } from "@rhi-zone/fractal-auth-oidc"
// import { authExtension } from "@rhi-zone/fractal-api-tree/auth"
//
// const clientAuth = oidc.client({
//   tokenEndpoint: "https://auth.example.com/oauth/token",
//   clientId: "my-client",
//   clientSecret: "secret",
// })
// createClient(node, { baseUrl, extensions: [authExtension(clientAuth)] })
// ```

import type { AuthClientAdapter } from "@rhi-zone/fractal-api-tree/auth"
import type { FetchLike } from "./jwks.ts"

export type OidcClientOptions = {
  /** The provider's OAuth2 token endpoint. */
  readonly tokenEndpoint: string
  readonly clientId: string
  /** Required for the `client_credentials` grant — a confidential (server-to-server) client. */
  readonly clientSecret: string
  /** Space-separated OAuth scopes to request, if the provider needs one. */
  readonly scope?: string
  /** `audience` parameter some providers (e.g. Auth0) require to scope the token to a specific API. */
  readonly audience?: string
  /**
   * Refresh this many seconds BEFORE the token's actual expiry, so a
   * request already in flight doesn't race a just-expired token. Default
   * 30.
   */
  readonly refreshSkewSec?: number
  /** Overrides `fetch` for the token-endpoint request. Defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike
  /** Injectable clock for tests. Defaults to `Date.now`. */
  readonly now?: () => number
}

export class OidcTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OidcTokenError"
  }
}

type TokenState = {
  readonly accessToken: string
  readonly expiresAt: number // epoch ms
}

type TokenResponse = {
  readonly access_token: string
  readonly expires_in?: number
}

/**
 * Builds an `AuthClientAdapter` backed by the OAuth2 `client_credentials`
 * grant. `getToken` fetches a fresh token on first call, then serves the
 * cached token until it's within `refreshSkewSec` of expiry, at which point
 * the NEXT `getToken` call re-fetches. Concurrent `getToken` calls during a
 * fetch share the same in-flight request (no duplicate token-endpoint
 * hits). `onUnauthorized` drops the cached token and fetches a new one
 * unconditionally — the provider's own signal that the current token no
 * longer works, regardless of what our local clock thinks about its
 * expiry.
 */
export function oidcClient(options: OidcClientOptions): AuthClientAdapter {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const skewMs = (options.refreshSkewSec ?? 30) * 1000

  let state: TokenState | undefined
  let inflight: Promise<string | null> | undefined

  async function requestToken(): Promise<string | null> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: options.clientId,
      client_secret: options.clientSecret,
    })
    if (options.scope !== undefined) body.set("scope", options.scope)
    if (options.audience !== undefined) body.set("audience", options.audience)

    const res = await fetchImpl(options.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    })
    if (!res.ok) {
      state = undefined
      return null
    }
    const json = (await res.json()) as TokenResponse
    if (typeof json.access_token !== "string") {
      throw new OidcTokenError("token endpoint response missing \"access_token\"")
    }
    const expiresInMs = (json.expires_in ?? 300) * 1000
    state = { accessToken: json.access_token, expiresAt: now() + expiresInMs }
    return state.accessToken
  }

  function isFresh(s: TokenState): boolean {
    return now() < s.expiresAt - skewMs
  }

  async function getToken(): Promise<string | null> {
    if (state !== undefined && isFresh(state)) return state.accessToken
    inflight ??= requestToken().finally(() => {
      inflight = undefined
    })
    return inflight
  }

  async function onUnauthorized(): Promise<boolean> {
    state = undefined
    const token = await getToken()
    return token !== null
  }

  return { getToken, onUnauthorized }
}
