// packages/auth-oidc/src/index.ts — @rhi-zone/fractal-auth-oidc
//
// Generic OIDC/JWT auth adapter for fractal — a provider package
// implementing the contract in `@rhi-zone/fractal-api-tree/auth`
// (`AuthAdapter`/`AuthClientAdapter`) against any OIDC-compliant issuer.
// See `./server.ts` and `./client.ts` for the full docs of each half.
//
// ```ts
// import { oidc } from "@rhi-zone/fractal-auth-oidc"
//
// const auth = oidc.server({ issuer: "https://auth.example.com", audience: "my-api" })
// const clientAuth = oidc.client({ tokenEndpoint, clientId: "my-client", clientSecret: "secret" })
// ```

import { oidcClient } from "./client.ts"
import { oidcServer } from "./server.ts"

/** `oidc.server(...)` / `oidc.client(...)` — see `./server.ts` / `./client.ts`. */
export const oidc = {
  server: oidcServer,
  client: oidcClient,
}

export { oidcServer, oidcClient }
export type { OidcClaims, OidcServerOptions } from "./server.ts"
export type { OidcClientOptions } from "./client.ts"
export type { FetchLike, Jwk, Jwks, JwksCache } from "./jwks.ts"
export { createJwksCache, resolveJwksUri, JwksFetchError } from "./jwks.ts"
export type { ClaimCheckOptions, JwtClaims, JwtHeader, ParsedJwt } from "./jwt.ts"
export { checkClaims, isSupportedAlg, JwtClaimError, JwtParseError, parseJwt, verifyJwt, verifyJwtSignature } from "./jwt.ts"
