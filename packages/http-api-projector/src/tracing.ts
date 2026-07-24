// packages/http-api-projector/src/tracing.ts — @rhi-zone/fractal-http-api-projector
//
// Server-side counterpart to `extensions/tracing.ts`'s client `tracing()`:
// `tracingLayer` is a `(inner: Fetch) => Fetch` layer (same shape as
// `layers.ts`'s `autoMethodLayer`/`corsLayer`, drop into `PresetOptions.
// middleware`) that creates one SERVER span per incoming request, extracting
// an incoming W3C `traceparent` header (via `@rhi-zone/fractal-api-tree/
// otel`'s `parseTraceParent`) so a request traced by `tracing()` — or any
// other W3C-Trace-Context-aware caller — links into the same trace.
//
// This is the REQUEST-level span (method, URL, status code — everything
// only visible with the raw `Request`/`Response` in hand). The OPERATION-
// level span (one per matched leaf, named after its tree path) comes from
// `@rhi-zone/fractal-api-tree/otel`'s `wrapTracing`, applied to the tree
// BEFORE it's handed to `createFetch` — same protocol-neutral mechanism
// CLI/MCP/GraphQL use, see that module's doc. Used together, a traced
// request nests as: `tracingLayer`'s request span → `wrapTracing`'s
// operation span → the handler itself — same nesting a "gateway + RPC
// handler" trace has in any polyglot backend.
//
// See:
//   packages/http-api-projector/src/extensions/tracing.ts — client-side
//     counterpart (`tracing()`), which sends the `traceparent` header this
//     layer reads.
//   packages/api-tree/src/otel.ts                          — shared types,
//     `runServerSpan`, `wrapTracing`.

import { parseTraceParent, runServerSpan } from "@rhi-zone/fractal-api-tree/otel"
import type { TracingIntegration } from "@rhi-zone/fractal-api-tree/otel"
import type { Fetch } from "./layers.ts"

export type HttpTracingOptions = {
  /** Value for the span's `projector.type` attribute. Default `"http"`. */
  readonly projectorType?: string
}

/**
 * Request-level tracing layer: wraps `inner` in a SERVER span named
 * `"<METHOD> <path>"`, with `http.method`/`http.url`/`operation.name`
 * (the URL path) attributes set up front and `http.status_code` set once
 * `inner` resolves. Extracts an incoming `traceparent` header (if present
 * and valid) and hands it to `integration.contextFromTraceParent` (when
 * supplied) so the new span parents under the caller's trace.
 *
 * @example
 * import { trace, context } from "@opentelemetry/api"
 * const integration = {
 *   tracer: trace.getTracer("my-server"),
 *   contextFromTraceParent: (remote) => trace.setSpanContext(context.active(), remote),
 * }
 * createFetch(tree, { middleware: [tracingLayer(integration)] })
 */
export function tracingLayer(integration: TracingIntegration, options: HttpTracingOptions = {}): (inner: Fetch) => Fetch {
  const projectorType = options.projectorType ?? "http"
  return (inner) => async (req) => {
    const url = new URL(req.url)
    const spanName = `${req.method} ${url.pathname}`
    const incoming = parseTraceParent(req.headers.get("traceparent"))
    return runServerSpan(
      integration,
      spanName,
      {
        "http.method": req.method,
        "http.url": req.url,
        "operation.name": url.pathname,
        "projector.type": projectorType,
      },
      incoming,
      async (span) => {
        const res = await inner(req)
        span.setAttribute("http.status_code", res.status)
        return res
      },
    )
  }
}
