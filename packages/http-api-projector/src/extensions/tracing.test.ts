// packages/http-api-projector/src/extensions/tracing.test.ts — @rhi-zone/fractal-http-api-projector

import { describe, expect, it } from "bun:test"
import { OtelSpanStatusCode } from "@rhi-zone/fractal-api-tree/otel"
import type { OtelAttributes, OtelSpan, OtelSpanOptions, OtelTracer } from "@rhi-zone/fractal-api-tree/otel"
import { composeFetch } from "../extension.ts"
import { tracing } from "./tracing.ts"

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
      spanContext: () => ({ traceId: "a".repeat(32), spanId, traceFlags: 1 }),
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

describe("tracing (client extension)", () => {
  it("wraps the request in a CLIENT span with method/url/operation.name attributes", async () => {
    const { tracer, spans } = makeFakeTracer()
    const base = async () => new Response("ok", { status: 200 })
    const wrapped = composeFetch(base, [tracing({ tracer })])

    await wrapped(new Request("http://localhost/books/42"))

    expect(spans).toHaveLength(1)
    expect(spans[0]!.name).toBe("GET /books/42")
    expect(spans[0]!.attributes["http.method"]).toBe("GET")
    expect(spans[0]!.attributes["http.url"]).toBe("http://localhost/books/42")
    expect(spans[0]!.attributes["operation.name"]).toBe("/books/42")
  })

  it("sets http.status_code from the response and ends the span with OK status", async () => {
    const { tracer, spans } = makeFakeTracer()
    const base = async () => new Response("ok", { status: 201 })
    const wrapped = composeFetch(base, [tracing({ tracer })])

    await wrapped(new Request("http://localhost/"))

    expect(spans[0]!.attributes["http.status_code"]).toBe(201)
    expect(spans[0]!.ended).toBe(true)
    expect(spans[0]!.status?.code).toBe(OtelSpanStatusCode.OK)
  })

  it("injects a traceparent header derived from the span's own spanContext()", async () => {
    const { tracer } = makeFakeTracer()
    let seenHeader: string | null = null
    const base = async (req: Request) => {
      seenHeader = req.headers.get("traceparent")
      return new Response("ok")
    }
    const wrapped = composeFetch(base, [tracing({ tracer })])

    await wrapped(new Request("http://localhost/"))

    expect(seenHeader).toMatch(/^00-a{32}-[0-9a-f]{16}-01$/)
  })

  it("records ERROR status and rethrows when the inner fetch throws", async () => {
    const { tracer, spans } = makeFakeTracer()
    const boom = new Error("network down")
    const base = async (): Promise<Response> => {
      throw boom
    }
    const wrapped = composeFetch(base, [tracing({ tracer })])

    await expect(wrapped(new Request("http://localhost/"))).rejects.toBe(boom)
    expect(spans[0]!.ended).toBe(true)
    expect(spans[0]!.status?.code).toBe(OtelSpanStatusCode.ERROR)
  })

  it("has no codegen hook (runtime-only, see module doc)", () => {
    const { tracer } = makeFakeTracer()
    expect(tracing({ tracer }).codegen).toBeUndefined()
  })
})
