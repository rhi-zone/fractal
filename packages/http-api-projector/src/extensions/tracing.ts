// packages/http-api-projector/src/extensions/tracing.ts — @rhi-zone/fractal-http-api-projector
//
// Built-in `ClientExtension`: an OpenTelemetry-COMPATIBLE CLIENT span per
// outgoing HTTP request, using the structural `OtelTracer`/`OtelSpan` types
// and `runClientSpan` helper from `@rhi-zone/fractal-api-tree/otel` — see
// that module's doc for why this package has no hard `@opentelemetry/api`
// dependency (a real `Tracer`, or a hand-written compatible object, both
// work; TypeScript's structural typing does the rest).
//
// Runtime-only, same reasoning as `interceptors.ts`/`logging.ts`'s custom
// hooks: a `Tracer` is a live object (its `startSpan`/`startActiveSpan`
// methods can't be serialized into generated source), so this extension has
// no `codegen` contribution — a generated client that wants tracing wires
// its own `tracer.startActiveSpan(...)` call around `__request(...)` by
// hand, same as any other codegen customization this package doesn't (and
// can't) auto-derive.
//
// Span naming/attributes follow OTel's HTTP semantic conventions loosely
// (`http.method`, `http.url`, `http.status_code`) — not a strict semconv
// implementation (no `http.route` template extraction, no `server.address`
// split out of the URL), enough to make the span useful without pulling in
// a semconv package this project doesn't otherwise need.
//
// See:
//   packages/http-api-projector/src/tracing.ts — server-side counterpart
//     (`tracingLayer`), which extracts the `traceparent` THIS extension
//     injects, on the receiving end.

import { formatTraceParent, runClientSpan } from "@rhi-zone/fractal-api-tree/otel"
import type { TracingIntegration } from "@rhi-zone/fractal-api-tree/otel"
import type { ClientExtension, FetchImpl } from "../extension.ts"

export type TracingOptions = TracingIntegration

/**
 * OpenTelemetry-compatible tracing extension: wraps every outgoing request
 * in a CLIENT span (`runClientSpan`), sets `http.method`/`http.url`/
 * `operation.name` (the request's URL path) up front and `http.status_code`
 * once a response arrives, and injects the span's own `spanContext()` into
 * a W3C `traceparent` header on the outgoing request — so a server that
 * also has tracing wired (e.g. `tracingLayer`, or any W3C-Trace-Context-
 * aware backend) links this call into the same trace.
 *
 * @example
 * import { trace } from "@opentelemetry/api"
 * createClient(node, { baseUrl, extensions: [tracing({ tracer: trace.getTracer("my-client") })] })
 */
export function tracing(options: TracingOptions): ClientExtension {
  const integration: TracingIntegration = options

  const wrapFetch = (inner: FetchImpl): FetchImpl => async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const spanName = `${req.method} ${url.pathname}`
    return runClientSpan(
      integration,
      spanName,
      { "http.method": req.method, "http.url": req.url, "operation.name": url.pathname },
      async (span) => {
        const headers = new Headers(req.headers)
        headers.set("traceparent", formatTraceParent(span.spanContext()))
        const tracedReq = new Request(req, { headers })
        const res = await inner(tracedReq)
        span.setAttribute("http.status_code", res.status)
        return res
      },
    )
  }

  return { name: "tracing", wrapFetch }
}
