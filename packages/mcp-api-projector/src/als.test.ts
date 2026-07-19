// packages/mcp-api-projector/src/als.test.ts — CreateMcpServerOptions.als
//
// Covers: each dispatch path (tool, fixed resource, resource template,
// prompt) runs its handler inside the configured AsyncLocalStorage context,
// `init` receives MCP dispatch context (McpMiddlewareContext), concurrent
// calls stay isolated, and ALS composes with `opts.middleware` as the
// INNERMOST wrapper — same contract as HTTP's `PresetOptions.als`
// (`packages/http-api-projector/src/preset.ts`) and CLI's `CliOpts.als`
// (`packages/cli-api-projector/src/als.test.ts`).

import { AsyncLocalStorage } from "node:async_hooks"
import { describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import type { Node } from "@rhi-zone/fractal-api-tree/node"
import { createMcpServer } from "./server.ts"
import type { CreateMcpServerOptions, McpMiddleware } from "./server.ts"

async function connectedClient<T>(tree: Node, opts: Omit<CreateMcpServerOptions<T>, "name" | "version">) {
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

describe("CreateMcpServerOptions.als — tools", () => {
  it("the handler runs inside the AsyncLocalStorage context set up by init", async () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>()
    const tree = api_({
      whoami: op((_: unknown) => ({ requestId: storage.getStore()?.requestId ?? "none" }), {}),
    })
    const { client } = await connectedClient(tree, { als: { storage, init: () => ({ requestId: "req-1" }) } })
    const result = await client.callTool({ name: "whoami", arguments: {} })
    expect(JSON.parse(textOf(result))).toEqual({ requestId: "req-1" })
  })

  it("init receives MCP dispatch context (meta, name, requestType)", async () => {
    const storage = new AsyncLocalStorage<{ name: string }>()
    let seenName: string | undefined
    let seenRequestType: string | undefined
    const tree = api_({
      echo: op((input: { x: string }) => ({ got: input.x }), { description: "an echo op" }),
    })
    const { client } = await connectedClient(tree, {
      als: {
        storage,
        init: (context) => {
          seenName = context.name
          seenRequestType = context.requestType
          return { name: context.name }
        },
      },
    })
    await client.callTool({ name: "echo", arguments: { x: "1" } })
    expect(seenName).toBe("echo")
    expect(seenRequestType).toBe("tool")
  })

  it("init receives the SDK's `extra` (sendNotification, signal) via context.extra", async () => {
    const storage = new AsyncLocalStorage<{ hasSendNotification: boolean; hasSignal: boolean }>()
    const tree = api_({
      whoami: op(
        (_: unknown) => ({
          hasSendNotification: storage.getStore()?.hasSendNotification ?? false,
          hasSignal: storage.getStore()?.hasSignal ?? false,
        }),
        {},
      ),
    })
    const { client } = await connectedClient(tree, {
      als: {
        storage,
        init: (context) => ({
          hasSendNotification: typeof context.extra.sendNotification === "function",
          hasSignal: context.extra.signal instanceof AbortSignal,
        }),
      },
    })
    const result = await client.callTool({ name: "whoami", arguments: {} })
    expect(JSON.parse(textOf(result))).toEqual({ hasSendNotification: true, hasSignal: true })
  })

  it("no ALS configured — handler runs with no store active (undefined)", async () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>()
    const tree = api_({
      whoami: op((_: unknown) => ({ requestId: storage.getStore()?.requestId ?? "none" }), {}),
    })
    const { client } = await connectedClient(tree, {})
    const result = await client.callTool({ name: "whoami", arguments: {} })
    expect(JSON.parse(textOf(result))).toEqual({ requestId: "none" })
  })

  it("concurrent tool calls stay isolated — each sees its own context value", async () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>()
    const tree = api_({
      whoami: op(async (_: unknown) => {
        await new Promise((r) => setTimeout(r, 0))
        return { requestId: storage.getStore()?.requestId ?? "none" }
      }, {}),
    })

    let counter = 0
    const { client } = await connectedClient(tree, { als: { storage, init: () => ({ requestId: `req-${counter++}` }) } })

    const results = await Promise.all(
      [0, 1, 2].map(async (i) => {
        const result = await client.callTool({ name: "whoami", arguments: {} })
        return { i, requestId: (JSON.parse(textOf(result)) as { requestId: string }).requestId }
      }),
    )
    // Each call got its own init()-computed id, and no call observed another's.
    const ids = new Set(results.map((r) => r.requestId))
    expect(ids.size).toBe(3)
  })

  it("composes with middleware — ALS wraps only the handler, not middleware's own code", async () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>()
    let seenBeforeNext: string | undefined
    let seenAfterNext: string | undefined

    const observe: McpMiddleware = (next) => async (input) => {
      // Before calling `next`, ALS hasn't been entered yet — middleware runs
      // OUTSIDE the store (ALS is the innermost wrapper, closer to the
      // handler than middleware — see CreateMcpServerOptions.als).
      seenBeforeNext = storage.getStore()?.requestId
      const result = await next(input)
      // After `next` settles, execution is back outside the store too —
      // Node's AsyncLocalStorage does not propagate back out through an
      // already-settled `await`.
      seenAfterNext = storage.getStore()?.requestId
      return result
    }

    const tree = api_({
      whoami: op((_: unknown) => ({ requestId: storage.getStore()?.requestId ?? "none" }), {}),
    })
    const { client } = await connectedClient(tree, {
      als: { storage, init: () => ({ requestId: "req-mw" }) },
      middleware: [observe],
    })
    const result = await client.callTool({ name: "whoami", arguments: {} })
    // The handler itself — inside `next` — still saw the store.
    expect(JSON.parse(textOf(result))).toEqual({ requestId: "req-mw" })
    expect(seenBeforeNext).toBeUndefined()
    expect(seenAfterNext).toBeUndefined()
  })
})

describe("CreateMcpServerOptions.als — resources", () => {
  const tree = api_({
    config: op((_: unknown) => ({}) as { requestId?: string }, { mcp: { as: "resource" } }),
    users: api_({}, {
      fallback: {
        name: "userId",
        subtree: api_({
          profile: op((_: unknown) => ({}) as { requestId?: string }, { mcp: { as: "resource" } }),
        }),
      },
    }),
  })

  it("a fixed resource read runs inside the ALS context", async () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>()
    const alsTree = api_({
      config: op((_: unknown) => ({ requestId: storage.getStore()?.requestId ?? "none" }), { mcp: { as: "resource" } }),
    })
    const { client } = await connectedClient(alsTree, { als: { storage, init: () => ({ requestId: "req-fixed" }) } })
    const result = await client.readResource({ uri: "resource://config" })
    const content = result.contents[0] as { text: string }
    expect(JSON.parse(content.text)).toEqual({ requestId: "req-fixed" })
  })

  it("a resource-template read runs inside the ALS context, init sees requestType 'resource'", async () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>()
    let seenRequestType: string | undefined
    const alsTree = api_({
      users: api_({}, {
        fallback: {
          name: "userId",
          subtree: api_({
            profile: op(
              (_: unknown) => ({ requestId: storage.getStore()?.requestId ?? "none" }),
              { mcp: { as: "resource" } },
            ),
          }),
        },
      }),
    })
    const { client } = await connectedClient(alsTree, {
      als: {
        storage,
        init: (context) => {
          seenRequestType = context.requestType
          return { requestId: "req-template" }
        },
      },
    })
    const result = await client.readResource({ uri: "resource://users/u1/profile" })
    const content = result.contents[0] as { text: string }
    expect(JSON.parse(content.text)).toEqual({ requestId: "req-template" })
    expect(seenRequestType).toBe("resource")
  })

  it("with no ALS configured, resource reads are unaffected", async () => {
    const { client } = await connectedClient(tree, {})
    const result = await client.readResource({ uri: "resource://config" })
    const content = result.contents[0] as { text: string }
    expect(JSON.parse(content.text)).toEqual({})
  })
})

describe("CreateMcpServerOptions.als — prompts", () => {
  it("a prompt call runs inside the ALS context, init sees requestType 'prompt'", async () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>()
    let seenRequestType: string | undefined
    const tree = api_({
      greet: op(
        (_: unknown) => ({
          messages: [
            { role: "assistant", content: { type: "text", text: storage.getStore()?.requestId ?? "none" } },
          ],
        }),
        { mcp: { as: "prompt" } },
      ),
    })
    const { client } = await connectedClient(tree, {
      als: {
        storage,
        init: (context) => {
          seenRequestType = context.requestType
          return { requestId: "req-prompt" }
        },
      },
    })
    const result = await client.getPrompt({ name: "greet", arguments: {} })
    expect((result.messages[0]?.content as { text: string }).text).toBe("req-prompt")
    expect(seenRequestType).toBe("prompt")
  })
})
