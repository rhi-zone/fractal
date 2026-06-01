// @rhi-zone/fractal-channel-http/web
// Runtime-neutral Web-standard handler — the single HTTP entry point.
// Uses ONLY Web Platform APIs (Request, Response, URL, Headers, ReadableStream);
// runtime adapters (bun.ts, node.ts) wrap it as thin shims.
//
// This is an ADAPTER over the request-response SERVER assembler
// (`serveExchange`, the request-response analogue of `attach`). The codec seam
// lives in `serveExchange`: this file decodes/encodes NOTHING by hand. It owns
// only HTTP-MEDIUM concerns:
//
//   request  → URL path → segments; raw text body → encoded wire unit `W`;
//              headers → meta + grant-visible extras
//   unary    → Response(encoded body, errorStatus mapped from the Result)
//   stream   → a chunked HTTP body of NDJSON-framed encoded units, aborting the
//              server generator when the client disconnects (request.signal)
//
// NDJSON (newline-delimited JSON) is the stream wire format: one encoded Result
// per line. Chosen over SSE for framing simplicity — the client is a fetch
// reader, not a browser EventSource, so SSE's event/data ceremony buys nothing
// here; one encoded unit + "\n" per item is the whole protocol.
//
// CODEC: the JSON codec is the default (HTTP's historical wire format). It is a
// PARAMETER — pass any `Codec<string>` to serve a different textual encoding
// over HTTP without touching this file.

import type { AnyNode } from '@rhi-zone/fractal-core'
import {
  serveExchange,
  type Codec,
  type EncodedRequest,
  type Meta,
} from '@rhi-zone/fractal-transport'
import { jsonCodec } from '@rhi-zone/fractal-codec-json'
import { defaultErrorStatus, type ServeOptions, type HttpRequestLike } from './index.ts'

export interface WebHandlerOptions extends ServeOptions {
  /**
   * The textual codec for request/response bodies. Defaults to {@link jsonCodec}
   * (HTTP's historical wire format). Supply any `Codec<string>` to serve a
   * different encoding — the handler itself encodes/decodes nothing by hand.
   */
  readonly codec?: Codec<string>
}

/** Content-type marking an NDJSON stream of framed Results. */
export const NDJSON_CONTENT_TYPE = 'application/x-ndjson'

/** Per-call metadata threaded from request headers: every header becomes a meta entry. */
const metaFromHeaders = (headers: Headers): Meta => {
  const meta: Record<string, unknown> = {}
  headers.forEach((value, key) => {
    meta[key] = value
  })
  return meta
}

/**
 * Build a Web-standard request handler over a fractal node tree, over the
 * request-response server assembler (`serveExchange`). Works as-is in Bun,
 * Cloudflare Workers, Deno, and any runtime that speaks the Web Fetch API. Node
 * needs the bridge in node.ts.
 */
export const toWebHandler = (
  tree: AnyNode,
  options: WebHandlerOptions = {},
): ((request: Request) => Promise<Response>) => {
  const codec = options.codec ?? jsonCodec
  const handle = serveExchange<string, HttpRequestLike>(
    tree,
    codec,
    options.grants ? { grants: options.grants } : {},
  )
  const errorStatus = options.errorStatus ?? defaultErrorStatus

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const segments = url.pathname.split('/').filter(Boolean)

    // The medium hands the raw text body to the codec as the encoded wire unit.
    // An empty body is the codec's "no value" (jsonCodec: '' → undefined).
    const bodyText = await request.text()

    const meta = metaFromHeaders(request.headers)
    // The transport-native HTTP request, threaded through to grants via `raw`
    // (CapGrants read `headers`/`segments`/`method` off it).
    const raw: HttpRequestLike = {
      method: request.method,
      segments,
      body: bodyText,
      headers: request.headers,
      ...(request.signal ? { signal: request.signal } : {}),
    }
    const req: EncodedRequest<string, HttpRequestLike> = {
      path: segments,
      body: bodyText,
      meta,
      method: request.method,
      raw,
      ...(request.signal ? { signal: request.signal } : {}),
    }
    const outcome = await handle(req)

    if (outcome.kind === 'unary') {
      const status = outcome.result.ok ? 200 : errorStatus(outcome.result.error)
      return new Response(outcome.body, {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }

    // Streaming outcome: frame each ENCODED unit as one NDJSON line. The server
    // generator is driven by the ReadableStream's pull; when the client
    // disconnects, request.signal aborts and we stop pulling + close the
    // iterator (which propagates cancellation into evaluateStream).
    const encoder = new TextEncoder()
    const iterator = outcome.units[Symbol.asyncIterator]()
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (request.signal?.aborted) {
          await iterator.return?.(undefined)
          controller.close()
          return
        }
        const { value, done } = await iterator.next()
        if (done) {
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(value + '\n'))
      },
      async cancel() {
        // Client disconnected mid-stream — stop the server generator.
        await iterator.return?.(undefined)
      },
    })

    return new Response(stream, {
      status: 200,
      headers: { 'content-type': NDJSON_CONTENT_TYPE },
    })
  }
}
