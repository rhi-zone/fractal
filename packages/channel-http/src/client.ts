// @rhi-zone/fractal-channel-http/client
// The HTTP client adapter, RE-EXPRESSED through the three transport axes:
//
//   httpTransport = composeRequestResponse(httpExchange(baseUrl), jsonCodec)
//
// HTTP is no longer a special-cased transport: it is `requestResponse` (the
// one-shot protocol) × `jsonCodec` (the encoding) × an `httpExchange` (the
// request/response medium — the CHANNEL axis for HTTP). The medium owns URL
// addressing, HTTP status, and NDJSON medium-framing; the codec owns JSON; the
// protocol owns the value↔Result mapping. The wire contract is byte-identical to
// the prior hand-rolled transport:
//   invoke → POST baseUrl + '/' + path.join('/'), JSON body = input,
//            2xx → { ok: true, value }, else → { ok: false, error }
//   stream → consume the response body as NDJSON, decoding one Result per line
//   meta?  → per-call request headers

import {
  clientOver,
  composeRequestResponse,
  type Exchange,
  type ExchangeResponse,
  type Meta,
  type Transport,
} from '@rhi-zone/fractal-transport'
import { jsonCodec } from '@rhi-zone/fractal-codec-json'
import type { AnyNode, UClient } from '@rhi-zone/fractal-core'

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
 * The HTTP CHANNEL axis: a request/response {@link Exchange} over `baseUrl`
 * (e.g. `http://127.0.0.1:3000`, no trailing slash). It moves already-encoded
 * (JSON string) wire bodies, owns URL addressing + HTTP status + NDJSON
 * medium-framing, and knows nothing of Result shapes (that is the protocol's
 * job). Wire unit `W = string` (matching {@link jsonCodec}).
 */
export const httpExchange = (baseUrl: string, opts?: HttpTransportOptions): Exchange<string> => {
  const fetchFn = opts?.fetch ?? globalThis.fetch
  const urlFor = (path: readonly string[]): string => `${baseUrl}/${path.join('/')}`

  return {
    async unary(path, body, meta): Promise<ExchangeResponse<string>> {
      const res = await fetchFn(urlFor(path), {
        method: 'POST',
        headers: headersFromMeta(meta),
        body,
      })
      // Return the raw response text + the medium's success flag; the protocol
      // decodes the body and maps ok-ness onto the Result.
      return { ok: res.ok, body: await res.text() }
    },

    async *stream(path, body, meta): AsyncIterable<string> {
      const res = await fetchFn(urlFor(path), {
        method: 'POST',
        headers: headersFromMeta(meta),
        body,
      })
      if (!res.ok || res.body === null) {
        // A non-2xx (or bodyless) streaming response is a single error Result —
        // mirrors invoke's error decoding so callers see a uniform shape. Emit
        // one encoded line whose decode yields `{ ok:false, error }`.
        const errBody = (await res.json().catch(() => ({ code: 'stream_failed', status: res.status }))) as unknown
        yield JSON.stringify({ ok: false, error: errBody })
        return
      }
      // Decode NDJSON medium-framing: split the byte stream into newline-
      // delimited units; each unit is one encoded `Result` line (the protocol's
      // codec parses it). Framing is the medium's job; parsing is the codec's.
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
            if (line.length > 0) yield line
          }
        }
        // Flush any trailing line without a final newline.
        const tail = buffer.trim()
        if (tail.length > 0) yield tail
      } finally {
        // If the consumer stops early (break out of the for-await), cancel the
        // body so the server sees the disconnect and aborts its generator.
        await reader.cancel().catch(() => {})
      }
    },
  }
}

/**
 * Build an HTTP {@link Transport} over `baseUrl`. Sugar for
 * `composeRequestResponse(httpExchange(baseUrl), jsonCodec)`. The presence of
 * `stream` advertises that this transport can carry streaming leaves.
 */
export const httpTransport = (baseUrl: string, opts?: HttpTransportOptions): Transport =>
  composeRequestResponse(httpExchange(baseUrl, opts), jsonCodec)

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
