// packages/mcp-api-projector/src/server.test.ts — createMcpServer end-to-end tests
//
// Drives `createMcpServer` through a real `@modelcontextprotocol/sdk` `Client`
// over `InMemoryTransport` — exercises the actual `tools/list` and
// `tools/call` wire protocol, not just the internal `projectTools` walk
// (already covered by project.test.ts).

import { describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { createMcpServer } from "./server.ts"

// ============================================================================
// Fixture: a small Node tree with a happy-path leaf and a throwing leaf
// ============================================================================

const tree = api_({
  users: api_({
    get: op((input: { id: string }) => ({ id: input.id, name: "Alice" }), {
      tags: { readOnly: true },
    }),
    boom: op((_: unknown) => {
      throw new Error("kaboom")
    }),
  }),
})

async function connectedClient() {
  const server = createMcpServer(tree, { name: "test-server", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "1.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { server, client }
}

// ============================================================================
// 1. Lists tools — verifies the McpTool[] shape reaches the client unaltered
// ============================================================================

describe("createMcpServer — tools/list", () => {
  it("lists tools derived from the Node tree", async () => {
    const { client } = await connectedClient()
    const { tools } = await client.listTools()

    expect(tools).toHaveLength(2)
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(["users_boom", "users_get"])

    const getTool = tools.find((t) => t.name === "users_get")
    expect(getTool?.annotations?.readOnlyHint).toBe(true)
  })
})

// ============================================================================
// 2. Calls a tool and verifies the response
// ============================================================================

describe("createMcpServer — tools/call", () => {
  it("dispatches to the resolved handler and returns its result as text content", async () => {
    const { client } = await connectedClient()
    const result = await client.callTool({
      name: "users_get",
      arguments: { id: "42" },
    })

    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(content).toHaveLength(1)
    expect(content[0]!.type).toBe("text")
    expect(JSON.parse(content[0]!.text)).toEqual({ id: "42", name: "Alice" })
  })

  // ==========================================================================
  // 3. Error handling — tool throws → MCP error response, not a crash
  // ==========================================================================

  it("a throwing handler surfaces as an MCP tool error result", async () => {
    const { client } = await connectedClient()
    const result = await client.callTool({ name: "users_boom", arguments: {} })

    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0]!.text).toContain("kaboom")
  })

  it("an unknown tool name surfaces as an MCP tool error result", async () => {
    const { client } = await connectedClient()
    const result = await client.callTool({ name: "does_not_exist", arguments: {} })

    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0]!.text).toContain("does_not_exist")
  })
})

// ============================================================================
// 4. Runtime input validation against inputSchema
// ============================================================================

const validatedTree = api_({
  users: api_({
    get: op((input: { id: string }) => ({ id: input.id, name: "Alice" }), {
      tags: { readOnly: true },
    }),
  }),
})

const validatedSchemas = {
  users_get: {
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
}

async function connectedValidatedClient() {
  const server = createMcpServer(validatedTree, {
    name: "validated-test-server",
    version: "1.0.0",
    schemas: validatedSchemas,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "1.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { server, client }
}

describe("createMcpServer — input validation", () => {
  it("valid input passes through to the handler", async () => {
    const { client } = await connectedValidatedClient()
    const result = await client.callTool({ name: "users_get", arguments: { id: "42" } })

    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(JSON.parse(content[0]!.text)).toEqual({ id: "42", name: "Alice" })
  })

  it("missing required field returns an isError response without invoking the handler", async () => {
    const { client } = await connectedValidatedClient()
    const result = await client.callTool({ name: "users_get", arguments: {} })

    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0]!.text).toContain("id")
    expect(content[0]!.text.toLowerCase()).toContain("required")
  })

  it("wrong field type returns an isError response without invoking the handler", async () => {
    const { client } = await connectedValidatedClient()
    const result = await client.callTool({ name: "users_get", arguments: { id: 42 } })

    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0]!.text).toContain("id")
    expect(content[0]!.text.toLowerCase()).toContain("type")
  })
})
