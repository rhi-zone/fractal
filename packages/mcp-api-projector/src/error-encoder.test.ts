// packages/mcp-api-projector/src/error-encoder.test.ts — structured error
// types: composable error-to-transport mapping (McpErrorEncoder/mcpErrors).
//
// Covers: a tool handler returns `err({ kind, ... })`; `mcpErrors` maps
// `kind` to an MCP error code. Unmatched kinds and an absent `errorEncoder`
// fall back to the existing default (isError text: `Invalid input for tool
// "<name>": <JSON>`). See docs/design/middleware-and-caller-context.md.

import { describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { err, ok } from "@rhi-zone/fractal-api-tree"
import { createMcpServer, mcpErrors } from "./server.ts"
import type { CreateMcpServerOptions } from "./server.ts"

const tree = api_({
  getBook: op((input: { id: string }) => {
    if (input.id === "missing") return err({ kind: "notFound", message: "Book not found" })
    if (input.id === "dupe") return err({ kind: "conflict", message: "already exists" })
    if (input.id === "weird") return err({ kind: "somethingElse", message: "???" })
    return ok({ id: input.id, title: "Dune" })
  }, {}),
})

async function connectedClient(opts: Partial<CreateMcpServerOptions> = {}) {
  const server = createMcpServer(tree, { name: "test-server", version: "1.0.0", ...opts })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "1.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { server, client }
}

function textOf(result: { content: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }>
  return content[0]?.text ?? ""
}

describe("mcpErrors", () => {
  it("maps a matched error kind to its configured MCP error code", async () => {
    const { client } = await connectedClient({ errorEncoder: mcpErrors({ notFound: ErrorCode.InvalidParams }) })
    const result = await client.callTool({ name: "getBook", arguments: { id: "missing" } })
    expect(result.isError).toBe(true)
    expect(textOf(result as { content: unknown })).toContain(String(ErrorCode.InvalidParams))
    expect(textOf(result as { content: unknown })).toContain("Book not found")
  })

  it("composed mapping — a second configured kind maps to its own code", async () => {
    const { client } = await connectedClient({
      errorEncoder: mcpErrors({ notFound: ErrorCode.InvalidParams, conflict: ErrorCode.InternalError }),
    })
    const result = await client.callTool({ name: "getBook", arguments: { id: "dupe" } })
    expect(result.isError).toBe(true)
    expect(textOf(result as { content: unknown })).toContain(String(ErrorCode.InternalError))
  })

  it("unknown error kind (no match) falls back to the default isError text", async () => {
    const { client } = await connectedClient({ errorEncoder: mcpErrors({ notFound: ErrorCode.InvalidParams }) })
    const result = await client.callTool({ name: "getBook", arguments: { id: "weird" } })
    expect(result.isError).toBe(true)
    expect(textOf(result as { content: unknown })).toContain('Invalid input for tool "getBook"')
    expect(textOf(result as { content: unknown })).toContain("somethingElse")
  })

  it("no errorEncoder configured — current default isError behavior unchanged", async () => {
    const { client } = await connectedClient()
    const result = await client.callTool({ name: "getBook", arguments: { id: "missing" } })
    expect(result.isError).toBe(true)
    expect(textOf(result as { content: unknown })).toContain('Invalid input for tool "getBook"')
  })

  it("a successful Result still returns plain content, unaffected by errorEncoder", async () => {
    const { client } = await connectedClient({ errorEncoder: mcpErrors({ notFound: ErrorCode.InvalidParams }) })
    const result = await client.callTool({ name: "getBook", arguments: { id: "1" } })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(textOf(result as { content: unknown }))).toEqual({ id: "1", title: "Dune" })
  })
})
