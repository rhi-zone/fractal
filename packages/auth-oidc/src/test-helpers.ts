// packages/auth-oidc/src/test-helpers.ts — @rhi-zone/fractal-auth-oidc (test-only)
//
// JWT signing via Web Crypto, for tests only — mirrors what a REAL OIDC
// provider does server-side, so tests exercise the same verification path
// `verifyJwtSignature`/`oidcServer` use, without a JWT library on either
// side of the round trip.

import { jsonToBase64Url } from "./jwt.ts"
import type { Jwk } from "./jwt.ts"

export type SignedJwtFixture = {
  readonly token: string
  readonly publicJwk: Jwk
}

/** Generates an RS256 keypair, signs `claims` with it, and exports the matching public JWK (with `kid`). */
export async function makeSignedJwt(
  claims: Record<string, unknown>,
  options: { readonly kid?: string; readonly alg?: string } = {},
): Promise<SignedJwtFixture> {
  const alg = options.alg ?? "RS256"
  const kid = options.kid ?? "test-key-1"

  const { importParams, signParams } = signSpecFor(alg)
  const keyPair = await crypto.subtle.generateKey(importParams, true, ["sign", "verify"])
  const publicJwkRaw = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as Record<string, unknown>
  const publicJwk = { ...publicJwkRaw, kid, alg } as Jwk

  const header = { alg, typ: "JWT", kid }
  const signingInput = `${jsonToBase64Url(header)}.${jsonToBase64Url(claims)}`
  const signatureBuf = await crypto.subtle.sign(signParams, keyPair.privateKey, new TextEncoder().encode(signingInput))
  const signatureB64 = bytesToBase64Url(new Uint8Array(signatureBuf))

  return { token: `${signingInput}.${signatureB64}`, publicJwk }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function signSpecFor(alg: string): { readonly importParams: RsaHashedKeyGenParams | EcKeyGenParams; readonly signParams: AlgorithmIdentifier | RsaPssParams | EcdsaParams } {
  switch (alg) {
    case "RS256":
      return {
        importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
        signParams: "RSASSA-PKCS1-v1_5",
      }
    case "ES256":
      return {
        importParams: { name: "ECDSA", namedCurve: "P-256" },
        signParams: { name: "ECDSA", hash: "SHA-256" },
      }
    default:
      throw new Error(`test-helpers: unsupported alg "${alg}"`)
  }
}
