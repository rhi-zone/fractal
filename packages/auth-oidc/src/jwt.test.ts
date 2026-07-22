// packages/auth-oidc/src/jwt.test.ts — parseJwt/verifyJwt (./jwt.ts)

import { describe, expect, it } from "bun:test"
import { checkClaims, isSupportedAlg, JwtClaimError, JwtParseError, parseJwt, verifyJwt, verifyJwtSignature } from "./jwt.ts"
import { makeSignedJwt } from "./test-helpers.ts"

describe("parseJwt", () => {
  it("decodes header and payload from a well-formed token", async () => {
    const { token } = await makeSignedJwt({ sub: "user-1", exp: 9999999999 })
    const parsed = parseJwt(token)
    expect(parsed.header.alg).toBe("RS256")
    expect(parsed.claims.sub).toBe("user-1")
  })

  it("throws JwtParseError on a token with the wrong segment count", () => {
    expect(() => parseJwt("a.b")).toThrow(JwtParseError)
    expect(() => parseJwt("a.b.c.d")).toThrow(JwtParseError)
  })

  it("throws JwtParseError on non-JSON header/payload", () => {
    expect(() => parseJwt("not-base64url!!.also-not.sig")).toThrow(JwtParseError)
  })
})

describe("isSupportedAlg", () => {
  it("accepts RSA/RSA-PSS/EC families, rejects HS*", () => {
    expect(isSupportedAlg("RS256")).toBe(true)
    expect(isSupportedAlg("PS384")).toBe(true)
    expect(isSupportedAlg("ES512")).toBe(true)
    expect(isSupportedAlg("HS256")).toBe(false)
    expect(isSupportedAlg("none")).toBe(false)
  })
})

describe("verifyJwtSignature", () => {
  it("verifies a valid RS256 signature against the matching public JWK", async () => {
    const { token, publicJwk } = await makeSignedJwt({ sub: "user-1", exp: 9999999999 })
    const parsed = parseJwt(token)
    expect(await verifyJwtSignature(parsed, publicJwk)).toBe(true)
  })

  it("verifies a valid ES256 signature against the matching public JWK", async () => {
    const { token, publicJwk } = await makeSignedJwt({ sub: "user-1", exp: 9999999999 }, { alg: "ES256" })
    const parsed = parseJwt(token)
    expect(await verifyJwtSignature(parsed, publicJwk)).toBe(true)
  })

  it("rejects a signature verified against the WRONG public key", async () => {
    const { token } = await makeSignedJwt({ sub: "user-1", exp: 9999999999 })
    const { publicJwk: otherKey } = await makeSignedJwt({ sub: "user-2", exp: 9999999999 })
    const parsed = parseJwt(token)
    expect(await verifyJwtSignature(parsed, otherKey)).toBe(false)
  })

  it("rejects a tampered payload (signature no longer matches)", async () => {
    const { token, publicJwk } = await makeSignedJwt({ sub: "user-1", exp: 9999999999 })
    const [header, , sig] = token.split(".")
    const tamperedPayload = Buffer.from(JSON.stringify({ sub: "attacker", exp: 9999999999 })).toString("base64url")
    const tampered = `${header}.${tamperedPayload}.${sig}`
    const parsed = parseJwt(tampered)
    expect(await verifyJwtSignature(parsed, publicJwk)).toBe(false)
  })
})

describe("checkClaims", () => {
  it("passes when exp is in the future and no issuer/audience configured", () => {
    expect(() => checkClaims({ exp: Date.now() / 1000 + 3600 })).not.toThrow()
  })

  it("throws JwtClaimError when exp is missing", () => {
    expect(() => checkClaims({})).toThrow(JwtClaimError)
  })

  it("throws JwtClaimError when the token is expired", () => {
    expect(() => checkClaims({ exp: Date.now() / 1000 - 10 })).toThrow(JwtClaimError)
  })

  it("tolerates expiry within clockToleranceSec", () => {
    expect(() => checkClaims({ exp: Date.now() / 1000 - 5 }, { clockToleranceSec: 30 })).not.toThrow()
  })

  it("throws JwtClaimError on nbf in the future", () => {
    expect(() => checkClaims({ exp: Date.now() / 1000 + 3600, nbf: Date.now() / 1000 + 60 })).toThrow(JwtClaimError)
  })

  it("throws JwtClaimError on issuer mismatch", () => {
    expect(() => checkClaims({ exp: Date.now() / 1000 + 3600, iss: "https://evil.example.com" }, { issuer: "https://auth.example.com" })).toThrow(JwtClaimError)
  })

  it("passes on issuer match", () => {
    expect(() => checkClaims({ exp: Date.now() / 1000 + 3600, iss: "https://auth.example.com" }, { issuer: "https://auth.example.com" })).not.toThrow()
  })

  it("throws JwtClaimError on audience mismatch (single value)", () => {
    expect(() => checkClaims({ exp: Date.now() / 1000 + 3600, aud: "other-api" }, { audience: "my-api" })).toThrow(JwtClaimError)
  })

  it("passes when aud is an array containing the expected audience", () => {
    expect(() => checkClaims({ exp: Date.now() / 1000 + 3600, aud: ["other-api", "my-api"] }, { audience: "my-api" })).not.toThrow()
  })

  it("passes when expected audience is any-of a list", () => {
    expect(() => checkClaims({ exp: Date.now() / 1000 + 3600, aud: "my-api" }, { audience: ["my-api", "other-api"] })).not.toThrow()
  })
})

describe("verifyJwt (full pipeline)", () => {
  it("returns claims on a fully valid token", async () => {
    const { token, publicJwk } = await makeSignedJwt({
      sub: "user-1",
      iss: "https://auth.example.com",
      aud: "my-api",
      exp: Date.now() / 1000 + 3600,
    })
    const claims = await verifyJwt(token, publicJwk, { issuer: "https://auth.example.com", audience: "my-api" })
    expect(claims.sub).toBe("user-1")
  })

  it("throws on an invalid signature", async () => {
    const { token } = await makeSignedJwt({ sub: "user-1", exp: Date.now() / 1000 + 3600 })
    const { publicJwk: wrongKey } = await makeSignedJwt({ sub: "user-2", exp: Date.now() / 1000 + 3600 })
    await expect(verifyJwt(token, wrongKey)).rejects.toThrow(JwtClaimError)
  })

  it("throws on an expired token even with a valid signature", async () => {
    const { token, publicJwk } = await makeSignedJwt({ sub: "user-1", exp: Date.now() / 1000 - 10 })
    await expect(verifyJwt(token, publicJwk)).rejects.toThrow(JwtClaimError)
  })
})
