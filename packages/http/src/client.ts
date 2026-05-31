// @rhi-zone/fractal-http/client
// The HTTP client adapter: an `httpTransport` (the client side of the unified
// transport core) plus `httpClient = clientOver(node, httpTransport(...))`.
//
// `httpTransport` mirrors the server adapter's wire contract exactly:
//   invoke → POST baseUrl + '/' + path.join('/'), JSON body = input,
//            2xx → { ok: true, value }, else → { ok: false, error }
//   stream → consume the response body as NDJSON, decoding one Result per line
//            (the format web.ts emits for streaming leaves)
//   meta?  → per-call request headers (this is how the old `httpClientWithHeaders`
//            feature survives — header injection is now just the meta slot)

import { clientOver, type Transport, type Meta } from '@rhi-zone/fractal-rpc-dispatch'
import type { AnyNode, Result, UClient } from '@rhi-zone/fractal-core'

/** Options accepted by `httpTransport` / `httpClient`. */
export interface HttpTransportOptions {
  /**
   * The fetch implementation to use. Defaults to `globalThis.fetch`. Inject a
   * custom implementation to run without a global `fetch` or to mock in tests.
   */
  fetch?: typeof globalThis.fetch
}

/** Map per-call `meta` onto request headers. Every meta entry is a header. */
const headersFromMeta = (meta?: Meta): Record<string, string> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      if (value !== undefined && value !== null) headers[key] = String(value)
    }
  }
  return headers
}

/**
 * Build an HTTP {@link Transport} over `baseUrl` (e.g. `http://127.0.0.1:3000`,
 * no trailing slash). The presence of `stream` advertises that this transport
 * can carry streaming leaves.
 */
export const httpTransport = (baseUrl: string, opts?: HttpTransportOptions): Transport => {
  const fetchFn = opts?.fetch ?? globalThis.fetch

  const urlFor = (path: readonly string[]): string => `${baseUrl}/${path.join('/')}`

  return {
    async invoke(path, input, meta) {
      const res = await fetchFn(urlFor(path), {
        method: 'POST',
        headers: headersFromMeta(meta),
        body: JSON.stringify(input),
      })
      const json = (await res.json()) as unknown
      return (res.ok
        ? { ok: true, value: json }
        : { ok: false, error: json }) as Result<unknown, unknown>
    },

    async *stream(path, input, meta) {
      const res = await fetchFn(urlFor(path), {
        method: 'POST',
        headers: headersFromMeta(meta),
        body: JSON.stringify(input),
      })
      if (!res.ok || res.body === null) {
        // A non-2xx (or bodyless) streaming response is a single error Result —
        // mirrors invoke's error decoding so callers see a uniform shape.
        const json = (await res.json().catch(() => ({ code: 'stream_failed', status: res.status }))) as unknown
        yield { ok: false, error: json } as Result<unknown, unknown>
        return
      }
      // Decode NDJSON: split the byte stream into newline-delimited JSON Results.
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let nl: number
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl)
            buffer = buffer.slice(nl + 1)
            if (line.length > 0) yield JSON.parse(line) as Result<unknown, unknown>
          }
        }
        // Flush any trailing line without a final newline.
        const tail = buffer.trim()
        if (tail.length > 0) yield JSON.parse(tail) as Result<unknown, unknown>
      } finally {
        // If the consumer stops early (break out of the for-await), cancel the
        // body so the server sees the disconnect and aborts its generator.
        await reader.cancel().catch(() => {})
      }
    },
  }
}

/**
 * Build a typed HTTP client over a node tree: `clientOver(node, httpTransport)`.
 * Streaming leaves return an `AsyncIterable<Result>`; unary leaves return a
 * `Promise<Result>`. Per-call `meta` becomes request headers.
 */
export const httpClient = <N extends AnyNode>(
  node: N,
  baseUrl: string,
  opts?: HttpTransportOptions,
): UClient<N> => clientOver(node, httpTransport(baseUrl, opts))
