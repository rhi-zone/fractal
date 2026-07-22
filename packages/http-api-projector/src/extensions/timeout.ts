// packages/http-api-projector/src/extensions/timeout.ts — @rhi-zone/fractal-http-api-projector
//
// Built-in `ClientExtension`: a fixed per-request timeout via
// `AbortSignal.timeout`, combined (via `AbortSignal.any`) with whatever
// signal the request already carries — so it composes with a user's own
// `AbortController`, and with other extensions (e.g. `retry()` wrapping
// `timeout()`: each retry attempt gets a fresh timeout clock, since a new
// `AbortSignal.timeout` is created per call to the wrapper, not once at
// construction — a shared one would only ever fire on the first slow call).
//
// This is the extension form of the timeout behavior `client.ts` has always
// had built into `ClientOptions.timeout`/`CallOptions.timeout` (see
// client.ts's `resolveSignal`/`describeAbort`) — that per-call-overridable
// fast path stays as-is (it's already tested, already the common case, and
// needs `CallOptions` access that a `wrapFetch(req) => Response` hook
// doesn't have). Use THIS extension when composing a custom extension list
// (e.g. with `createClientFromRoute`, or in codegen output) that wants a
// fixed timeout without threading `ClientOptions.timeout` through.

import type { ClientExtension, FetchImpl } from "../extension.ts"

export type TimeoutOptions = {
  /** Timeout in milliseconds, applied via `AbortSignal.timeout`. */
  readonly ms: number
}

/**
 * Fixed-timeout extension: aborts the request after `ms` milliseconds,
 * combined with any signal already on the request.
 *
 * @example
 * createClient(node, { baseUrl, extensions: [timeout({ ms: 5000 })] })
 */
export function timeout(options: TimeoutOptions): ClientExtension {
  const { ms } = options

  const wrapFetch = (inner: FetchImpl): FetchImpl => async (req: Request): Promise<Response> => {
    const timeoutSignal = AbortSignal.timeout(ms)
    // `Request.signal` is never `null` per spec (an unaborted default signal
    // when the caller didn't pass one) — always combine.
    const signal = AbortSignal.any([req.signal, timeoutSignal])
    const timedReq = new Request(req, { signal })
    try {
      return await inner(timedReq)
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`Request timed out after ${ms}ms: ${req.method} ${new URL(req.url).pathname}`)
      }
      throw err
    }
  }

  return {
    name: "timeout",
    wrapFetch,
    codegen: {
      helpers: TIMEOUT_CODEGEN_HELPERS,
      wrap: (innerExpr) => `__withTimeout(${innerExpr}, ${JSON.stringify({ ms })})`,
    },
  }
}

// ============================================================================
// Codegen helper source — mirrors `wrapFetch` above but against the platform
// `fetch(url, init)` shape (see codegen.ts's `__request`).
// ============================================================================

const TIMEOUT_CODEGEN_HELPERS = `
type __TimeoutOptions = { ms: number }

function __withTimeout(inner: typeof fetch, options: __TimeoutOptions): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const timeoutSignal = AbortSignal.timeout(options.ms)
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal
    try {
      return await inner(url, { ...init, signal })
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(\`Request timed out after \${options.ms}ms: \${url}\`)
      }
      throw err
    }
  }) as typeof fetch
}`.trim()
