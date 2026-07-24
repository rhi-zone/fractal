// packages/http-api-projector/src/webhook.ts — @rhi-zone/fractal-http-api-projector
//
// Composable HTTP layers for inbound webhooks — same `Fetch => Fetch`
// wrapper shape as `layers.ts` (see that file's module doc), so both are
// droppable and compose in any order via plain function application. Two
// independent concerns, each its own layer:
//
//   webhookSignatureLayer   — HMAC signature verification over the raw
//                              request body, against a shared secret.
//                              401 on missing/malformed/mismatched signature.
//   replayPreventionLayer   — dedupes by a delivery-id header against a
//                              pluggable store. 409 on a duplicate id.
//
// Neither layer touches payload SHAPE validation — an inbound webhook is a
// normal operation with a normal input schema, so the existing
// `opts.validators` (preset.ts) / `wrapValidators` (api-tree/build) path
// already covers it. These layers only cover what schema validation can't:
// proving the body came from the claimed sender, and proving it hasn't been
// delivered before.
//
// Web Crypto only (`crypto.subtle`), no Node `crypto` import — same
// portability constraint as `auth-oidc/src/jwt.ts` (Bun/Deno/Workers all
// implement it).

export type Fetch = (req: Request) => Promise<Response>

// ============================================================================
// webhookSignatureLayer
//
// Reads a signature header, recomputes an HMAC digest over the raw request
// body (read via `req.clone().text()` so the body stream is still intact
// for `inner`), and compares it against the header value. Supports three
// header encodings, auto-detected from the header's own shape:
//   - raw hex                    e.g. "5257a869e7bf..."
//   - "sha256=<hex>" prefix      GitHub style
//   - base64                     e.g. "UletqefL8+..."
//
// Optional timestamp binding: when `timestampHeader` is set, the signed
// payload becomes `"<timestamp>.<rawBody>"` (Stripe-style) instead of the
// raw body alone, and the timestamp is checked against `toleranceSec` of
// the current time BEFORE the signature is even computed — a request whose
// timestamp has drifted too far is rejected without doing the HMAC work.
// ============================================================================

/** Hash algorithm for the HMAC digest. Passed straight through to `crypto.subtle`. */
export type WebhookHashAlgorithm = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512"

export type WebhookSignatureOptions = {
  /** Shared secret the sender used to sign the payload. */
  readonly secret: string
  /** Header carrying the signature. Default `"X-Webhook-Signature"`. */
  readonly header?: string
  /** HMAC hash algorithm. Default `"SHA-256"`. */
  readonly algorithm?: WebhookHashAlgorithm
  /**
   * Header carrying a Unix timestamp (seconds). When set, the signed
   * payload is `"<timestamp>.<rawBody>"` instead of the raw body alone, and
   * the timestamp must be present and within `toleranceSec` of `now()` or
   * the request is rejected before the signature is even checked. Absent by
   * default — no timestamp binding, signed payload is the raw body.
   */
  readonly timestampHeader?: string
  /** Allowed clock drift, in seconds, for `timestampHeader` checks. Default 300 (5 minutes). */
  readonly toleranceSec?: number
  /** Injectable clock for tests. Defaults to `Date.now`. */
  readonly now?: () => number
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return undefined
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) return undefined
    bytes[i] = byte
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) return undefined
  try {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return undefined
  }
}

/**
 * Parses a signature header value into raw bytes, auto-detecting the
 * encoding: `"sha256=<hex>"` (or any `"<alg>=<hex>"` prefix) is stripped
 * first, then the remainder is tried as hex, falling back to base64.
 * Returns `undefined` when the value matches neither shape.
 */
function extractSignatureBytes(headerValue: string): Uint8Array<ArrayBuffer> | undefined {
  const eq = headerValue.indexOf("=")
  // "sha256=<hex>" style: only strip when what precedes "=" looks like an
  // algorithm tag (letters/digits/hyphens), not base64 padding.
  const unprefixed =
    eq > 0 && /^[a-zA-Z0-9-]+$/.test(headerValue.slice(0, eq)) ? headerValue.slice(eq + 1) : headerValue

  return hexToBytes(unprefixed) ?? base64ToBytes(unprefixed) ?? hexToBytes(headerValue) ?? base64ToBytes(headerValue)
}

/** Constant-time byte comparison — never short-circuits on the first mismatch. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number)
  return diff === 0
}

async function importHmacKey(secret: string, algorithm: WebhookHashAlgorithm): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  )
}

/**
 * Computes the HMAC digest (hex-encoded) of `payload` under `secret` —
 * exposed so a sender-side test fixture / example can produce a valid
 * signature without duplicating the HMAC call.
 */
export async function computeWebhookSignature(
  payload: string,
  secret: string,
  algorithm: WebhookHashAlgorithm = "SHA-256",
): Promise<string> {
  const key = await importHmacKey(secret, algorithm)
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
  return bytesToHex(new Uint8Array(digest))
}

/**
 * Webhook signature-verification layer. Returns 401 for a missing header, a
 * missing/out-of-tolerance timestamp (when `timestampHeader` is set), a
 * header value that parses as neither hex nor base64, or a signature that
 * doesn't match the recomputed HMAC digest.
 *
 * @example
 * const handler = webhookSignatureLayer({ secret: process.env.WEBHOOK_SECRET! })(innerFetch)
 */
export function webhookSignatureLayer(opts: WebhookSignatureOptions): (inner: Fetch) => Fetch {
  const header = opts.header ?? "X-Webhook-Signature"
  const algorithm = opts.algorithm ?? "SHA-256"
  const toleranceSec = opts.toleranceSec ?? 300
  const now = opts.now ?? Date.now
  const keyPromise = importHmacKey(opts.secret, algorithm)

  return (inner) => async (req) => {
    const sigHeader = req.headers.get(header)
    if (sigHeader === null || sigHeader.length === 0) {
      return new Response("Missing signature header", { status: 401 })
    }

    let timestamp: string | undefined
    if (opts.timestampHeader !== undefined) {
      const raw = req.headers.get(opts.timestampHeader)
      if (raw === null) return new Response("Missing timestamp header", { status: 401 })
      const ts = Number(raw)
      if (!Number.isFinite(ts) || Math.abs(now() / 1000 - ts) > toleranceSec) {
        return new Response("Timestamp outside tolerance window", { status: 401 })
      }
      timestamp = raw
    }

    const providedBytes = extractSignatureBytes(sigHeader)
    if (providedBytes === undefined) {
      return new Response("Malformed signature header", { status: 401 })
    }

    // Clone before reading — `inner` still needs an intact body stream.
    const rawBody = await req.clone().text()
    const signedPayload = timestamp !== undefined ? `${timestamp}.${rawBody}` : rawBody

    const key = await keyPromise
    const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload))
    const digestBytes = new Uint8Array(digest)

    if (!timingSafeEqual(digestBytes, providedBytes)) {
      return new Response("Invalid signature", { status: 401 })
    }

    return inner(req)
  }
}

// ============================================================================
// replayPreventionLayer
//
// Dedupes inbound webhook deliveries by a delivery-id header, against a
// pluggable `{ has, add }` store — deliberately the smallest interface that
// supports both an in-memory default and a swap-in for Redis/DB/KV-backed
// storage in a multi-instance deployment. A request with no delivery-id
// header passes through unchecked (there's nothing to dedupe against); a
// request whose id is already in the store gets 409.
// ============================================================================

export type ReplayStore = {
  has(id: string): Promise<boolean> | boolean
  add(id: string, ttlMs?: number): Promise<void> | void
}

export type ReplayPreventionOptions = {
  /** Header carrying the delivery id. Default `"X-Webhook-Delivery-ID"`. */
  readonly header?: string
  /** Store to check/record delivery ids against. Defaults to a fresh in-memory store. */
  readonly store?: ReplayStore
  /** TTL, in ms, for a recorded delivery id. Default 24 hours. Forwarded as `store.add`'s second argument. */
  readonly ttlMs?: number
}

const DEFAULT_REPLAY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * In-memory `ReplayStore` — the default when `ReplayPreventionOptions.store`
 * is omitted. Entries expire lazily (checked on `has`, swept opportunistically
 * on `add`) rather than via a timer, so it has no background work to clean up
 * and is safe to use in short-lived runtimes (e.g. a single Worker isolate).
 * Not shared across processes — use a real store (Redis, DB, KV) for a
 * multi-instance deployment.
 */
export function createInMemoryReplayStore(defaultTtlMs: number = DEFAULT_REPLAY_TTL_MS): ReplayStore {
  const expiresAt = new Map<string, number>()
  let opsSinceSweep = 0

  const sweep = (now: number): void => {
    for (const [id, exp] of expiresAt) {
      if (exp <= now) expiresAt.delete(id)
    }
  }

  return {
    has(id) {
      const exp = expiresAt.get(id)
      if (exp === undefined) return false
      if (exp <= Date.now()) {
        expiresAt.delete(id)
        return false
      }
      return true
    },
    add(id, ttlMs) {
      expiresAt.set(id, Date.now() + (ttlMs ?? defaultTtlMs))
      opsSinceSweep++
      if (opsSinceSweep >= 1000) {
        opsSinceSweep = 0
        sweep(Date.now())
      }
    },
  }
}

/**
 * Replay-prevention layer. Returns 409 when `header`'s value is already
 * present in `store`; otherwise records it and delegates to `inner`.
 *
 * @example
 * const handler = replayPreventionLayer()(innerFetch) // in-memory store, 24h TTL
 */
export function replayPreventionLayer(opts: ReplayPreventionOptions = {}): (inner: Fetch) => Fetch {
  const header = opts.header ?? "X-Webhook-Delivery-ID"
  const store = opts.store ?? createInMemoryReplayStore()
  const ttlMs = opts.ttlMs

  return (inner) => async (req) => {
    const id = req.headers.get(header)
    if (id === null || id.length === 0) return inner(req) // nothing to dedupe against

    if (await store.has(id)) {
      return new Response("Duplicate delivery", { status: 409 })
    }
    await store.add(id, ttlMs)
    return inner(req)
  }
}
