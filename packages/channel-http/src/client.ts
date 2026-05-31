// @rhi-zone/fractal-channel-http/client
// The HTTP CHANNEL axis (client side), expressed through the three transport
// axes. HTTP is not a special-cased transport: it is the request/response
// protocol form (`composeRequestResponse`) × a codec × an `httpExchange` (the
// request/response MEDIUM — the CHANNEL axis for HTTP).
//
// SELF-COMPOSE (no preset needed — this IS the preset):
//
//   clientOver(node, composeRequestResponse(httpExchange(baseUrl), jsonCodec))
//
// The medium owns URL addressing, HTTP status, and NDJSON medium-framing; the
// codec owns the value encoding; the protocol owns the value↔Result mapping. The
// wire contract:
//   invoke → POST baseUrl + '/' + path.join('/'), body = encoded input,
//            2xx → { ok: true, value }, else → { ok: false, error }
//   stream → consume the response body as NDJSON, one encoded Result per line
//   meta?  → per-call request headers

import {
  type Exchange,
  type ExchangeResponse,
  type Codec,
  type Meta,
} from '@rhi-zone/fractal-transport'
import { jsonCodec } from '@rhi-zone/fractal-codec-json'

/** Options accepted by `httpExchange`. */
export interface HttpTransportOptions {
  /**
   * The fetch implementation to use. Defaults to `globalThis.fetch`. Inject a
   * custom implementation to run without a global `fetch` or to mock in tests.
   */
  fetch?: typeof globalThis.fetch
  /**
   * The textual codec, used ONLY to synthesize a framed error Result when a
   * streaming request gets a non-2xx (or bodyless) response — the one spot the
   * medium must MINT a `Result` rather than relay a server-framed one. Defaults
   * to {@link jsonCodec}; pass the same codec you compose the transport with.
   */
  codec?: Codec<string>
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
 * (string) wire bodies, owns URL addressing + HTTP status + NDJSON medium-
 * framing, and knows nothing of Result shapes (that is the protocol's job).
 * Wire unit `W = string`. Compose it with a `Codec<string>`:
 *
 *   composeRequestResponse(httpExchange(baseUrl), jsonCodec)
 */
export const httpExchange = (baseUrl: string, opts?: HttpTransportOptions): Exchange<string> => {
  const fetchFn = opts?.fetch ?? globalThis.fetch
  const codec = opts?.codec ?? jsonCodec
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
        // mirrors invoke's error decoding so callers see a uniform shape. The
        // medium MINTS the framed Result here (the one spot it must), encoding it
        // with the codec so the protocol's `codec.decode` round-trips it.
        const errText = await res.text().catch(() => '')
        const errBody = errText === '' ? { code: 'stream_failed', status: res.status } : codec.decode(errText)
        yield codec.encode({ ok: false, error: errBody })
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
