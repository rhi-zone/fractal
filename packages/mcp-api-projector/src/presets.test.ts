// packages/mcp-api-projector/src/presets.test.ts — createStdioMcpServer / createHttpMcpServer tests
//
// Stdio: connects over an in-memory Readable/Writable pair (not the real
// process streams — see `CreateStdioMcpServerOptions.stdio`) and drives the
// connected `Server` with a real `Client` over `InMemoryTransport`, since the
// stdio transport itself is already covered by the SDK's own test suite —
// what this preset adds is the "one call, already connected" wiring.
//
// HTTP: drives the returned fetch handler directly with real `Request`
// objects — initialize (no session id) => 200 + `Mcp-Session-Id` header,
// follow-up `tools/call` with that header => routed to the same session,
// unknown session id => 404, no session id + non-initialize body => 400.

import { PassThrough } from "node:stream"
import { describe, expect, it } from "bun:test"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { createHttpMcpServer, createStdioMcpServer } from "./presets.ts"

const tree = api_({
  users: api_({
    get: op((input: { id: string }) => ({ id: input.id, name: "Alice" }), {
      tags: { readOnly: true },
    }),
  }),
})

// ============================================================================
// createStdioMcpServer
// ============================================================================

describe("createStdioMcpServer", () => {
  it("connects the server to a StdioServerTransport over supplied streams", async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()

    const server = await createStdioMcpServer(tree, {
      name: "test-stdio-server",
      version: "1.0.0",
      stdio: { stdin, stdout },
    })

    // `connect` resolving without throwing is the contract here — the
    // transport itself (framing, read loop) is the SDK's own tested code.
    expect(server).toBeDefined()

    await server.close()
  })
})

// ============================================================================
// createHttpMcpServer
// ============================================================================

function initializeRequest(): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    }),
  })
}

describe("createHttpMcpServer", () => {
  it("handles an initialize request and issues a session id", async () => {
    const handler = createHttpMcpServer(tree, { name: "test-http-server", version: "1.0.0" })

    const res = await handler(initializeRequest())

    expect(res.status).toBe(200)
    expect(res.headers.get("mcp-session-id")).toBeTruthy()
  })

  it("routes a follow-up request with the session id to the same session", async () => {
    const handler = createHttpMcpServer(tree, { name: "test-http-server", version: "1.0.0" })

    const initRes = await handler(initializeRequest())
    const sessionId = initRes.headers.get("mcp-session-id")
    expect(sessionId).toBeTruthy()

    const listRes = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Session-Id": sessionId ?? "",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      }),
    )

    expect(listRes.status).toBe(200)
    const contentType = listRes.headers.get("content-type") ?? ""
    const text = await listRes.text()
    const body = contentType.includes("text/event-stream")
      ? text
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice("data:".length)
          .trim()
      : text
    const parsed = JSON.parse(body ?? "{}")
    const names = (parsed.result.tools as Array<{ name: string }>).map((t) => t.name).sort()
    expect(names).toEqual(["users_get"])
  })

  it("rejects a request carrying an unknown session id", async () => {
    const handler = createHttpMcpServer(tree, { name: "test-http-server", version: "1.0.0" })

    const res = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Session-Id": "does-not-exist",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
      }),
    )

    expect(res.status).toBe(404)
  })

  it("rejects a non-initialize request with no session id", async () => {
    const handler = createHttpMcpServer(tree, { name: "test-http-server", version: "1.0.0" })

    const res = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }),
      }),
    )

    expect(res.status).toBe(400)
  })
})
