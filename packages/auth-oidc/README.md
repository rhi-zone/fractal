# @rhi-zone/fractal-auth-oidc

Generic OIDC/JWT auth adapter for fractal.

## What it does

Implements the `AuthAdapter`/`AuthClientAdapter` contract from
`@rhi-zone/fractal-api-tree/auth` against any OIDC-compliant issuer, entirely
on Web Crypto (`crypto.subtle`) — no JWT library dependency. The server half
(`oidcServer`) validates a request's `Authorization: Bearer <jwt>` header
against a JWKS (resolved directly via `jwksUri` or discovered from the
issuer's `.well-known/openid-configuration`, cached with TTL + key-rotation
recovery), checking signature (RS/PS/ES 256/384/512 — HS* is intentionally
unsupported, since a JWKS publishes public keys only) and standard claims
(`exp`, `nbf`, `iss`, `aud`). `resolve` never throws — any failure resolves
to `null` ("unauthenticated"), per the adapter contract. The client half
(`oidcClient`) manages the OAuth2 `client_credentials` grant for
server-to-server calls: fetches and caches an access token, refreshes it
ahead of expiry, and re-fetches on `onUnauthorized`.

## Key exports

- `oidc.server(options)` / `oidcServer(options)` — builds an `AuthAdapter<OidcClaims>` from `./server.ts`
- `oidc.client(options)` / `oidcClient(options)` — builds an `AuthClientAdapter` from `./client.ts`
- `./jwt` — `parseJwt`, `verifyJwt`, `verifyJwtSignature`, `checkClaims`, `isSupportedAlg`, `JwtParseError`, `JwtClaimError`
- `./jwks` — `createJwksCache`, `resolveJwksUri`, `JwksFetchError`
- `OidcClaims`, `OidcServerOptions`, `OidcClientOptions` — option/result types for the two adapters

## Usage

```ts
import { oidc } from "@rhi-zone/fractal-auth-oidc";
import { authLayer, authMiddleware, authExtension } from "@rhi-zone/fractal-api-tree/auth";
import { createFetch } from "@rhi-zone/fractal-http-api-projector/presets";

// Server: validate incoming Bearer tokens against the issuer's JWKS
const auth = oidc.server({ issuer: "https://auth.example.com", audience: "my-api" });
const fetch = createFetch(tree, {
  als: { storage, init: authLayer(auth) },
  middleware: [authMiddleware(auth)], // optional: 401 on missing/invalid token
});

// Client: acquire and refresh tokens for calling another fractal service
const clientAuth = oidc.client({
  tokenEndpoint: "https://auth.example.com/oauth/token",
  clientId: "my-client",
  clientSecret: "secret",
});
createClient(node, { baseUrl, extensions: [authExtension(clientAuth)] });
```

## Install

```bash
bun add @rhi-zone/fractal-auth-oidc
```

See the [root README](../../README.md) for the full picture across all projections.
