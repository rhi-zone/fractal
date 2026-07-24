// packages/json-rpc-api-projector/src/server.test.ts — HTTP POST + WebSocket transport tests

import { describe, expect, it } from "bun:test"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { err, ok } from "@rhi-zone/fractal-api-tree"
import { createJsonRpcHttpHandler, createJsonRpcWebSocketHandlers, jsonRpcErrors } from "./server.ts"
import type { JsonRpcSocket } from "./server.ts"
import type { JsonRpcNotification, JsonRpcResponse } from "./wire.ts"

function post(handler: (req: Request) => Promise<Response>, body: unknown): Promise<Response> {
  return handler(
    new Request("http://localhost/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
}

// ============================================================================
// HTTP POST transport
// ============================================================================

describe("createJsonRpcHttpHandler: single requests", () => {
  const tree = api_({
    add: op((input: { a: number; b: number }) => input.a + input.b),
  })

  it("dispatches a call and returns a success Response", async () => {
    const handler = createJsonRpcHttpHandler(tree)
    const res = await post(handler, { jsonrpc: "2.0", method: "add", params: { a: 2, b: 3 }, id: 1 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as JsonRpcResponse
    expect(body).toEqual({ jsonrpc: "2.0", result: 5, id: 1 })
  })

  it("unknown method -> METHOD_NOT_FOUND", async () => {
    const handler = createJsonRpcHttpHandler(tree)
    const res = await post(handler, { jsonrpc: "2.0", method: "nope", params: {}, id: 1 })
    const body = (await res.json()) as JsonRpcResponse
    expect("error" in body && body.error.code).toBe(-32601)
  })

  it("malformed request shape -> INVALID_REQUEST", async () => {
    const handler = createJsonRpcHttpHandler(tree)
    const res = await post(handler, { foo: "bar" })
    const body = (await res.json()) as JsonRpcResponse
    expect("error" in body && body.error.code).toBe(-32600)
  })

  it("malformed JSON -> PARSE_ERROR", async () => {
    const handler = createJsonRpcHttpHandler(tree)
    const res = await handler(
      new Request("http://localhost/rpc", { method: "POST", body: "{not json" }),
    )
    const body = (await res.json()) as JsonRpcResponse
    expect("error" in body && body.error.code).toBe(-32700)
  })

  it("a Notification (no id) gets no response body — 204", async () => {
    const handler = createJsonRpcHttpHandler(tree)
    const res = await post(handler, { jsonrpc: "2.0", method: "add", params: { a: 1, b: 1 } })
    expect(res.status).toBe(204)
  })

  it("a thrown handler error collapses to INTERNAL_ERROR, never leaking the message", async () => {
    const boomTree = api_({
      boom: op((_: unknown) => {
        throw new Error("some internal detail")
      }),
    })
    const handler = createJsonRpcHttpHandler(boomTree)
    const res = await post(handler, { jsonrpc: "2.0", method: "boom", params: {}, id: 1 })
    const body = (await res.json()) as JsonRpcResponse
    expect("error" in body && body.error.code).toBe(-32603)
    expect("error" in body && body.error.message).not.toContain("some internal detail")
  })
})

describe("createJsonRpcHttpHandler: batch requests (§6)", () => {
  const tree = api_({
    add: op((input: { a: number; b: number }) => input.a + input.b),
    notifyOnly: op((_: unknown) => "ignored"),
  })

  it("dispatches each element, collecting non-Notification responses", async () => {
    const handler = createJsonRpcHttpHandler(tree)
    const res = await post(handler, [
      { jsonrpc: "2.0", method: "add", params: { a: 1, b: 1 }, id: 1 },
      { jsonrpc: "2.0", method: "add", params: { a: 2, b: 2 }, id: 2 },
    ])
    const body = (await res.json()) as JsonRpcResponse[]
    expect(body).toHaveLength(2)
    expect(body.map((r) => "result" in r && r.result)).toEqual([2, 4])
  })

  it("a batch made entirely of Notifications sends no body — 204", async () => {
    const handler = createJsonRpcHttpHandler(tree)
    const res = await post(handler, [
      { jsonrpc: "2.0", method: "notifyOnly", params: {} },
      { jsonrpc: "2.0", method: "notifyOnly", params: {} },
    ])
    expect(res.status).toBe(204)
  })

  it("an empty batch array is itself an Invalid Request", async () => {
    const handler = createJsonRpcHttpHandler(tree)
    const res = await post(handler, [])
    const body = (await res.json()) as JsonRpcResponse
    expect("error" in body && body.error.code).toBe(-32600)
  })
})

describe("createJsonRpcHttpHandler: Result unwrapping + error encoding", () => {
  const tree = api_({
    withdraw: op((input: { amount: number }) =>
      input.amount > 100 ? err({ kind: "insufficientFunds", message: "not enough" }) : ok(input.amount),
    ),
  })

  it("ok(...) unwraps to the plain result", async () => {
    const handler = createJsonRpcHttpHandler(tree)
    const res = await post(handler, { jsonrpc: "2.0", method: "withdraw", params: { amount: 10 }, id: 1 })
    const body = (await res.json()) as JsonRpcResponse
    expect("result" in body && body.result).toBe(10)
  })

  it("err(...) with no encoder -> INVALID_PARAMS, raw error as data", async () => {
    const handler = createJsonRpcHttpHandler(tree)
    const res = await post(handler, { jsonrpc: "2.0", method: "withdraw", params: { amount: 200 }, id: 1 })
    const body = (await res.json()) as JsonRpcResponse
    expect("error" in body && body.error.code).toBe(-32602)
    expect("error" in body && (body.error.data as { kind: string }).kind).toBe("insufficientFunds")
  })

  it("err(...) with a matching jsonRpcErrors encoder -> custom code", async () => {
    const handler = createJsonRpcHttpHandler(tree, {
      errorEncoder: jsonRpcErrors({ insufficientFunds: -32001 }),
    })
    const res = await post(handler, { jsonrpc: "2.0", method: "withdraw", params: { amount: 200 }, id: 1 })
    const body = (await res.json()) as JsonRpcResponse
    expect("error" in body && body.error.code).toBe(-32001)
    expect("error" in body && body.error.message).toBe("not enough")
  })
})

describe("createJsonRpcHttpHandler: streaming degrades to a collected array", () => {
  it("an AsyncIterable handler's yields collect into the result array", async () => {
    const tree = api_({
      watch: op(async function* (_: unknown) {
        yield "a"
        yield "b"
      }),
    })
    const handler = createJsonRpcHttpHandler(tree)
    const res = await post(handler, { jsonrpc: "2.0", method: "watch", params: {}, id: 1 })
    const body = (await res.json()) as JsonRpcResponse
    expect("result" in body && body.result).toEqual(["a", "b"])
  })
})

// ============================================================================
// WebSocket transport
// ============================================================================

class FakeSocket implements JsonRpcSocket {
  sent: unknown[] = []
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
}

describe("createJsonRpcWebSocketHandlers: single calls", () => {
  it("sends a success Response back over the socket", async () => {
    const tree = api_({ add: op((input: { a: number; b: number }) => input.a + input.b) })
    const { message } = createJsonRpcWebSocketHandlers(tree)
    const ws = new FakeSocket()
    await message(ws, JSON.stringify({ jsonrpc: "2.0", method: "add", params: { a: 2, b: 2 }, id: 1 }))
    expect(ws.sent).toEqual([{ jsonrpc: "2.0", result: 4, id: 1 }])
  })
})

describe("createJsonRpcWebSocketHandlers: streaming via Notifications", () => {
  it("each yield becomes a Notification, followed by a Response carrying the return value", async () => {
    const tree = api_({
      watch: op(async function* (_: unknown) {
        yield "a"
        yield "b"
        return "done"
      }),
    })
    const { message } = createJsonRpcWebSocketHandlers(tree)
    const ws = new FakeSocket()
    await message(ws, JSON.stringify({ jsonrpc: "2.0", method: "watch", params: {}, id: 7 }))

    const notifications = ws.sent.filter((m): m is JsonRpcNotification => !("id" in (m as object)))
    const responses = ws.sent.filter((m): m is JsonRpcResponse => "id" in (m as object))

    expect(notifications).toHaveLength(2)
    expect(notifications.map((n) => (n.params as { value: unknown }).value)).toEqual(["a", "b"])
    expect(notifications.every((n) => (n.params as { subscription: unknown }).subscription === 7)).toBe(true)

    expect(responses).toHaveLength(1)
    expect("result" in responses[0]! && responses[0]!.result).toBe("done")
  })

  it("progress yields become type: 'progress' Notifications", async () => {
    const tree = api_({
      watch: op(async function* (_: unknown) {
        yield { kind: "progress" as const, progress: 1, total: 2 }
        yield { kind: "chunk" as const, data: "x" }
      }),
    })
    const { message } = createJsonRpcWebSocketHandlers(tree)
    const ws = new FakeSocket()
    await message(ws, JSON.stringify({ jsonrpc: "2.0", method: "watch", params: {}, id: 1 }))

    const notifications = ws.sent.filter((m): m is JsonRpcNotification => !("id" in (m as object)))
    const types = notifications.map((n) => (n.params as { type: string }).type)
    expect(types).toEqual(["progress", "chunk"])
  })

  it("malformed JSON -> a PARSE_ERROR Response sent back", async () => {
    const tree = api_({ ping: op((_: unknown) => "pong") })
    const { message } = createJsonRpcWebSocketHandlers(tree)
    const ws = new FakeSocket()
    await message(ws, "{not json")
    expect(ws.sent).toEqual([{ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }])
  })

  it("a Notification call sends nothing back", async () => {
    const tree = api_({ ping: op((_: unknown) => "pong") })
    const { message } = createJsonRpcWebSocketHandlers(tree)
    const ws = new FakeSocket()
    await message(ws, JSON.stringify({ jsonrpc: "2.0", method: "ping", params: {} }))
    expect(ws.sent).toEqual([])
  })
})
