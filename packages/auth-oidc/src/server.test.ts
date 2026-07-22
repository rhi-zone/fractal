// packages/auth-oidc/src/server.test.ts — oidcServer (./server.ts)
//
// Exercises the full server-side pipeline end to end: sign a JWT with a
// freshly generated keypair (test-helpers.ts), serve its public JWK from a
// mocked JWKS endpoint, and verify `oidcServer(...).resolve` accepts a
// valid token and rejects every invalid variant (bad signature, expired,
// wrong issuer/audience, missing/malformed header) with `null` — never a
// thrown error, per `AuthAdapter`'s contract.

import { describe, expect, it } from "bun:test"
import { authLayer, authMiddleware } from "@rhi-zone/fractal-api-tree/auth"
import { oidcServer } from "./server.ts"
import { makeSignedJwt } from "./test-helpers.ts"
import type { FetchLike, Jwks } from "./jwks.ts"

function jwksFetchImpl(jwks: Jwks): FetchLike {
  return async () => new Response(JSON.stringify(jwks), { status: 200 })
}

const ISSUER = "https://auth.example.com"
const AUDIENCE = "my-api"

async function makeValidToken(overrides: Record<string, unknown> = {}): Promise<{ token: string; jwks: Jwks }> {
  const { token, publicJwk } = await makeSignedJwt({
    sub: "user-1",
    iss: ISSUER,
    aud: AUDIENCE,
    exp: Date.now() / 1000 + 3600,
    ...overrides,
  })
  return { token, jwks: { keys: [publicJwk] } }
}

describe("oidcServer", () => {
  it("resolves claims for a valid Bearer token", async () => {
    const { token, jwks } = await makeValidToken()
    const auth = oidcServer({ issuer: ISSUER, audience: AUDIENCE, jwksUri: "https://auth.example.com/jwks.json", fetchImpl: jwksFetchImpl(jwks) })

    const user = await auth.resolve(new Request("http://localhost/", { headers: { Authorization: `Bearer ${token}` } }))
    expect(user?.sub).toBe("user-1")
  })

  it("resolves null when there's no Authorization header", async () => {
    const auth = oidcServer({ issuer: ISSUER, jwksUri: "https://x/jwks.json", fetchImpl: jwksFetchImpl({ keys: [] }) })
    const user = await auth.resolve(new Request("http://localhost/"))
    expect(user).toBeNull()
  })

  it("resolves null for a non-Bearer scheme", async () => {
    const auth = oidcServer({ issuer: ISSUER, jwksUri: "https://x/jwks.json", fetchImpl: jwksFetchImpl({ keys: [] }) })
    const user = await auth.resolve(new Request("http://localhost/", { headers: { Authorization: "Basic abc123" } }))
    expect(user).toBeNull()
  })

  it("resolves null for a malformed token", async () => {
    const auth = oidcServer({ issuer: ISSUER, jwksUri: "https://x/jwks.json", fetchImpl: jwksFetchImpl({ keys: [] }) })
    const user = await auth.resolve(new Request("http://localhost/", { headers: { Authorization: "Bearer not-a-jwt" } }))
    expect(user).toBeNull()
  })

  it("resolves null when the token is expired", async () => {
    const { token, jwks } = await makeValidToken({ exp: Date.now() / 1000 - 60 })
    const auth = oidcServer({ issuer: ISSUER, audience: AUDIENCE, jwksUri: "https://x/jwks.json", fetchImpl: jwksFetchImpl(jwks) })
    const user = await auth.resolve(new Request("http://localhost/", { headers: { Authorization: `Bearer ${token}` } }))
    expect(user).toBeNull()
  })

  it("resolves null on issuer mismatch", async () => {
    const { token, jwks } = await makeValidToken({ iss: "https://evil.example.com" })
    const auth = oidcServer({ issuer: ISSUER, audience: AUDIENCE, jwksUri: "https://x/jwks.json", fetchImpl: jwksFetchImpl(jwks) })
    const user = await auth.resolve(new Request("http://localhost/", { headers: { Authorization: `Bearer ${token}` } }))
    expect(user).toBeNull()
  })

  it("resolves null on audience mismatch", async () => {
    const { token, jwks } = await makeValidToken({ aud: "other-api" })
    const auth = oidcServer({ issuer: ISSUER, audience: AUDIENCE, jwksUri: "https://x/jwks.json", fetchImpl: jwksFetchImpl(jwks) })
    const user = await auth.resolve(new Request("http://localhost/", { headers: { Authorization: `Bearer ${token}` } }))
    expect(user).toBeNull()
  })

  it("resolves null when the signature doesn't match the served JWKS key (wrong key)", async () => {
    const { token } = await makeValidToken()
    const { publicJwk: unrelatedKey } = await makeSignedJwt({ sub: "user-2", exp: Date.now() / 1000 + 3600 })
    const auth = oidcServer({ issuer: ISSUER, audience: AUDIENCE, jwksUri: "https://x/jwks.json", fetchImpl: jwksFetchImpl({ keys: [unrelatedKey] }) })
    const user = await auth.resolve(new Request("http://localhost/", { headers: { Authorization: `Bearer ${token}` } }))
    expect(user).toBeNull()
  })

  it("resolves null when the JWKS endpoint is unreachable", async () => {
    const { token } = await makeValidToken()
    const failingFetch: FetchLike = async () => new Response("boom", { status: 500 })
    const auth = oidcServer({ issuer: ISSUER, audience: AUDIENCE, jwksUri: "https://x/jwks.json", fetchImpl: failingFetch })
    const user = await auth.resolve(new Request("http://localhost/", { headers: { Authorization: `Bearer ${token}` } }))
    expect(user).toBeNull()
  })

  it("discovers the JWKS URI from issuer's well-known document when jwksUri is omitted", async () => {
    const { token, jwks } = await makeValidToken()
    const seenUrls: string[] = []
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input)
      seenUrls.push(url)
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(JSON.stringify({ jwks_uri: `${ISSUER}/jwks.json` }), { status: 200 })
      }
      return new Response(JSON.stringify(jwks), { status: 200 })
    }
    const auth = oidcServer({ issuer: ISSUER, audience: AUDIENCE, fetchImpl })
    const user = await auth.resolve(new Request("http://localhost/", { headers: { Authorization: `Bearer ${token}` } }))
    expect(user?.sub).toBe("user-1")
    expect(seenUrls).toContain(`${ISSUER}/.well-known/openid-configuration`)
  })

  it("caches the JWKS across multiple resolve calls (single fetch)", async () => {
    const { token, jwks } = await makeValidToken()
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      return new Response(JSON.stringify(jwks), { status: 200 })
    }
    const auth = oidcServer({ issuer: ISSUER, audience: AUDIENCE, jwksUri: "https://x/jwks.json", fetchImpl })
    await auth.resolve(new Request("http://localhost/", { headers: { Authorization: `Bearer ${token}` } }))
    await auth.resolve(new Request("http://localhost/", { headers: { Authorization: `Bearer ${token}` } }))
    await auth.resolve(new Request("http://localhost/", { headers: { Authorization: `Bearer ${token}` } }))
    expect(calls).toBe(1)
  })

  it("has a default guard rejecting unauthenticated requests with 401", async () => {
    const auth = oidcServer({ issuer: ISSUER, jwksUri: "https://x/jwks.json", fetchImpl: jwksFetchImpl({ keys: [] }) })
    expect(auth.guard).toBeDefined()
    const rejected = auth.guard?.(new Request("http://localhost/"), null)
    expect(rejected).toBeInstanceOf(Response)
    expect((rejected as Response).status).toBe(401)
  })

  it("guard lets an authenticated user through", async () => {
    const auth = oidcServer({ issuer: ISSUER, jwksUri: "https://x/jwks.json", fetchImpl: jwksFetchImpl({ keys: [] }) })
    const result = auth.guard?.(new Request("http://localhost/"), { sub: "user-1" })
    expect(result).toBeUndefined()
  })
})

describe("oidcServer wired through authLayer/authMiddleware", () => {
  it("rejects unauthenticated requests at the http-api-projector layer", async () => {
    const { createFetch } = await import("@rhi-zone/fractal-http-api-projector/preset")
    const { api, op } = await import("@rhi-zone/fractal-api-tree/node")
    const { AsyncLocalStorage } = await import("node:async_hooks")

    const { token, jwks } = await makeValidToken()
    const auth = oidcServer({ issuer: ISSUER, audience: AUDIENCE, jwksUri: "https://x/jwks.json", fetchImpl: jwksFetchImpl(jwks) })
    const storage = new AsyncLocalStorage<Awaited<ReturnType<typeof auth.resolve>>>()

    const tree = api({
      whoami: op((_: unknown) => ({ sub: storage.getStore()?.sub ?? null }), {
        http: { directives: [{ kind: "method", value: "GET" }] },
      }),
    })
    const fetchHandler = createFetch(tree, {
      als: { storage, init: authLayer(auth) },
      middleware: [authMiddleware(auth)],
    })

    const anon = await fetchHandler(new Request("http://localhost/whoami"))
    expect(anon.status).toBe(401)

    const authed = await fetchHandler(new Request("http://localhost/whoami", { headers: { Authorization: `Bearer ${token}` } }))
    expect(authed.status).toBe(200)
    expect(await authed.json()).toEqual({ sub: "user-1" })
  })
})
