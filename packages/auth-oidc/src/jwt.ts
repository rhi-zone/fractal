// packages/auth-oidc/src/jwt.ts — @rhi-zone/fractal-auth-oidc/jwt
//
// Minimal JWT parsing + signature verification, entirely on the Web Crypto
// API (`crypto.subtle`) — no JWT library dependency, per the task's
// constraint. A JWT is just three base64url segments (`header.payload.
// signature`); this module base64url-decodes them, JSON-parses the first
// two, and verifies the third against a JWKS public key with
// `crypto.subtle.verify`.
//
// Deliberately narrow: supports the algorithm families an OIDC provider's
// JWKS realistically publishes (RS256/384/512, PS256/384/512, ES256/384/
// 512) — HS256 (symmetric) is intentionally NOT supported, since a shared
// secret has no place in a JWKS (a JWKS publishes PUBLIC keys only; HS256
// verification would need the provider's private secret, which defeats the
// entire point of JWKS-based verification).

// ============================================================================
// base64url <-> bytes/string
// ============================================================================

function base64UrlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/")
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4))
  const binary = atob(padded + pad)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function bytesToBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function base64UrlToJson(b64url: string): unknown {
  const bytes = base64UrlToBytes(b64url)
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** Encodes a JSON value as a base64url segment — the inverse of `base64UrlToJson`. Used by tests to construct JWTs without a JWT library. */
export function jsonToBase64Url(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)))
}

// ============================================================================
// Parsed JWT shape
// ============================================================================

export type JwtHeader = {
  readonly alg: string
  readonly kid?: string
  readonly typ?: string
  readonly [key: string]: unknown
}

/** Standard registered claims (RFC 7519 §4.1) plus any provider-specific claims. */
export type JwtClaims = {
  readonly iss?: string
  readonly sub?: string
  readonly aud?: string | readonly string[]
  readonly exp?: number
  readonly nbf?: number
  readonly iat?: number
  readonly [key: string]: unknown
}

export type ParsedJwt = {
  readonly header: JwtHeader
  readonly claims: JwtClaims
  /** The exact `"header.payload"` ASCII substring the signature was computed over. */
  readonly signingInput: string
  readonly signature: Uint8Array<ArrayBuffer>
}

export class JwtParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JwtParseError"
  }
}

/**
 * Splits a compact JWT into its three segments and decodes the header/
 * payload as JSON. Does NOT verify the signature or any claim — see
 * `verifyJwt` for that. Throws `JwtParseError` on a malformed token (wrong
 * segment count, invalid base64url, non-JSON header/payload).
 */
export function parseJwt(token: string): ParsedJwt {
  const segments = token.split(".")
  if (segments.length !== 3) throw new JwtParseError(`expected 3 segments, got ${segments.length}`)
  const [headerB64, payloadB64, signatureB64] = segments as [string, string, string]

  let header: unknown
  let claims: unknown
  try {
    header = base64UrlToJson(headerB64)
    claims = base64UrlToJson(payloadB64)
  } catch (err) {
    throw new JwtParseError(`malformed header/payload: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (typeof header !== "object" || header === null || typeof (header as { alg?: unknown }).alg !== "string") {
    throw new JwtParseError("header missing string \"alg\"")
  }
  if (typeof claims !== "object" || claims === null) {
    throw new JwtParseError("payload is not a JSON object")
  }

  return {
    header: header as JwtHeader,
    claims: claims as JwtClaims,
    signingInput: `${headerB64}.${payloadB64}`,
    signature: base64UrlToBytes(signatureB64),
  }
}

// ============================================================================
// JWK -> CryptoKey import, per algorithm family
// ============================================================================

export type Jwk = {
  readonly kty: string
  readonly kid?: string
  readonly alg?: string
  readonly use?: string
  /** RSA modulus (base64url), present when `kty === "RSA"`. */
  readonly n?: string
  /** RSA exponent (base64url), present when `kty === "RSA"`. */
  readonly e?: string
  /** EC curve name (e.g. `"P-256"`), present when `kty === "EC"`. */
  readonly crv?: string
  /** EC x coordinate (base64url), present when `kty === "EC"`. */
  readonly x?: string
  /** EC y coordinate (base64url), present when `kty === "EC"`. */
  readonly y?: string
  readonly [key: string]: unknown
}

export type Jwks = {
  readonly keys: readonly Jwk[]
}

type AlgSpec = {
  readonly importParams: RsaHashedImportParams | EcKeyImportParams
  readonly verifyParams: AlgorithmIdentifier | RsaPssParams | EcdsaParams
}

const ALG_SPECS: Readonly<Record<string, AlgSpec>> = {
  RS256: { importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verifyParams: "RSASSA-PKCS1-v1_5" },
  RS384: { importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" }, verifyParams: "RSASSA-PKCS1-v1_5" },
  RS512: { importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" }, verifyParams: "RSASSA-PKCS1-v1_5" },
  PS256: { importParams: { name: "RSA-PSS", hash: "SHA-256" }, verifyParams: { name: "RSA-PSS", saltLength: 32 } },
  PS384: { importParams: { name: "RSA-PSS", hash: "SHA-384" }, verifyParams: { name: "RSA-PSS", saltLength: 48 } },
  PS512: { importParams: { name: "RSA-PSS", hash: "SHA-512" }, verifyParams: { name: "RSA-PSS", saltLength: 64 } },
  ES256: { importParams: { name: "ECDSA", namedCurve: "P-256" }, verifyParams: { name: "ECDSA", hash: "SHA-256" } },
  ES384: { importParams: { name: "ECDSA", namedCurve: "P-384" }, verifyParams: { name: "ECDSA", hash: "SHA-384" } },
  ES512: { importParams: { name: "ECDSA", namedCurve: "P-521" }, verifyParams: { name: "ECDSA", hash: "SHA-512" } },
}

/** Whether `alg` is one this module can verify (see module doc for why HS* is excluded). */
export function isSupportedAlg(alg: string): boolean {
  return alg in ALG_SPECS
}

/** Imports a JWK as a `CryptoKey` usable with `crypto.subtle.verify`, for the given JWT `alg`. */
export async function importVerifyKey(jwk: Jwk, alg: string): Promise<CryptoKey> {
  const spec = ALG_SPECS[alg]
  if (spec === undefined) throw new JwtParseError(`unsupported alg "${alg}"`)
  return crypto.subtle.importKey("jwk", jwk as JsonWebKey, spec.importParams, false, ["verify"])
}

/**
 * Verifies `parsed.signature` against `parsed.signingInput` using `jwk` —
 * the low-level primitive `verifyJwt` (below) composes with claim checks.
 * Returns `false` (never throws) on any verification failure, including an
 * unsupported/mismatched `alg`.
 */
export async function verifyJwtSignature(parsed: ParsedJwt, jwk: Jwk): Promise<boolean> {
  const alg = parsed.header.alg
  const spec = ALG_SPECS[alg]
  if (spec === undefined) return false
  try {
    const key = await importVerifyKey(jwk, alg)
    const data = new TextEncoder().encode(parsed.signingInput)
    return await crypto.subtle.verify(spec.verifyParams, key, parsed.signature, data)
  } catch {
    return false
  }
}

// ============================================================================
// Claim validation
// ============================================================================

export type ClaimCheckOptions = {
  readonly issuer?: string
  readonly audience?: string | readonly string[]
  /** Seconds of leeway for `exp`/`nbf` comparisons against the current time. Default 0. */
  readonly clockToleranceSec?: number
  /** Injectable clock for tests. Defaults to `Date.now`. */
  readonly now?: () => number
}

export class JwtClaimError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JwtClaimError"
  }
}

function audienceMatches(claimAud: string | readonly string[] | undefined, expected: string | readonly string[]): boolean {
  if (claimAud === undefined) return false
  const claimList = Array.isArray(claimAud) ? claimAud : [claimAud]
  const expectedList = Array.isArray(expected) ? expected : [expected]
  return expectedList.some((e) => claimList.includes(e))
}

/**
 * Validates the standard registered claims: `exp` (required — a JWT with no
 * expiry is rejected), `nbf` (if present), `iss` (if `options.issuer` set),
 * `aud` (if `options.audience` set). Throws `JwtClaimError` describing the
 * first failing check; returns normally when every configured check passes.
 */
export function checkClaims(claims: JwtClaims, options: ClaimCheckOptions = {}): void {
  const now = (options.now ?? Date.now)() / 1000
  const tolerance = options.clockToleranceSec ?? 0

  if (typeof claims.exp !== "number") throw new JwtClaimError("missing \"exp\" claim")
  if (now > claims.exp + tolerance) throw new JwtClaimError("token expired")

  if (typeof claims.nbf === "number" && now < claims.nbf - tolerance) {
    throw new JwtClaimError("token not yet valid (\"nbf\")")
  }

  if (options.issuer !== undefined && claims.iss !== options.issuer) {
    throw new JwtClaimError(`issuer mismatch: expected "${options.issuer}", got "${String(claims.iss)}"`)
  }

  if (options.audience !== undefined && !audienceMatches(claims.aud, options.audience)) {
    throw new JwtClaimError(`audience mismatch: expected one of ${JSON.stringify(options.audience)}, got ${JSON.stringify(claims.aud)}`)
  }
}

/**
 * Full verification pipeline: parse, verify signature against `jwk`, then
 * check standard claims. Returns the validated claims on success; throws
 * `JwtParseError`/`JwtClaimError` (or returns via the boolean signature
 * check — see below) on any failure. Signature failure throws
 * `JwtClaimError`-adjacent `Error` rather than silently returning `false`,
 * so a caller doing `try { verifyJwt(...) } catch { return null }` (the
 * `AuthAdapter.resolve` convention — see `../server.ts`) treats every
 * failure mode uniformly.
 */
export async function verifyJwt(token: string, jwk: Jwk, options: ClaimCheckOptions = {}): Promise<JwtClaims> {
  const parsed = parseJwt(token)
  const validSignature = await verifyJwtSignature(parsed, jwk)
  if (!validSignature) throw new JwtClaimError("invalid signature")
  checkClaims(parsed.claims, options)
  return parsed.claims
}
