// packages/http-api-projector/src/extensions/logging.ts — @rhi-zone/fractal-http-api-projector
//
// Built-in `ClientExtension`: structured request/response logging, with a
// generated request ID correlating each pair and sensitive-header
// redaction on by default. Same two-interpreter split as the other
// extensions (see extension.ts's module doc):
//   - `wrapFetch` operates on `(req: Request) => Promise<Response>` — reads
//     headers/body size directly off the `Request`/`Response`.
//   - `codegen.wrap` operates on generated source whose fetch impl has the
//     platform `fetch(url, init)` two-argument shape (see codegen.ts's
//     `__request`) — same log shape, built from `url`/`init` instead.
// Both share the same level filtering (`"debug"` logs everything including
// headers/body size, `"info"` logs a one-line request + response summary,
// `"warn"` logs only failed requests — a thrown error or a non-2xx response —
// `"none"` logs nothing) and the same default redacted-header set
// (Authorization, Cookie, Set-Cookie, X-API-Key — case-insensitive).
//
// `logger` (a custom sink) and `redactHeaders` (a custom predicate) are
// runtime-only, same reasoning as retry.ts's `retryOn`: functions have no
// general textual representation codegen could embed. The codegen path
// always logs via `console.log`/`console.error` and always uses the default
// redaction set; pass a custom `logger`/`redactHeaders` only when you don't
// also need codegen support for it.

import type { ClientExtension, FetchImpl } from "../extension.ts"

export type LogLevel = "debug" | "info" | "warn" | "none"

export type LogEntry =
  | {
      readonly kind: "request"
      readonly requestId: string
      readonly method: string
      readonly url: string
      readonly headers?: Readonly<Record<string, string>>
      readonly bodySize?: number
    }
  | {
      readonly kind: "response"
      readonly requestId: string
      readonly method: string
      readonly url: string
      readonly status: number
      readonly headers?: Readonly<Record<string, string>>
      readonly durationMs: number
    }
  | {
      readonly kind: "error"
      readonly requestId: string
      readonly method: string
      readonly url: string
      readonly error: unknown
      readonly durationMs: number
    }

export type LoggingOptions = {
  /** Minimum detail logged. Default `"info"`. */
  readonly level?: LogLevel
  /**
   * Sink invoked with each `LogEntry`. Defaults to `console.log` for
   * `"request"`/`"response"` entries and `console.error` for `"error"`
   * entries. Runtime-only — ignored by codegen (see module doc).
   */
  readonly logger?: (entry: LogEntry) => void
  /**
   * Given a lowercased header name, return `true` to redact its value as
   * `"[REDACTED]"`. Runtime-only — ignored by codegen (see module doc).
   * Defaults to `DEFAULT_SENSITIVE_HEADERS`.
   */
  readonly redactHeaders?: (headerName: string) => boolean
}

const DEFAULT_LEVEL: LogLevel = "info"

/** Case-insensitive default set of headers redacted in logged output. */
export const DEFAULT_SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
])

function defaultRedact(headerName: string): boolean {
  return DEFAULT_SENSITIVE_HEADERS.has(headerName.toLowerCase())
}

function redactedHeaders(headers: Headers, shouldRedact: (name: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, name) => {
    out[name] = shouldRedact(name) ? "[REDACTED]" : value
  })
  return out
}

function defaultLogger(entry: LogEntry): void {
  if (entry.kind === "error") {
    console.error(`[${entry.requestId}] ${entry.method} ${entry.url} failed after ${entry.durationMs}ms`, entry.error)
    return
  }
  if (entry.kind === "request") {
    console.log(`[${entry.requestId}] --> ${entry.method} ${entry.url}`, entry)
    return
  }
  console.log(`[${entry.requestId}] <-- ${entry.status} ${entry.method} ${entry.url} (${entry.durationMs}ms)`, entry)
}

function bodySize(req: Request): number | undefined {
  const contentLength = req.headers.get("Content-Length")
  return contentLength !== null ? Number(contentLength) : undefined
}

function generateRequestId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * Structured request/response logging extension. Logs a request line (and,
 * at `"debug"`, headers/body size), a response line with timing, or (at
 * `"warn"` and above) an error/non-2xx line — all correlated by a generated
 * request ID.
 *
 * @example
 * createClient(node, { baseUrl, extensions: [logging({ level: "info" })] })
 */
export function logging(options: LoggingOptions = {}): ClientExtension {
  const level = options.level ?? DEFAULT_LEVEL
  const log = options.logger ?? defaultLogger
  const shouldRedact = options.redactHeaders ?? defaultRedact

  const wrapFetch = (inner: FetchImpl): FetchImpl => async (req: Request): Promise<Response> => {
    if (level === "none") return inner(req)

    const requestId = generateRequestId()
    const method = req.method
    const url = req.url
    const start = performance.now()

    if (level === "debug" || level === "info") {
      const size = bodySize(req)
      log({
        kind: "request",
        requestId,
        method,
        url,
        ...(level === "debug"
          ? { headers: redactedHeaders(req.headers, shouldRedact), ...(size !== undefined ? { bodySize: size } : {}) }
          : {}),
      })
    }

    try {
      const res = await inner(req)
      const durationMs = performance.now() - start
      if (level === "debug" || level === "info") {
        log({
          kind: "response",
          requestId,
          method,
          url,
          status: res.status,
          durationMs,
          ...(level === "debug" ? { headers: redactedHeaders(res.headers, shouldRedact) } : {}),
        })
      } else if (level === "warn" && !res.ok) {
        log({ kind: "response", requestId, method, url, status: res.status, durationMs })
      }
      return res
    } catch (error) {
      const durationMs = performance.now() - start
      log({ kind: "error", requestId, method, url, error, durationMs })
      throw error
    }
  }

  return {
    name: "logging",
    wrapFetch,
    codegen: {
      helpers: LOGGING_CODEGEN_HELPERS,
      wrap: (innerExpr) => `__withLogging(${innerExpr}, ${JSON.stringify({ level })})`,
    },
  }
}

// ============================================================================
// Codegen helper source — emitted verbatim into generated client files that
// use `logging()`. Mirrors `wrapFetch` above but against the platform
// `fetch(url, init)` shape (see codegen.ts's `__request`); logs via
// `console.log`/`console.error` and uses the default redaction set (see
// module doc — `logger`/`redactHeaders` are runtime-only).
// ============================================================================

const LOGGING_CODEGEN_HELPERS = `
type __LoggingOptions = { level: "debug" | "info" | "warn" | "none" }

const __LOGGING_SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-api-key"])

function __loggingRedactedHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, name) => {
    out[name] = __LOGGING_SENSITIVE_HEADERS.has(name.toLowerCase()) ? "[REDACTED]" : value
  })
  return out
}

function __loggingRequestId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function __withLogging(inner: typeof fetch, options: __LoggingOptions): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (options.level === "none") return inner(url, init)

    const requestId = __loggingRequestId()
    const method = init?.method ?? "GET"
    const start = performance.now()

    if (options.level === "debug" || options.level === "info") {
      const headers = new Headers(init?.headers)
      const bodySize = typeof init?.body === "string" ? init.body.length : undefined
      console.log(\`[\${requestId}] --> \${method} \${url}\`, options.level === "debug"
        ? { requestId, method, url, headers: __loggingRedactedHeaders(headers), bodySize }
        : { requestId, method, url })
    }

    try {
      const res = await inner(url, init)
      const durationMs = performance.now() - start
      if (options.level === "debug" || options.level === "info") {
        console.log(\`[\${requestId}] <-- \${res.status} \${method} \${url} (\${durationMs}ms)\`, options.level === "debug"
          ? { requestId, method, url, status: res.status, durationMs, headers: __loggingRedactedHeaders(res.headers) }
          : { requestId, method, url, status: res.status, durationMs })
      } else if (options.level === "warn" && !res.ok) {
        console.log(\`[\${requestId}] <-- \${res.status} \${method} \${url} (\${durationMs}ms)\`, { requestId, method, url, status: res.status, durationMs })
      }
      return res
    } catch (error) {
      const durationMs = performance.now() - start
      console.error(\`[\${requestId}] \${method} \${url} failed after \${durationMs}ms\`, error)
      throw error
    }
  }) as typeof fetch
}`.trim()
