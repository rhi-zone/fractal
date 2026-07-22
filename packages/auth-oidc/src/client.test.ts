// packages/auth-oidc/src/client.test.ts — oidcClient (./client.ts)
//
// Exercises the client_credentials token lifecycle against a mocked token
// endpoint, then proves the full 401-refresh-retry loop works end to end
// through `authExtension` (@rhi-zone/fractal-api-tree/auth) wrapping a fake
// fetch — the same composition a real fractal HTTP client uses.

import { describe, expect, it } from "bun:test"
import { authExtension } from "@rhi-zone/fractal-api-tree/auth"
import { composeFetch } from "@rhi-zone/fractal-http-api-projector/extension"
import { oidcClient } from "./client.ts"
import type { FetchLike } from "./jwks.ts"

const TOKEN_ENDPOINT = "https://auth.example.com/oauth/token"

function tokenFetch(tokens: readonly { access_token: string; expires_in?: number }[]): { fetchImpl: FetchLike; calls: { count: number; bodies: string[] } } {
  const calls = { count: 0, bodies: [] as string[] }
  const fetchImpl: FetchLike = async (_input, init) => {
    calls.bodies.push(String(init?.body ?? ""))
    const token = tokens[calls.count] ?? tokens[tokens.length - 1]
    calls.count += 1
    return new Response(JSON.stringify(token), { status: 200, headers: { "content-type": "application/json" } })
  }
  return { fetchImpl, calls }
}

describe("oidcClient", () => {
  it("fetches a token on first getToken call, sending client_credentials grant params", async () => {
    const { fetchImpl, calls } = tokenFetch([{ access_token: "tok-1", expires_in: 300 }])
    const client = oidcClient({ tokenEndpoint: TOKEN_ENDPOINT, clientId: "my-client", clientSecret: "secret", fetchImpl })
    const token = await client.getToken()
    expect(token).toBe("tok-1")
    expect(calls.count).toBe(1)
    const params = new URLSearchParams(calls.bodies[0])
    expect(params.get("grant_type")).toBe("client_credentials")
    expect(params.get("client_id")).toBe("my-client")
    expect(params.get("client_secret")).toBe("secret")
  })

  it("includes scope and audience when configured", async () => {
    const { fetchImpl, calls } = tokenFetch([{ access_token: "tok-1" }])
    const client = oidcClient({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "my-client",
      clientSecret: "secret",
      scope: "read write",
      audience: "my-api",
      fetchImpl,
    })
    await client.getToken()
    const params = new URLSearchParams(calls.bodies[0])
    expect(params.get("scope")).toBe("read write")
    expect(params.get("audience")).toBe("my-api")
  })

  it("caches the token across calls until near expiry", async () => {
    let nowMs = 0
    const { fetchImpl, calls } = tokenFetch([{ access_token: "tok-1", expires_in: 300 }])
    const client = oidcClient({ tokenEndpoint: TOKEN_ENDPOINT, clientId: "c", clientSecret: "s", fetchImpl, now: () => nowMs })
    await client.getToken()
    nowMs += 100_000 // well within the 300s expiry
    const token = await client.getToken()
    expect(token).toBe("tok-1")
    expect(calls.count).toBe(1)
  })

  it("refreshes once the token is within refreshSkewSec of expiry", async () => {
    let nowMs = 0
    const { fetchImpl, calls } = tokenFetch([
      { access_token: "tok-1", expires_in: 60 },
      { access_token: "tok-2", expires_in: 60 },
    ])
    const client = oidcClient({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "c",
      clientSecret: "s",
      refreshSkewSec: 10,
      fetchImpl,
      now: () => nowMs,
    })
    const first = await client.getToken()
    expect(first).toBe("tok-1")
    nowMs += 55_000 // within 10s of the 60s expiry
    const second = await client.getToken()
    expect(second).toBe("tok-2")
    expect(calls.count).toBe(2)
  })

  it("dedupes concurrent getToken calls into one token request", async () => {
    let resolveFetch: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      resolveFetch = resolve
    })
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      await gate
      return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 300 }), { status: 200 })
    }
    const client = oidcClient({ tokenEndpoint: TOKEN_ENDPOINT, clientId: "c", clientSecret: "s", fetchImpl })
    const pending = Promise.all([client.getToken(), client.getToken(), client.getToken()])
    resolveFetch?.()
    const [a, b, c] = await pending
    expect(calls).toBe(1)
    expect(a).toBe("tok-1")
    expect(b).toBe("tok-1")
    expect(c).toBe("tok-1")
  })

  it("getToken resolves null when the token endpoint responds non-OK", async () => {
    const fetchImpl: FetchLike = async () => new Response("nope", { status: 401 })
    const client = oidcClient({ tokenEndpoint: TOKEN_ENDPOINT, clientId: "c", clientSecret: "s", fetchImpl })
    const token = await client.getToken()
    expect(token).toBeNull()
  })

  it("onUnauthorized drops the cached token and fetches a fresh one", async () => {
    const { fetchImpl, calls } = tokenFetch([
      { access_token: "tok-1", expires_in: 300 },
      { access_token: "tok-2", expires_in: 300 },
    ])
    const client = oidcClient({ tokenEndpoint: TOKEN_ENDPOINT, clientId: "c", clientSecret: "s", fetchImpl })
    const first = await client.getToken()
    expect(first).toBe("tok-1")
    const refreshed = await client.onUnauthorized?.()
    expect(refreshed).toBe(true)
    expect(calls.count).toBe(2)
    const token = await client.getToken()
    expect(token).toBe("tok-2")
  })

  it("onUnauthorized returns false when re-fetching also fails", async () => {
    const fetchImpl: FetchLike = async () => new Response("nope", { status: 500 })
    const client = oidcClient({ tokenEndpoint: TOKEN_ENDPOINT, clientId: "c", clientSecret: "s", fetchImpl })
    const refreshed = await client.onUnauthorized?.()
    expect(refreshed).toBe(false)
  })
})

describe("oidcClient wired through authExtension end-to-end", () => {
  it("injects the token, and on 401 refreshes via onUnauthorized and retries once", async () => {
    let issuedTokens = 0
    const tokenFetchImpl: FetchLike = async () => {
      issuedTokens += 1
      return new Response(JSON.stringify({ access_token: `tok-${issuedTokens}`, expires_in: 300 }), { status: 200 })
    }
    const client = oidcClient({ tokenEndpoint: TOKEN_ENDPOINT, clientId: "c", clientSecret: "s", fetchImpl: tokenFetchImpl })

    let apiCalls = 0
    const apiBase = async (req: Request): Promise<Response> => {
      apiCalls += 1
      const auth = req.headers.get("Authorization")
      // First API call uses tok-1 (issued once, pre-fetched below) and is
      // rejected; onUnauthorized fetches tok-2, and the retry succeeds.
      if (auth === "Bearer tok-2") return new Response("ok", { status: 200 })
      return new Response("unauthorized", { status: 401 })
    }
    const wrapped = composeFetch(apiBase, [authExtension(client)])

    const res = await wrapped(new Request("http://localhost/whoami"))
    expect(res.status).toBe(200)
    expect(apiCalls).toBe(2)
    expect(issuedTokens).toBe(2)
  })

  it("does not retry when the API call succeeds on the first try", async () => {
    const client = oidcClient({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "c",
      clientSecret: "s",
      fetchImpl: async () => new Response(JSON.stringify({ access_token: "tok-1", expires_in: 300 }), { status: 200 }),
    })
    let apiCalls = 0
    const apiBase = async (): Promise<Response> => {
      apiCalls += 1
      return new Response("ok", { status: 200 })
    }
    const wrapped = composeFetch(apiBase, [authExtension(client)])
    const res = await wrapped(new Request("http://localhost/whoami"))
    expect(res.status).toBe(200)
    expect(apiCalls).toBe(1)
  })
})
