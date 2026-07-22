// packages/http-api-projector/src/extensions/retry.ts — @rhi-zone/fractal-http-api-projector
//
// Built-in `ClientExtension`: exponential backoff retry on transient
// failures — 5xx responses and network errors (the `fetch` call itself
// throwing). A user-initiated abort (`AbortError`) is never retried — that's
// intentional cancellation, not a transient failure. A timeout
// (`AbortSignal.timeout`'s `TimeoutError`) IS retried, same as any other
// transient failure, up to `maxRetries`.
//
// Two independent implementations of the same policy, one per interpreter
// (see extension.ts's module doc):
//   - `wrapFetch` operates on `(req: Request) => Promise<Response>` — each
//     attempt re-sends `req.clone()` (a `Request` can only be read once).
//   - `codegen.wrap` operates on generated source whose fetch impl has the
//     platform `fetch(url, init)` two-argument shape (see codegen.ts's
//     `__request`) — `init.body` is always a plain string there (already
//     JSON-serialized), so no cloning is needed; re-passing `url, init`
//     again is sufficient.
// Both share the same backoff math (`baseDelayMs * 2^attempt`, optional full
// jitter) so the two interpreters agree on behavior even though they're
// separate code.
//
// `retryOn` (a custom predicate) only affects the runtime path — it's a
// function, and codegen can't serialize a function into emitted source. The
// codegen path always uses the default 5xx/network-error predicate; pass a
// custom `retryOn` only when you don't also need codegen support for it.

import type { ClientExtension, FetchImpl } from "../extension.ts"

export type RetryOptions = {
  /** Maximum number of retry attempts after the initial try. Default 3. */
  readonly maxRetries?: number
  /** Base delay in milliseconds before the first retry; doubles each attempt. Default 100. */
  readonly baseDelayMs?: number
  /** Randomize each delay (full jitter: `delay * (0.5 + random())`). Default true. */
  readonly jitter?: boolean
  /**
   * Custom retry predicate, given the response (if the fetch succeeded) and
   * the thrown error (if it didn't). Runtime-only — ignored by codegen (see
   * module doc). Defaults to: retry on 5xx responses and on any thrown error
   * other than a user-initiated `AbortError`.
   */
  readonly retryOn?: (res: Response | undefined, err: unknown) => boolean
}

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BASE_DELAY_MS = 100

function isUserAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError"
}

function defaultShouldRetry(res: Response | undefined, err: unknown): boolean {
  if (err !== undefined) return !isUserAbort(err)
  return res !== undefined && res.status >= 500 && res.status <= 599
}

function backoffDelay(attempt: number, baseDelayMs: number, jitter: boolean): number {
  const delayMs = baseDelayMs * 2 ** attempt
  return jitter ? delayMs * (0.5 + Math.random()) : delayMs
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Exponential-backoff retry extension. Retries transient failures
 * (5xx responses, network errors, timeouts) up to `maxRetries` times, never
 * retrying a user-initiated abort.
 *
 * @example
 * createClient(node, { baseUrl, extensions: [retry({ maxRetries: 3 })] })
 */
export function retry(options: RetryOptions = {}): ClientExtension {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const jitter = options.jitter ?? true
  const shouldRetry = options.retryOn ?? defaultShouldRetry

  const wrapFetch = (inner: FetchImpl): FetchImpl => async (req: Request): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined
      let err: unknown
      try {
        res = await inner(req.clone())
      } catch (e) {
        err = e
      }

      const exhausted = attempt >= maxRetries
      const retryable = err !== undefined ? !isUserAbort(err) && shouldRetry(res, err) : shouldRetry(res, err)

      if (exhausted || !retryable) {
        if (err !== undefined) throw err
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return res!
      }

      await sleep(backoffDelay(attempt, baseDelayMs, jitter))
    }
  }

  return {
    name: "retry",
    wrapFetch,
    codegen: {
      helpers: RETRY_CODEGEN_HELPERS,
      wrap: (innerExpr) =>
        `__withRetry(${innerExpr}, ${JSON.stringify({ maxRetries, baseDelayMs, jitter })})`,
    },
  }
}

// ============================================================================
// Codegen helper source — emitted verbatim into generated client files that
// use `retry()`. Mirrors `wrapFetch` above but against the platform
// `fetch(url, init)` shape (see codegen.ts's `__request`), where `init.body`
// is always an already-serialized string, so no request cloning is needed.
// ============================================================================

const RETRY_CODEGEN_HELPERS = `
type __RetryOptions = { maxRetries: number; baseDelayMs: number; jitter: boolean }

function __retryBackoffDelay(attempt: number, baseDelayMs: number, jitter: boolean): number {
  const delayMs = baseDelayMs * 2 ** attempt
  return jitter ? delayMs * (0.5 + Math.random()) : delayMs
}

function __withRetry(inner: typeof fetch, options: __RetryOptions): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined
      let err: unknown
      try {
        res = await inner(url, init)
      } catch (e) {
        err = e
      }

      const isUserAbort = err instanceof Error && err.name === "AbortError"
      const retryable = err !== undefined ? !isUserAbort : res !== undefined && res.status >= 500 && res.status <= 599
      const exhausted = attempt >= options.maxRetries

      if (exhausted || !retryable) {
        if (err !== undefined) throw err
        return res as Response
      }

      await new Promise((resolve) => setTimeout(resolve, __retryBackoffDelay(attempt, options.baseDelayMs, options.jitter)))
    }
  }) as typeof fetch
}`.trim()
