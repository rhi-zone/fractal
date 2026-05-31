// @rhi-zone/fractal-channel-http/web
// Runtime-neutral Web-standard handler — the single HTTP entry point.
// Uses ONLY Web Platform APIs (Request, Response, URL, Headers, ReadableStream);
// runtime adapters (bun.ts, node.ts) wrap it as thin shims.
//
// This is an ADAPTER over the unified `Dispatcher` (rpc-dispatch): it decodes a
// Request into a DispatchRequest, calls dispatch, and frames the outcome:
//
//   unary  → Response(JSON, errorStatus)
//   stream → a chunked HTTP body of NDJSON-framed Results, aborting the server
//            generator when the client disconnects (request.signal)
//
// NDJSON (newline-delimited JSON) is the stream wire format: one JSON-encoded
// Result per line. Chosen over SSE for framing simplicity — the client is a
// fetch reader, not a browser EventSource, so SSE's event/data ceremony and
// text/event-stream semantics buy nothing here; one `JSON.stringify(result) +
// "\n"` per item is the whole protocol.

import type { AnyNode } from '@rhi-zone/fractal-core'
import type { Meta } from '@rhi-zone/fractal-transport'
import { buildDispatcher, toDispatchRequest, defaultErrorStatus, type ServeOptions, type HttpRequestLike } from './index.ts'

export interface WebHandlerOptions extends ServeOptions {
  // No additional options at the web layer for now; extend here as needed.
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
 * unified Dispatcher. Works as-is in Bun, Cloudflare Workers, Deno, and any
 * runtime that speaks the Web Fetch API. Node needs the bridge in node.ts.
 */
export const toWebHandler = (
  tree: AnyNode,
  options: WebHandlerOptions = {},
): ((request: Request) => Promise<Response>) => {
  const dispatch = buildDispatcher(tree, options)
  const errorStatus = options.errorStatus ?? defaultErrorStatus

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const segments = url.pathname.split('/').filter(Boolean)

    let body: unknown = undefined
    const ct = request.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) {
      try {
        body = await request.json()
      } catch {
        body = undefined
      }
    }

    const httpReq: HttpRequestLike = {
      method: request.method,
      segments,
      body,
      signal: request.signal,
      headers: request.headers,
    }
    const meta = metaFromHeaders(request.headers)
    const outcome = await dispatch(toDispatchRequest(httpReq, meta))

    if (outcome.kind === 'unary') {
      const result = outcome.result
      const status = result.ok ? 200 : errorStatus(result.error)
      const payload = result.ok ? result.value : result.error
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }

    // Streaming outcome: frame each Result as one NDJSON line. The server
    // generator is driven by the ReadableStream's pull; when the client
    // disconnects, request.signal aborts and we stop pulling + close the
    // iterator (which propagates cancellation into evaluateStream, whose loop
    // checks ctx.signal before each yield).
    const encoder = new TextEncoder()
    const iterator = outcome.stream[Symbol.asyncIterator]()
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
        controller.enqueue(encoder.encode(JSON.stringify(value) + '\n'))
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
