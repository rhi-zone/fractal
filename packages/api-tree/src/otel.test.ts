// packages/api-tree/src/otel.test.ts — otel.ts
//
// Covers the two independent halves of otel.ts:
//   - W3C traceparent parse/format (pure, no ALS)
//   - runServerSpan/runClientSpan/getActiveSpan lifecycle (a fake OtelTracer
//     test double, proving span start/end/status/exception recording without
//     any real @opentelemetry/api dependency — exactly the point of the
//     structural-typing design)
//   - wrapTracing wiring spans around every leaf of a Node tree, mirroring
//     build.ts's wrapValidators.test.ts style

import { describe, expect, it } from "bun:test"
import { api, op } from "./node.ts"
import {
  formatTraceParent,
  getActiveSpan,
  OtelSpanStatusCode,
  parseTraceParent,
  runClientSpan,
  runServerSpan,
  wrapTracing,
} from "./otel.ts"
import type { OtelAttributes, OtelSpan, OtelSpanContext, OtelSpanOptions, OtelTracer, TracingIntegration } from "./otel.ts"

// ============================================================================
// Fake tracer/span test double — the "consumer with no real OTel SDK" case
// this module is designed to support.
// ============================================================================

type RecordedSpan = {
  name: string
  options: OtelSpanOptions
  attributes: OtelAttributes
  status?: { code: OtelSpanStatusCode; message?: string }
  ended: boolean
  exceptions: unknown[]
}

function makeFakeTracer(): { tracer: OtelTracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = []
  let counter = 0

  const tracer: OtelTracer = {
    startSpan(name, options = {}) {
      return makeSpan(name, options)
    },
    startActiveSpan(name: string, optionsOrFn: OtelSpanOptions | ((span: OtelSpan) => unknown), fn?: (span: OtelSpan) => unknown) {
      const options = typeof optionsOrFn === "function" ? {} : optionsOrFn
      const callback = typeof optionsOrFn === "function" ? optionsOrFn : fn!
      const span = makeSpan(name, options)
      return callback(span) as never
    },
  }

  function makeSpan(name: string, options: OtelSpanOptions): OtelSpan {
    const record: RecordedSpan = {
      name,
      options,
      attributes: { ...(options.attributes ?? {}) },
      ended: false,
      exceptions: [],
    }
    spans.push(record)
    const spanId = (++counter).toString(16).padStart(16, "0")
    return {
      spanContext: () => ({ traceId: "1".repeat(32), spanId, traceFlags: 1 }),
      setAttribute: (key, value) => {
        record.attributes[key] = value
      },
      setAttributes: (attrs) => {
        Object.assign(record.attributes, attrs)
      },
      setStatus: (status) => {
        record.status = status
      },
      recordException: (exception) => {
        record.exceptions.push(exception)
      },
      end: () => {
        record.ended = true
      },
    }
  }

  return { tracer, spans }
}

// ============================================================================
// W3C traceparent
// ============================================================================

describe("parseTraceParent / formatTraceParent", () => {
  it("round-trips a valid header", () => {
    const header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    const ctx = parseTraceParent(header)
    expect(ctx).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
      isRemote: true,
    })
    expect(formatTraceParent(ctx!)).toBe(header)
  })

  it("lowercases a mixed-case header", () => {
    const ctx = parseTraceParent("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01")
    expect(ctx?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
    expect(ctx?.spanId).toBe("00f067aa0ba902b7")
  })

  it("returns undefined for a missing/null/malformed header", () => {
    expect(parseTraceParent(undefined)).toBeUndefined()
    expect(parseTraceParent(null)).toBeUndefined()
    expect(parseTraceParent("")).toBeUndefined()
    expect(parseTraceParent("not-a-traceparent")).toBeUndefined()
    expect(parseTraceParent("00-tooshort-00f067aa0ba902b7-01")).toBeUndefined()
  })

  it("returns undefined for the reserved 'ff' version", () => {
    expect(parseTraceParent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeUndefined()
  })

  it("returns undefined for an all-zero trace-id or span-id", () => {
    expect(parseTraceParent(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`)).toBeUndefined()
    expect(parseTraceParent(`00-4bf92f3577b34da6a3ce929d0e0e4736-${"0".repeat(16)}-01`)).toBeUndefined()
  })
})

// ============================================================================
// runServerSpan / runClientSpan / getActiveSpan
// ============================================================================

describe("runServerSpan", () => {
  it("starts a SERVER-kind span with the given name and attributes, ends it, and sets OK status on success", async () => {
    const { tracer, spans } = makeFakeTracer()
    const integration: TracingIntegration = { tracer }

    const result = await runServerSpan(integration, "http:books/read", { "operation.name": "books/read" }, undefined, async () => {
      return "value"
    })

    expect(result).toBe("value")
    expect(spans).toHaveLength(1)
    expect(spans[0]!.name).toBe("http:books/read")
    expect(spans[0]!.attributes["operation.name"]).toBe("books/read")
    expect(spans[0]!.ended).toBe(true)
    expect(spans[0]!.status?.code).toBe(OtelSpanStatusCode.OK)
  })

  it("records the exception and sets ERROR status when fn's promise rejects, then rethrows", async () => {
    const { tracer, spans } = makeFakeTracer()
    const integration: TracingIntegration = { tracer }
    const boom = new Error("boom")

    await expect(
      runServerSpan(integration, "op", {}, undefined, async () => {
        throw boom
      }),
    ).rejects.toBe(boom)

    expect(spans[0]!.ended).toBe(true)
    expect(spans[0]!.status?.code).toBe(OtelSpanStatusCode.ERROR)
    expect(spans[0]!.exceptions).toEqual([boom])
  })

  it("records the exception and sets ERROR status when fn throws synchronously, then rethrows", () => {
    const { tracer, spans } = makeFakeTracer()
    const integration: TracingIntegration = { tracer }
    const boom = new Error("sync boom")

    expect(() =>
      runServerSpan(integration, "op", {}, undefined, () => {
        throw boom
      }),
    ).toThrow(boom)

    expect(spans[0]!.ended).toBe(true)
    expect(spans[0]!.status?.code).toBe(OtelSpanStatusCode.ERROR)
  })

  it("makes the span readable via getActiveSpan() for the duration of fn, and undefined outside it", async () => {
    const { tracer } = makeFakeTracer()
    const integration: TracingIntegration = { tracer }

    expect(getActiveSpan()).toBeUndefined()
    let seenInside: OtelSpan | undefined
    await runServerSpan(integration, "op", {}, undefined, async (span) => {
      seenInside = getActiveSpan()
      expect(seenInside).toBe(span)
    })
    expect(getActiveSpan()).toBeUndefined()
    expect(seenInside).toBeDefined()
  })

  it("calls contextFromTraceParent with the incoming remote context when supplied", async () => {
    const { tracer } = makeFakeTracer()
    const seen: OtelSpanContext[] = []
    const integration: TracingIntegration = {
      tracer,
      contextFromTraceParent: (remote) => {
        seen.push(remote)
      },
    }
    const remote = parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")!

    await runServerSpan(integration, "op", {}, remote, async () => "x")

    expect(seen).toEqual([remote])
  })

  it("does not call contextFromTraceParent when there is no incoming trace context", async () => {
    const { tracer } = makeFakeTracer()
    let called = false
    const integration: TracingIntegration = { tracer, contextFromTraceParent: () => { called = true } }

    await runServerSpan(integration, "op", {}, undefined, async () => "x")

    expect(called).toBe(false)
  })
})

describe("runClientSpan", () => {
  it("starts a CLIENT-kind span and ends it on success", async () => {
    const { tracer, spans } = makeFakeTracer()
    const integration: TracingIntegration = { tracer }

    const result = await runClientSpan(integration, "GET /books", { "http.method": "GET" }, async () => 42)

    expect(result).toBe(42)
    expect(spans[0]!.name).toBe("GET /books")
    expect(spans[0]!.attributes["http.method"]).toBe("GET")
    expect(spans[0]!.ended).toBe(true)
    expect(spans[0]!.status?.code).toBe(OtelSpanStatusCode.OK)
  })
})

// ============================================================================
// wrapTracing
// ============================================================================

describe("wrapTracing", () => {
  it("wraps every leaf handler so its invocation produces a span named after its tree path", async () => {
    const { tracer, spans } = makeFakeTracer()
    const integration: TracingIntegration = { tracer }

    const tree = api({
      books: api({
        read: op((input: { id: string }) => ({ id: input.id, title: "t" })),
        list: op(() => []),
      }),
    })

    const traced = wrapTracing(tree, integration, { projectorType: "http" })

    const readHandler = traced.children!.books!.children!.read!.handler!
    await readHandler({ id: "1" })
    const listHandler = traced.children!.books!.children!.list!.handler!
    await listHandler({})

    expect(spans.map((s) => s.name).sort()).toEqual(["http:books/list", "http:books/read"])
    expect(spans.every((s) => s.attributes["projector.type"] === "http")).toBe(true)
    expect(spans.find((s) => s.name === "http:books/read")?.attributes["operation.name"]).toBe("books/read")
    expect(spans.every((s) => s.ended)).toBe(true)
  })

  it("omits the projector.type attribute and name prefix when projectorType is not given", async () => {
    const { tracer, spans } = makeFakeTracer()
    const integration: TracingIntegration = { tracer }
    const tree = api({ ping: op(() => "pong") })

    const traced = wrapTracing(tree, integration)
    await traced.children!.ping!.handler!({})

    expect(spans[0]!.name).toBe("ping")
    expect(spans[0]!.attributes["projector.type"]).toBeUndefined()
  })

  it("does not mutate the original tree", () => {
    const { tracer } = makeFakeTracer()
    const integration: TracingIntegration = { tracer }
    const tree = api({ ping: op(() => "pong") })
    const originalHandler = tree.children!.ping!.handler

    wrapTracing(tree, integration, { projectorType: "cli" })

    expect(tree.children!.ping!.handler).toBe(originalHandler)
  })

  it("propagates a thrown/rejected handler error unchanged, still ending the span with ERROR status", async () => {
    const { tracer, spans } = makeFakeTracer()
    const integration: TracingIntegration = { tracer }
    const boom = new Error("handler failed")
    const tree = api({
      fail: op(() => {
        throw boom
      }),
    })

    const traced = wrapTracing(tree, integration, { projectorType: "mcp" })

    await expect(Promise.resolve().then(() => traced.children!.fail!.handler!({}))).rejects.toBe(boom)
    expect(spans[0]!.ended).toBe(true)
    expect(spans[0]!.status?.code).toBe(OtelSpanStatusCode.ERROR)
  })
})
