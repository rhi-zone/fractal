// packages/http-api-projector/src/extensions/errors.ts — @rhi-zone/fractal-http-api-projector
//
// Built-in `ClientExtension`: classify non-2xx responses into typed
// `ClientError` subclasses (one per status/status-category) instead of the
// generic `ClientError` both `client.ts` (`makeCaller`) and `codegen.ts`
// (`__request`) throw on their own. Mirrors the shape production SDKs
// (Stripe, OpenAI/Stainless-generated clients) give callers: a
// `catch (err) { if (err instanceof NotFoundError) ... }` discriminates
// without inspecting `err.status` by hand.
//
// Two independent implementations of the same classification, one per
// interpreter (see extension.ts's module doc):
//   - `wrapFetch` operates on `(req: Request) => Promise<Response>` — reads
//     the response body itself and throws BEFORE returning to the caller
//     (`makeCaller` in client.ts), so the caller's own generic
//     `if (!res.ok) throw new ClientError(...)` is never reached: the
//     typed error is already in flight by the time `fetchImpl(req)`
//     resolves/rejects.
//   - `codegen.wrap` operates on generated source whose fetch impl has the
//     platform `fetch(url, init)` two-argument shape (see codegen.ts's
//     `__request`) — same interception, same reasoning.
// Both classify by exact status code for 400/401/403/404/409/422/429, and by
// `status >= 500` for `InternalServerError` (a catch-all for the 5xx range,
// since exact 5xx codes vary by server and don't warrant one class each).
//
// The codegen helper's error classes extend the `ClientError` codegen.ts's
// `RUNTIME_HELPERS` always emits (status/statusText/body) — that class is
// emitted unconditionally, before any extension helpers (see codegen.ts's
// `render`), so this extension's helper text can reference `ClientError` by
// name without redefining it.

import type { ClientExtension, FetchImpl } from "../extension.ts"
import { ClientError } from "../client-error.ts"

// ============================================================================
// Runtime error classes
// ============================================================================

export class BadRequestError extends ClientError {
  constructor(body: unknown) {
    super(400, body)
    this.name = "BadRequestError"
  }
}

export class AuthenticationError extends ClientError {
  constructor(body: unknown) {
    super(401, body)
    this.name = "AuthenticationError"
  }
}

export class ForbiddenError extends ClientError {
  constructor(body: unknown) {
    super(403, body)
    this.name = "ForbiddenError"
  }
}

export class NotFoundError extends ClientError {
  constructor(body: unknown) {
    super(404, body)
    this.name = "NotFoundError"
  }
}

export class ConflictError extends ClientError {
  constructor(body: unknown) {
    super(409, body)
    this.name = "ConflictError"
  }
}

export class UnprocessableEntityError extends ClientError {
  constructor(body: unknown) {
    super(422, body)
    this.name = "UnprocessableEntityError"
  }
}

/**
 * 429 Too Many Requests. Parses `Retry-After` (seconds or HTTP-date, per
 * RFC 9110 §10.2.3) into `retryAfterMs`, and the de-facto
 * `X-RateLimit-Limit`/`X-RateLimit-Remaining`/`X-RateLimit-Reset` headers
 * (no single RFC governs these; this is the convention GitHub/Stripe/OpenAI
 * all follow) into `limit`/`remaining`/`resetMs`. Any header that's absent
 * or unparseable leaves its field `undefined` rather than guessing.
 */
export class RateLimitError extends ClientError {
  readonly retryAfterMs?: number | undefined
  readonly limit?: number | undefined
  readonly remaining?: number | undefined
  readonly resetMs?: number | undefined

  constructor(body: unknown, headers: Headers) {
    super(429, body)
    this.name = "RateLimitError"
    this.retryAfterMs = parseRetryAfterMs(headers.get("Retry-After"))
    this.limit = parseIntHeader(headers.get("X-RateLimit-Limit"))
    this.remaining = parseIntHeader(headers.get("X-RateLimit-Remaining"))
    this.resetMs = parseResetMs(headers.get("X-RateLimit-Reset"))
  }
}

/** Catch-all for the 5xx range — `status` carries the exact code (500, 502, 503, ...). */
export class InternalServerError extends ClientError {
  constructor(status: number, body: unknown) {
    super(status, body)
    this.name = "InternalServerError"
  }
}

// ============================================================================
// Runtime header parsing — shared by wrapFetch classification; duplicated
// (not imported) into ERRORS_CODEGEN_HELPERS below, same split as retry.ts.
// ============================================================================

/** `Retry-After`: either a delay in whole seconds, or an HTTP-date to wait until. */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  const seconds = Number(value)
  if (!Number.isNaN(seconds)) return seconds * 1000
  const dateMs = Date.parse(value)
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now())
}

function parseIntHeader(value: string | null): number | undefined {
  if (value === null) return undefined
  const n = Number(value)
  return Number.isNaN(n) ? undefined : n
}

/**
 * `X-RateLimit-Reset`: conventions differ between an absolute epoch-seconds
 * timestamp (GitHub) and a relative seconds-until-reset delta (others).
 * Heuristic: a value larger than a relative delta could plausibly be
 * (1e9 seconds ~= 2001-09-09) is treated as epoch seconds and converted to
 * an absolute `resetMs` epoch-milliseconds value; smaller values are treated
 * as a delta from now.
 */
function parseResetMs(value: string | null): number | undefined {
  if (value === null) return undefined
  const n = Number(value)
  if (Number.isNaN(n)) return undefined
  return n > 1e9 ? n * 1000 : Date.now() + n * 1000
}

function classifyError(status: number, body: unknown, headers: Headers): ClientError {
  switch (status) {
    case 400:
      return new BadRequestError(body)
    case 401:
      return new AuthenticationError(body)
    case 403:
      return new ForbiddenError(body)
    case 404:
      return new NotFoundError(body)
    case 409:
      return new ConflictError(body)
    case 422:
      return new UnprocessableEntityError(body)
    case 429:
      return new RateLimitError(body, headers)
    default:
      return status >= 500 ? new InternalServerError(status, body) : new ClientError(status, body)
  }
}

async function parseErrorBody(res: Response): Promise<unknown> {
  const ct = res.headers.get("Content-Type") ?? ""
  return ct.includes("application/json") ? await res.json() : await res.text()
}

/**
 * Structured-error extension: classifies non-2xx responses into typed
 * `ClientError` subclasses (see module doc) instead of the generic
 * `ClientError` the client would otherwise throw.
 *
 * @example
 * createClient(node, { baseUrl, extensions: [errors()] })
 */
export function errors(): ClientExtension {
  const wrapFetch = (inner: FetchImpl): FetchImpl => async (req: Request): Promise<Response> => {
    const res = await inner(req)
    if (res.ok) return res
    const body = await parseErrorBody(res)
    throw classifyError(res.status, body, res.headers)
  }

  return {
    name: "errors",
    wrapFetch,
    codegen: {
      helpers: ERRORS_CODEGEN_HELPERS,
      wrap: (innerExpr) => `__withErrors(${innerExpr})`,
    },
  }
}

// ============================================================================
// Codegen helper source — emitted verbatim into generated client files that
// use `errors()`. Mirrors the runtime classes/classification above against
// the platform `fetch(url, init)` shape (see codegen.ts's `__request`), and
// extends the `ClientError` class codegen.ts's `RUNTIME_HELPERS` always
// emits (status/statusText/body — a 3-arg constructor, unlike runtime's
// `client-error.ts` 2-arg one) ahead of any extension helpers.
// ============================================================================

const ERRORS_CODEGEN_HELPERS = `
export class BadRequestError extends ClientError {
  constructor(statusText: string, body: unknown) {
    super(400, statusText, body)
    this.name = "BadRequestError"
  }
}

export class AuthenticationError extends ClientError {
  constructor(statusText: string, body: unknown) {
    super(401, statusText, body)
    this.name = "AuthenticationError"
  }
}

export class ForbiddenError extends ClientError {
  constructor(statusText: string, body: unknown) {
    super(403, statusText, body)
    this.name = "ForbiddenError"
  }
}

export class NotFoundError extends ClientError {
  constructor(statusText: string, body: unknown) {
    super(404, statusText, body)
    this.name = "NotFoundError"
  }
}

export class ConflictError extends ClientError {
  constructor(statusText: string, body: unknown) {
    super(409, statusText, body)
    this.name = "ConflictError"
  }
}

export class UnprocessableEntityError extends ClientError {
  constructor(statusText: string, body: unknown) {
    super(422, statusText, body)
    this.name = "UnprocessableEntityError"
  }
}

export class RateLimitError extends ClientError {
  readonly retryAfterMs?: number
  readonly limit?: number
  readonly remaining?: number
  readonly resetMs?: number

  constructor(statusText: string, body: unknown, headers: Headers) {
    super(429, statusText, body)
    this.name = "RateLimitError"
    this.retryAfterMs = __parseRetryAfterMs(headers.get("Retry-After"))
    this.limit = __parseIntHeader(headers.get("X-RateLimit-Limit"))
    this.remaining = __parseIntHeader(headers.get("X-RateLimit-Remaining"))
    this.resetMs = __parseResetMs(headers.get("X-RateLimit-Reset"))
  }
}

export class InternalServerError extends ClientError {
  constructor(status: number, statusText: string, body: unknown) {
    super(status, statusText, body)
    this.name = "InternalServerError"
  }
}

function __parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  const seconds = Number(value)
  if (!Number.isNaN(seconds)) return seconds * 1000
  const dateMs = Date.parse(value)
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now())
}

function __parseIntHeader(value: string | null): number | undefined {
  if (value === null) return undefined
  const n = Number(value)
  return Number.isNaN(n) ? undefined : n
}

function __parseResetMs(value: string | null): number | undefined {
  if (value === null) return undefined
  const n = Number(value)
  if (Number.isNaN(n)) return undefined
  return n > 1e9 ? n * 1000 : Date.now() + n * 1000
}

function __classifyError(status: number, statusText: string, body: unknown, headers: Headers): ClientError {
  switch (status) {
    case 400:
      return new BadRequestError(statusText, body)
    case 401:
      return new AuthenticationError(statusText, body)
    case 403:
      return new ForbiddenError(statusText, body)
    case 404:
      return new NotFoundError(statusText, body)
    case 409:
      return new ConflictError(statusText, body)
    case 422:
      return new UnprocessableEntityError(statusText, body)
    case 429:
      return new RateLimitError(statusText, body, headers)
    default:
      return status >= 500 ? new InternalServerError(status, statusText, body) : new ClientError(status, statusText, body)
  }
}

async function __parseErrorBody(res: Response): Promise<unknown> {
  const ct = res.headers.get("Content-Type") ?? ""
  return ct.includes("application/json") ? await res.json() : await res.text()
}

function __withErrors(inner: typeof fetch): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const res = await inner(url, init)
    if (res.ok) return res
    const body = await __parseErrorBody(res)
    throw __classifyError(res.status, res.statusText, body, res.headers)
  }) as typeof fetch
}`.trim()
