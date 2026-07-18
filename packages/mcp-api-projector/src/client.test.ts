// packages/mcp-api-projector/src/client.test.ts — createMcpClient end-to-end tests
//
// Drives a real `createMcpClient` proxy against a real `createMcpServer`
// (built from the SAME Node tree) over `InMemoryTransport` — exercises the
// actual wire protocol (tools/call, resources/read, prompts/get), and
// verifies the client's independently-derived names/URIs land on the exact
// same handlers the server's own projection dispatches to.

import { describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { createMcpClient, McpClientError } from "./client.ts"
import { createMcpServer } from "./server.ts"

// ============================================================================
// Fixture: tools (including a co-located branch + fallback), a resource
// (fixed and templated), and a prompt — one tree exercising all three
// surfaces plus fallback slug capture.
// ============================================================================

const tree = api_({
  users: api_({
    list: op((_: unknown) => [{ id: "1", name: "Alice" }], { tags: { readOnly: true } }),
  }, {
    fallback: {
      name: "userId",
      subtree: api_({
        get: op((input: { userId: string }) => ({ id: input.userId, name: "Bob" }), {
          tags: { readOnly: true },
        }),
        profile: op((input: { userId: string }) => ({ id: input.userId, bio: "hello" }), {
          mcp: { as: "resource" },
        }),
      }),
    },
  }),
  config: op((_: unknown) => ({ theme: "dark" }), {
    mcp: { as: "resource" },
  }),
  boom: op((_: unknown) => {
    throw new Error("kaboom")
  }),
  summarize: op((input: { text: string }) => `summary of: ${input.text}`, {
    mcp: { as: "prompt" },
  }),
})

async function connectedClientPair() {
  const server = createMcpServer(tree, { name: "test-server", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const sdkClient = new Client({ name: "test-client", version: "1.0.0" })
  await Promise.all([server.connect(serverTransport), sdkClient.connect(clientTransport)])
  const proxy = createMcpClient(tree, sdkClient)
  return { server, sdkClient, proxy }
}

// ============================================================================
// 1. Proxy shape mirrors the tree
// ============================================================================

describe("createMcpClient — proxy shape", () => {
  it("mirrors branch/fallback/leaf structure", async () => {
    const { proxy } = await connectedClientPair()

    expect(typeof proxy.users).toBe("object")
    expect(typeof proxy.users.list).toBe("function")
    expect(typeof proxy.users.userId).toBe("function") // fallback capture
    expect(typeof proxy.config).toBe("function")
    expect(typeof proxy.boom).toBe("function")
    expect(typeof proxy.summarize).toBe("function")
  })
})

// ============================================================================
// 2. Tool calls — plain leaf and co-located-under-fallback leaf
// ============================================================================

describe("createMcpClient — tool calls", () => {
  it("calls a top-level-branch tool and unwraps the JSON text result", async () => {
    const { proxy } = await connectedClientPair()
    const result = await proxy.users.list()
    expect(result).toEqual([{ id: "1", name: "Alice" }])
  })

  it("calls a tool reached via fallback slug capture, reaching the right handler with the captured value", async () => {
    const { proxy } = await connectedClientPair()
    const sub = proxy.users.userId("42")
    const result = await sub.get()
    expect(result).toEqual({ id: "42", name: "Bob" })
  })

  it("a different captured slug value reaches the same handler with a different input", async () => {
    const { proxy } = await connectedClientPair()
    const result = await proxy.users.userId("99").get()
    expect(result).toEqual({ id: "99", name: "Bob" })
  })

  it("a throwing handler surfaces as a rejected promise (McpClientError)", async () => {
    const { proxy } = await connectedClientPair()
    await expect(proxy.boom()).rejects.toBeInstanceOf(McpClientError)
    await expect(proxy.boom()).rejects.toThrow("kaboom")
  })
})

// ============================================================================
// 3. Resource reads — fixed and templated (fallback-derived URI)
// ============================================================================

describe("createMcpClient — resource reads", () => {
  it("reads a fixed resource and unwraps the JSON text content", async () => {
    const { proxy } = await connectedClientPair()
    const result = await proxy.config()
    expect(result).toEqual({ theme: "dark" })
  })

  it("reads a templated resource, substituting the captured slug value into the URI", async () => {
    const { proxy } = await connectedClientPair()
    const result = await proxy.users.userId("7").profile()
    expect(result).toEqual({ id: "7", bio: "hello" })
  })
})

// ============================================================================
// 4. Prompt gets — returned as-is (messages array)
// ============================================================================

describe("createMcpClient — prompt gets", () => {
  it("gets a prompt and returns the raw GetPromptResult", async () => {
    const { proxy } = await connectedClientPair()
    const result = await proxy.summarize({ text: "hello" })
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]!.content).toEqual({
      type: "text",
      text: JSON.stringify("summary of: hello"),
    })
  })
})

// ============================================================================
// 5. Name/URI derivation matches the server's own projection
// ============================================================================

describe("createMcpClient — name/URI parity with server projection", () => {
  it("tool names the client dispatches to appear in the server's tools/list", async () => {
    const { sdkClient } = await connectedClientPair()
    const { tools } = await sdkClient.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(["boom", "users_list", "users_userId_get"])
  })

  it("resource URIs the client reads appear in the server's resources/list and templates/list", async () => {
    const { sdkClient } = await connectedClientPair()
    const { resources } = await sdkClient.listResources()
    const { resourceTemplates } = await sdkClient.listResourceTemplates()
    expect(resources.map((r) => r.uri)).toEqual(["resource://config"])
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual([
      "resource://users/{userId}/profile",
    ])
  })

  it("prompt names the client dispatches to appear in the server's prompts/list", async () => {
    const { sdkClient } = await connectedClientPair()
    const { prompts } = await sdkClient.listPrompts()
    expect(prompts.map((p) => p.name)).toEqual(["summarize"])
  })
})
