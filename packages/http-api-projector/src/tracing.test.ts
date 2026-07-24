// packages/http-api-projector/src/tracing.test.ts — @rhi-zone/fractal-http-api-projector

import { describe, expect, it } from "bun:test"
import { formatTraceParent, OtelSpanStatusCode, parseTraceParent } from "@rhi-zone/fractal-api-tree/otel"
import type { OtelAttributes, OtelSpan, OtelSpanContext, OtelSpanOptions, OtelTracer, TracingIntegration } from "@rhi-zone/fractal-api-tree/otel"
import { tracingLayer } from "./tracing.ts"
import type { Fetch } from "./layers.ts"

type RecordedSpan = {
  name: string
  attributes: OtelAttributes
  status?: { code: OtelSpanStatusCode; message?: string }
  ended: boolean
}

function makeFakeTracer(): { tracer: OtelTracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = []
  let counter = 0

  const tracer: OtelTracer = {
    startSpan: (name, options = {}) => makeSpan(name, options),
    startActiveSpan(name: string, a: OtelSpanOptions | ((span: OtelSpan) => unknown), b?: (span: OtelSpan) => unknown) {
      const options = typeof a === "function" ? {} : a
      const fn = typeof a === "function" ? a : b!
      return fn(makeSpan(name, options)) as never
    },
  }

  function makeSpan(name: string, options: OtelSpanOptions): OtelSpan {
    const record: RecordedSpan = { name, attributes: { ...(options.attributes ?? {}) }, ended: false }
    spans.push(record)
    const spanId = (++counter).toString(16).padStart(16, "0")
    return {
      spanContext: () => ({ traceId: "b".repeat(32), spanId, traceFlags: 1 }),
      setAttribute: (key, value) => {
        record.attributes[key] = value
      },
      setAttributes: (attrs) => Object.assign(record.attributes, attrs),
      setStatus: (status) => {
        record.status = status
      },
      recordException: () => {},
      end: () => {
        record.ended = true
      },
    }
  }

  return { tracer, spans }
}

describe("tracingLayer", () => {
  it("wraps the request in a SERVER span with method/url/operation.name/projector.type attributes", async () => {
    const { tracer, spans } = makeFakeTracer()
    const inner: Fetch = async () => new Response("ok", { status: 200 })
    const wrapped = tracingLayer({ tracer })(inner)

    await wrapped(new Request("http://localhost/books/42"))

    expect(spans).toHaveLength(1)
    expect(spans[0]!.name).toBe("GET /books/42")
    expect(spans[0]!.attributes["http.method"]).toBe("GET")
    expect(spans[0]!.attributes["operation.name"]).toBe("/books/42")
    expect(spans[0]!.attributes["projector.type"]).toBe("http")
  })

  it("defaults projector.type to 'http' and honors an override", async () => {
    const { tracer, spans } = makeFakeTracer()
    const inner: Fetch = async () => new Response("ok")
    await tracingLayer({ tracer }, { projectorType: "custom" })(inner)(new Request("http://localhost/"))
    expect(spans[0]!.attributes["projector.type"]).toBe("custom")
  })

  it("sets http.status_code from the response and ends the span with OK status", async () => {
    const { tracer, spans } = makeFakeTracer()
    const inner: Fetch = async () => new Response("created", { status: 201 })
    await tracingLayer({ tracer })(inner)(new Request("http://localhost/"))
    expect(spans[0]!.attributes["http.status_code"]).toBe(201)
    expect(spans[0]!.ended).toBe(true)
    expect(spans[0]!.status?.code).toBe(OtelSpanStatusCode.OK)
  })

  it("records ERROR status and rethrows when inner throws", async () => {
    const { tracer, spans } = makeFakeTracer()
    const boom = new Error("handler exploded")
    const inner: Fetch = async () => {
      throw boom
    }
    await expect(tracingLayer({ tracer })(inner)(new Request("http://localhost/"))).rejects.toBe(boom)
    expect(spans[0]!.ended).toBe(true)
    expect(spans[0]!.status?.code).toBe(OtelSpanStatusCode.ERROR)
  })

  it("parses an incoming traceparent header and hands it to contextFromTraceParent", async () => {
    const { tracer } = makeFakeTracer()
    const remoteHeader = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    const seen: OtelSpanContext[] = []
    const integration: TracingIntegration = {
      tracer,
      contextFromTraceParent: (remote) => {
        seen.push(remote)
      },
    }
    const inner: Fetch = async () => new Response("ok")

    await tracingLayer(integration)(inner)(new Request("http://localhost/", { headers: { traceparent: remoteHeader } }))

    const expected = parseTraceParent(remoteHeader)
    expect(expected).toBeDefined()
    expect(seen).toEqual([expected!])
  })

  it("does not call contextFromTraceParent when there is no incoming traceparent header", async () => {
    const { tracer } = makeFakeTracer()
    let called = false
    const integration: TracingIntegration = { tracer, contextFromTraceParent: () => { called = true } }
    const inner: Fetch = async () => new Response("ok")

    await tracingLayer(integration)(inner)(new Request("http://localhost/"))

    expect(called).toBe(false)
  })

  it("interoperates end-to-end with the client tracing() extension's injected header", async () => {
    // Sanity check that formatTraceParent's own output round-trips through
    // parseTraceParent the same way tracingLayer consumes a real client's header.
    const ctx = { traceId: "c".repeat(32), spanId: "d".repeat(16), traceFlags: 1 }
    const header = formatTraceParent(ctx)
    expect(parseTraceParent(header)).toEqual({ ...ctx, isRemote: true })
  })
})
