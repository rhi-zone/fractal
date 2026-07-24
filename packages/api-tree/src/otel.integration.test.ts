// packages/api-tree/src/otel.integration.test.ts — otel.ts's wrapTracing,
// proven against all four real projectors — same cross-projector-proof
// style as context.test.ts, but for `wrapTracing` instead of `createContext`:
// ONE `wrapTracing(tree, integration, { projectorType })` call per surface,
// wired in BEFORE the tree reaches `createFetch`/`runCli`/`createMcpServer`/
// `createGraphQLServer` (mirroring `wrapValidators`'s own call-site
// convention), produces one span per handler invocation with the expected
// `projector.type` attribute, and `getActiveSpan()` is readable from INSIDE
// the handler — proving a handler can create its own child span downstream.

import { describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { runCli } from "@rhi-zone/fractal-cli-api-projector"
import { createGraphQLServer } from "@rhi-zone/fractal-graphql-api-projector"
import { createFetch } from "@rhi-zone/fractal-http-api-projector/preset"
import { createMcpServer } from "@rhi-zone/fractal-mcp-api-projector"
import { api as api_, op } from "./node.ts"
import { getActiveSpan, wrapTracing } from "./otel.ts"
import type { OtelAttributes, OtelSpan, OtelSpanOptions, OtelTracer, TracingIntegration } from "./otel.ts"

type RecordedSpan = { name: string; attributes: OtelAttributes; ended: boolean }

function makeFakeTracer(): { tracer: OtelTracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = []

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
    return {
      spanContext: () => ({ traceId: "e".repeat(32), spanId: "f".repeat(16), traceFlags: 1 }),
      setAttribute: (key, value) => {
        record.attributes[key] = value
      },
      setAttributes: (attrs) => Object.assign(record.attributes, attrs),
      setStatus: () => {},
      recordException: () => {},
      end: () => {
        record.ended = true
      },
    }
  }

  return { tracer, spans }
}

describe("wrapTracing — cross-projector integration", () => {
  it("produces one HTTP-tagged span per request, ended, with getActiveSpan() readable inside the handler", async () => {
    const { tracer, spans } = makeFakeTracer()
    const integration: TracingIntegration = { tracer }
    let sawSpanInsideHandler: OtelSpan | undefined
    const tree = api_({
      whoami: op(
        (_: unknown) => {
          sawSpanInsideHandler = getActiveSpan()
          return { ok: true }
        },
        { http: { directives: [{ kind: "method", value: "GET" }] } },
      ),
    })
    const traced = wrapTracing(tree, integration, { projectorType: "http" })
    const fetchHandler = createFetch(traced)

    const res = await fetchHandler(new Request("http://localhost/whoami"))

    expect(await res.json()).toEqual({ ok: true })
    expect(spans).toHaveLength(1)
    expect(spans[0]!.attributes["projector.type"]).toBe("http")
    expect(spans[0]!.attributes["operation.name"]).toBe("whoami")
    expect(spans[0]!.ended).toBe(true)
    expect(sawSpanInsideHandler).toBeDefined()
    expect(getActiveSpan()).toBeUndefined() // no leakage after the request completes
  })

  it("produces one CLI-tagged span per invocation", async () => {
    const { tracer, spans } = makeFakeTracer()
    const integration: TracingIntegration = { tracer }
    const tree = api_({ whoami: op((_: unknown) => ({ ok: true }), {}) })
    const traced = wrapTracing(tree, integration, { projectorType: "cli" })
    const out: string[] = []
    const io = {
      stdout: { write: (s: string) => { out.push(s) } },
      stderr: { write: (_: string) => {} },
      confirm: async () => true,
    }

    await runCli(traced, ["whoami"], io)

    expect(JSON.parse(out.join(""))).toEqual({ ok: true })
    expect(spans).toHaveLength(1)
    expect(spans[0]!.attributes["projector.type"]).toBe("cli")
    expect(spans[0]!.ended).toBe(true)
  })

  it("produces one MCP-tagged span per tool call", async () => {
    const { tracer, spans } = makeFakeTracer()
    const integration: TracingIntegration = { tracer }
    const tree = api_({ whoami: op((_: unknown) => ({ ok: true }), {}) })
    const traced = wrapTracing(tree, integration, { projectorType: "mcp" })
    const server = createMcpServer(traced, { name: "test-server", version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "1.0.0" })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const result = await client.callTool({ name: "whoami", arguments: {} })

    const content = (result as { content: Array<{ type: string; text?: string }> }).content[0]
    expect(JSON.parse(content?.text ?? "")).toEqual({ ok: true })
    expect(spans).toHaveLength(1)
    expect(spans[0]!.attributes["projector.type"]).toBe("mcp")
    expect(spans[0]!.ended).toBe(true)
  })

  it("produces one GraphQL-tagged span per field resolution", async () => {
    const { tracer, spans } = makeFakeTracer()
    const integration: TracingIntegration = { tracer }
    const tree = api_({ whoami: op((_: unknown) => ({ ok: true }), { tags: { readOnly: true } }) })
    const traced = wrapTracing(tree, integration, { projectorType: "graphql" })
    const server = createGraphQLServer(traced)

    const result = await server.execute("{ whoami }")

    expect(result.errors).toBeUndefined()
    expect(result.data).toEqual({ whoami: { ok: true } })
    expect(spans).toHaveLength(1)
    expect(spans[0]!.attributes["projector.type"]).toBe("graphql")
    expect(spans[0]!.ended).toBe(true)
  })
})
