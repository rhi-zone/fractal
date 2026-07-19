// packages/mcp-api-projector/src/middleware.test.ts — CreateMcpServerOptions.middleware
//
// Covers: a middleware sees MCP dispatch context (meta, name, requestType),
// wraps the handler call for tools/resources/prompts, ALS-based caller
// context threads through to the handler, and composition order (first
// entry = outermost wrapper). Driven through a real
// `@modelcontextprotocol/sdk` `Client` over `InMemoryTransport`, same as
// server.test.ts.

import { AsyncLocalStorage } from "node:async_hooks"
import { describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import type { Node } from "@rhi-zone/fractal-api-tree/node"
import { createMcpServer } from "./server.ts"
import type { CreateMcpServerOptions, McpMiddleware } from "./server.ts"

async function connectedClient(tree: Node, opts: Omit<CreateMcpServerOptions, "name" | "version">) {
  const server = createMcpServer(tree, { name: "test-server", version: "1.0.0", ...opts })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "1.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { server, client }
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content
  const block = content[0]
  return block?.type === "text" ? (block.text ?? "") : ""
}

describe("CreateMcpServerOptions.middleware — tools", () => {
  const tree = api_({
    echo: op((input: { x: string }) => ({ got: input.x }), { description: "an echo op" }),
  })

  it("with no middleware configured, the handler is called directly", async () => {
    const { client } = await connectedClient(tree, {})
    const result = await client.callTool({ name: "echo", arguments: { x: "1" } })
    expect(JSON.parse(textOf(result))).toEqual({ got: "1" })
  })

  it("middleware sees MCP dispatch context (meta, name, requestType)", async () => {
    let seenName: string | undefined
    let seenDescription: unknown
    let seenRequestType: string | undefined
    const capture: McpMiddleware = (next, context) => {
      seenName = context.name
      seenDescription = context.meta.description
      seenRequestType = context.requestType
      return next
    }
    const { client } = await connectedClient(tree, { middleware: [capture] })
    await client.callTool({ name: "echo", arguments: { x: "1" } })
    expect(seenName).toBe("echo")
    expect(seenDescription).toBe("an echo op")
    expect(seenRequestType).toBe("tool")
  })

  it("middleware wraps the handler call — can transform input before and output after", async () => {
    const doubleInput: McpMiddleware = (next) => (input) => next({ ...input, x: String(Number(input.x) * 2) })
    const wrapOutput: McpMiddleware = (next) => async (input) => {
      const result = await next(input)
      return { wrapped: result }
    }
    const numTree = api_({ echo: op((input: { x: string }) => ({ got: Number(input.x) }), {}) })
    const { client } = await connectedClient(numTree, { middleware: [wrapOutput, doubleInput] })
    const result = await client.callTool({ name: "echo", arguments: { x: "5" } })
    expect(JSON.parse(textOf(result))).toEqual({ wrapped: { got: 10 } })
  })

  it("middleware sets up an AsyncLocalStorage caller-context the handler can read", async () => {
    const als = new AsyncLocalStorage<{ name: string }>()
    const alsTree = api_({
      whoami: op((_: unknown) => ({ name: als.getStore()?.name ?? "none" }), {}),
    })
    const withAls: McpMiddleware = (next, context) => (input) =>
      als.run({ name: context.name }, () => next(input))
    const { client } = await connectedClient(alsTree, { middleware: [withAls] })
    const result = await client.callTool({ name: "whoami", arguments: {} })
    expect(JSON.parse(textOf(result))).toEqual({ name: "whoami" })
  })

  it("composes multiple middleware — first entry is outermost (sees the call first and last)", async () => {
    const order: string[] = []
    const outer: McpMiddleware = (next) => async (input) => {
      order.push("outer:before")
      const result = await next(input)
      order.push("outer:after")
      return result
    }
    const inner: McpMiddleware = (next) => async (input) => {
      order.push("inner:before")
      const result = await next(input)
      order.push("inner:after")
      return result
    }
    const { client } = await connectedClient(tree, { middleware: [outer, inner] })
    await client.callTool({ name: "echo", arguments: { x: "1" } })
    expect(order).toEqual(["outer:before", "inner:before", "inner:after", "outer:after"])
  })
})

describe("CreateMcpServerOptions.middleware — resources", () => {
  const tree = api_({
    config: op((_: unknown) => ({ debug: true }), { mcp: { as: "resource" } }),
    users: api_({}, {
      fallback: {
        name: "userId",
        subtree: api_({
          profile: op((input: { userId: string }) => ({ id: input.userId }), { mcp: { as: "resource" } }),
        }),
      },
    }),
  })

  it("middleware sees requestType 'resource' for a fixed resource read", async () => {
    let seenRequestType: string | undefined
    let seenName: string | undefined
    const capture: McpMiddleware = (next, context) => {
      seenRequestType = context.requestType
      seenName = context.name
      return next
    }
    const { client } = await connectedClient(tree, { middleware: [capture] })
    await client.readResource({ uri: "resource://config" })
    expect(seenRequestType).toBe("resource")
    expect(seenName).toBe("resource://config")
  })

  it("middleware wraps a resource-template read", async () => {
    const order: string[] = []
    const track: McpMiddleware = (next, context) => (input) => {
      order.push(context.name)
      return next(input)
    }
    const { client } = await connectedClient(tree, { middleware: [track] })
    const result = await client.readResource({ uri: "resource://users/u1/profile" })
    const content = result.contents[0] as { text: string }
    expect(JSON.parse(content.text)).toEqual({ id: "u1" })
    expect(order).toEqual(["resource://users/u1/profile"])
  })
})

describe("CreateMcpServerOptions.middleware — prompts", () => {
  const tree = api_({
    greet: op((_: unknown) => ({ messages: [{ role: "assistant", content: { type: "text", text: "hi" } }] }), {
      mcp: { as: "prompt" },
    }),
  })

  it("middleware sees requestType 'prompt'", async () => {
    let seenRequestType: string | undefined
    const capture: McpMiddleware = (next, context) => {
      seenRequestType = context.requestType
      return next
    }
    const { client } = await connectedClient(tree, { middleware: [capture] })
    await client.getPrompt({ name: "greet", arguments: {} })
    expect(seenRequestType).toBe("prompt")
  })
})
