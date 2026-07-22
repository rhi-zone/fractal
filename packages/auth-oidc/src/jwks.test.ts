// packages/auth-oidc/src/jwks.test.ts — resolveJwksUri/createJwksCache (./jwks.ts)

import { describe, expect, it } from "bun:test"
import { createJwksCache, JwksFetchError, resolveJwksUri } from "./jwks.ts"
import type { Jwks } from "./jwks.ts"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init })
}

describe("resolveJwksUri", () => {
  it("returns jwksUri directly when given, without fetching", async () => {
    let calls = 0
    const fetchImpl = async (): Promise<Response> => {
      calls += 1
      throw new Error("should not be called")
    }
    const uri = await resolveJwksUri({ jwksUri: "https://auth.example.com/jwks.json" }, fetchImpl)
    expect(uri).toBe("https://auth.example.com/jwks.json")
    expect(calls).toBe(0)
  })

  it("discovers jwks_uri from the well-known document when only issuer is given", async () => {
    const seenUrls: string[] = []
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      seenUrls.push(String(input))
      return jsonResponse({ jwks_uri: "https://auth.example.com/.well-known/jwks.json" })
    }
    const uri = await resolveJwksUri({ issuer: "https://auth.example.com" }, fetchImpl)
    expect(uri).toBe("https://auth.example.com/.well-known/jwks.json")
    expect(seenUrls).toEqual(["https://auth.example.com/.well-known/openid-configuration"])
  })

  it("strips a trailing slash from issuer before appending the discovery path", async () => {
    const seenUrls: string[] = []
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      seenUrls.push(String(input))
      return jsonResponse({ jwks_uri: "https://auth.example.com/jwks.json" })
    }
    await resolveJwksUri({ issuer: "https://auth.example.com/" }, fetchImpl)
    expect(seenUrls).toEqual(["https://auth.example.com/.well-known/openid-configuration"])
  })

  it("throws JwksFetchError when neither issuer nor jwksUri is given", async () => {
    await expect(resolveJwksUri({})).rejects.toThrow(JwksFetchError)
  })

  it("throws JwksFetchError when the discovery fetch fails", async () => {
    const fetchImpl = async (): Promise<Response> => new Response("nope", { status: 500 })
    await expect(resolveJwksUri({ issuer: "https://auth.example.com" }, fetchImpl)).rejects.toThrow(JwksFetchError)
  })

  it("throws JwksFetchError when the discovery document has no jwks_uri", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse({ issuer: "https://auth.example.com" })
    await expect(resolveJwksUri({ issuer: "https://auth.example.com" }, fetchImpl)).rejects.toThrow(JwksFetchError)
  })
})

const sampleJwks: Jwks = { keys: [{ kty: "RSA", kid: "key-1", n: "abc", e: "AQAB" }] }

describe("createJwksCache", () => {
  it("fetches once and caches within the TTL", async () => {
    let calls = 0
    const fetchImpl = async (): Promise<Response> => {
      calls += 1
      return jsonResponse(sampleJwks)
    }
    const cache = createJwksCache("https://auth.example.com/jwks.json", { fetchImpl, ttlMs: 60_000 })
    await cache.getJwks()
    await cache.getJwks()
    await cache.getJwks()
    expect(calls).toBe(1)
  })

  it("re-fetches after the TTL elapses", async () => {
    let calls = 0
    const fetchImpl = async (): Promise<Response> => {
      calls += 1
      return jsonResponse(sampleJwks)
    }
    const cache = createJwksCache("https://auth.example.com/jwks.json", { fetchImpl, ttlMs: 1 })
    await cache.getJwks()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await cache.getJwks()
    expect(calls).toBe(2)
  })

  it("dedupes concurrent fetches into a single in-flight request", async () => {
    let calls = 0
    const fetchImpl = async (): Promise<Response> => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return jsonResponse(sampleJwks)
    }
    const cache = createJwksCache("https://auth.example.com/jwks.json", { fetchImpl })
    const [a, b, c] = await Promise.all([cache.getJwks(), cache.getJwks(), cache.getJwks()])
    expect(calls).toBe(1)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })

  it("getKey finds the key by kid", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse(sampleJwks)
    const cache = createJwksCache("https://auth.example.com/jwks.json", { fetchImpl })
    const key = await cache.getKey("key-1")
    expect(key.kid).toBe("key-1")
  })

  it("getKey returns the sole key when kid is undefined and there's exactly one", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse(sampleJwks)
    const cache = createJwksCache("https://auth.example.com/jwks.json", { fetchImpl })
    const key = await cache.getKey(undefined)
    expect(key.kid).toBe("key-1")
  })

  it("getKey force-refreshes once on an unknown kid, recovering a just-rotated key", async () => {
    let currentJwks: Jwks = sampleJwks
    let calls = 0
    const fetchImpl = async (): Promise<Response> => {
      calls += 1
      return jsonResponse(currentJwks)
    }
    const cache = createJwksCache("https://auth.example.com/jwks.json", { fetchImpl, ttlMs: 60_000 })
    await cache.getKey("key-1") // warms the cache with the old key set

    // Provider rotates: a new key appears, but our cache doesn't know yet.
    currentJwks = { keys: [{ kty: "RSA", kid: "key-2", n: "def", e: "AQAB" }] }
    const rotated = await cache.getKey("key-2")
    expect(rotated.kid).toBe("key-2")
    expect(calls).toBe(2) // one initial fetch, one forced refresh
  })

  it("getKey throws JwksFetchError when no key matches even after refresh", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse(sampleJwks)
    const cache = createJwksCache("https://auth.example.com/jwks.json", { fetchImpl })
    await expect(cache.getKey("nonexistent")).rejects.toThrow(JwksFetchError)
  })

  it("throws JwksFetchError on a non-OK JWKS response", async () => {
    const fetchImpl = async (): Promise<Response> => new Response("nope", { status: 503 })
    const cache = createJwksCache("https://auth.example.com/jwks.json", { fetchImpl })
    await expect(cache.getJwks()).rejects.toThrow(JwksFetchError)
  })
})
