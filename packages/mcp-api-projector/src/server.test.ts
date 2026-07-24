// packages/mcp-api-projector/src/server.test.ts — createMcpServer end-to-end tests
//
// Drives `createMcpServer` through a real `@modelcontextprotocol/sdk` `Client`
// over `InMemoryTransport` — exercises the actual `tools/list` and
// `tools/call` wire protocol, not just the internal `projectTools` walk
// (already covered by project.test.ts).

import { AsyncLocalStorage } from "node:async_hooks"
import { describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { CreateMessageRequestSchema, LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { createMcpServer } from "./server.ts"
import type { CreateMessageFn, McpMiddleware, SendLogFn } from "./server.ts"

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

  it("a throwing handler surfaces as an MCP tool error result without leaking the thrown message", async () => {
    const { client } = await connectedClient()
    const result = await client.callTool({ name: "users_boom", arguments: {} })

    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0]!.text).not.toContain("kaboom")
    expect(content[0]!.text).toBe("internal error")
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

// ============================================================================
// 5. Resource projection — resources/list, resources/templates/list, resources/read
// ============================================================================

const resourceTree = api_({
  config: op((_: unknown) => ({ theme: "dark" }), {
    mcp: { as: "resource", mimeType: "application/json" },
  }),
  users: api_({}, {
    fallback: {
      name: "userId",
      subtree: api_({
        profile: op((input: { userId: string }) => ({ id: input.userId, name: "Alice" }), {
          mcp: { as: "resource" },
        }),
      }),
    },
  }),
})

async function connectedResourceClient() {
  const server = createMcpServer(resourceTree, { name: "resource-test-server", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "1.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { server, client }
}

describe("createMcpServer — resources/list", () => {
  it("lists fixed resources derived from the Node tree", async () => {
    const { client } = await connectedResourceClient()
    const { resources } = await client.listResources()

    expect(resources).toHaveLength(1)
    expect(resources[0]!.uri).toBe("resource://config")
    expect(resources[0]!.name).toBe("config")
  })

  it("lists resource templates for fallback-derived leaves", async () => {
    const { client } = await connectedResourceClient()
    const { resourceTemplates } = await client.listResourceTemplates()

    expect(resourceTemplates).toHaveLength(1)
    expect(resourceTemplates[0]!.uriTemplate).toBe("resource://users/{userId}/profile")
    expect(resourceTemplates[0]!.name).toBe("profile")
  })
})

describe("createMcpServer — resources/read", () => {
  it("dispatches a fixed-resource read to its handler", async () => {
    const { client } = await connectedResourceClient()
    const result = await client.readResource({ uri: "resource://config" })

    expect(result.contents).toHaveLength(1)
    const content = result.contents[0] as { uri: string; mimeType?: string; text: string }
    expect(content.mimeType).toBe("application/json")
    expect(JSON.parse(content.text)).toEqual({ theme: "dark" })
  })

  it("dispatches a template-resource read, binding the captured URI variable", async () => {
    const { client } = await connectedResourceClient()
    const result = await client.readResource({ uri: "resource://users/42/profile" })

    expect(result.contents).toHaveLength(1)
    const content = result.contents[0] as { uri: string; mimeType?: string; text: string }
    expect(JSON.parse(content.text)).toEqual({ id: "42", name: "Alice" })
  })

  it("an unknown resource URI rejects with an error", async () => {
    const { client } = await connectedResourceClient()
    await expect(client.readResource({ uri: "resource://does/not/exist" })).rejects.toThrow()
  })
})

describe("createMcpServer — resource capability advertisement", () => {
  it("does not advertise resources capability when the tree has no resource leaves", async () => {
    const server = createMcpServer(tree, { name: "no-resources-server", version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "1.0.0" })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    await expect(client.listResources()).rejects.toThrow()
  })
})

// ============================================================================
// 6. Prompt projection — prompts/list, prompts/get
// ============================================================================

const promptTree = api_({
  summarize: op((input: { text: string }) => `summary of: ${input.text}`, {
    mcp: { as: "prompt" },
  }),
  docs: api_({
    critique: op((input: { text: string }) => ({
      messages: [{ role: "user", content: { type: "text", text: `critique this: ${input.text}` } }],
    }), {
      mcp: { as: "prompt" },
    }),
  }),
})

const promptSchemas = {
  summarize: {
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "the text to summarize" } },
      required: ["text"],
    },
  },
}

async function connectedPromptClient() {
  const server = createMcpServer(promptTree, {
    name: "prompt-test-server",
    version: "1.0.0",
    prompts: { schemas: promptSchemas },
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "1.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { server, client }
}

describe("createMcpServer — prompts/list", () => {
  it("lists prompts derived from the Node tree", async () => {
    const { client } = await connectedPromptClient()
    const { prompts } = await client.listPrompts()

    expect(prompts).toHaveLength(2)
    const names = prompts.map((p) => p.name).sort()
    expect(names).toEqual(["docs_critique", "summarize"])
  })

  it("derives arguments from the schema map", async () => {
    const { client } = await connectedPromptClient()
    const { prompts } = await client.listPrompts()

    const summarize = prompts.find((p) => p.name === "summarize")!
    expect(summarize.arguments).toEqual([
      { name: "text", description: "the text to summarize", required: true },
    ])
  })
})

describe("createMcpServer — prompts/get", () => {
  it("dispatches to the resolved handler and wraps a plain return value as a text message", async () => {
    const { client } = await connectedPromptClient()
    const result = await client.getPrompt({ name: "summarize", arguments: { text: "hello" } })

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]!.role).toBe("assistant")
    expect(result.messages[0]!.content).toEqual({
      type: "text",
      text: JSON.stringify("summary of: hello"),
    })
  })

  it("passes through a handler-returned GetPromptResult shape as-is", async () => {
    const { client } = await connectedPromptClient()
    const result = await client.getPrompt({ name: "docs_critique", arguments: { text: "hello" } })

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]!.role).toBe("user")
    expect(result.messages[0]!.content).toEqual({ type: "text", text: "critique this: hello" })
  })

  it("an unknown prompt name rejects with an error", async () => {
    const { client } = await connectedPromptClient()
    await expect(client.getPrompt({ name: "does_not_exist", arguments: {} })).rejects.toThrow()
  })
})

describe("createMcpServer — prompt capability advertisement", () => {
  it("does not advertise prompts capability when the tree has no prompt leaves", async () => {
    const server = createMcpServer(tree, { name: "no-prompts-server", version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "1.0.0" })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    await expect(client.listPrompts()).rejects.toThrow()
  })
})

// ============================================================================
// 7. Rich content pass-through — tools/call and resources/read
// ============================================================================
//
// A handler's return shape drives the content type: a plain value still
// wraps as text (backward compat), but a value that already looks like MCP
// content (or an array of such values) passes through untouched instead of
// being flattened to JSON text.

const richContentTree = api_({
  plain: op((_: unknown) => ({ id: "1", name: "Alice" })),
  str: op((_: unknown) => "hello world"),
  image: op((_: unknown) => ({ type: "image", data: "YWJj", mimeType: "image/png" })),
  multi: op((_: unknown) => [
    { type: "text", text: "first" },
    { type: "text", text: "second" },
  ]),
  coincidentalType: op((_: unknown) => ({ type: "widget", name: "not-mcp-content" })),
})

async function connectedRichContentClient() {
  const server = createMcpServer(richContentTree, { name: "rich-content-server", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "1.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { server, client }
}

describe("createMcpServer — tools/call rich content", () => {
  it("a plain object return value still wraps as a JSON text block (backward compat)", async () => {
    const { client } = await connectedRichContentClient()
    const result = await client.callTool({ name: "plain", arguments: {} })

    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(content).toHaveLength(1)
    expect(content[0]!.type).toBe("text")
    expect(JSON.parse(content[0]!.text)).toEqual({ id: "1", name: "Alice" })
  })

  it("a string return value becomes text content verbatim, not double-stringified", async () => {
    const { client } = await connectedRichContentClient()
    const result = await client.callTool({ name: "str", arguments: {} })

    const content = result.content as Array<{ type: string; text: string }>
    expect(content).toHaveLength(1)
    expect(content[0]!.text).toBe("hello world")
    expect(content[0]!.text).not.toBe(JSON.stringify("hello world"))
  })

  it("a handler returning an image content object passes through untouched", async () => {
    const { client } = await connectedRichContentClient()
    const result = await client.callTool({ name: "image", arguments: {} })

    expect(result.content).toEqual([{ type: "image", data: "YWJj", mimeType: "image/png" }])
  })

  it("a handler returning an array of content items passes through as multiple content entries", async () => {
    const { client } = await connectedRichContentClient()
    const result = await client.callTool({ name: "multi", arguments: {} })

    expect(result.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ])
  })

  it("an object with a coincidental non-MCP `type` field still gets wrapped as text (no false positive)", async () => {
    const { client } = await connectedRichContentClient()
    const result = await client.callTool({ name: "coincidentalType", arguments: {} })

    const content = result.content as Array<{ type: string; text: string }>
    expect(content).toHaveLength(1)
    expect(content[0]!.type).toBe("text")
    expect(JSON.parse(content[0]!.text)).toEqual({ type: "widget", name: "not-mcp-content" })
  })
})

const richResourceTree = api_({
  plainResource: op((_: unknown) => ({ theme: "dark" }), {
    mcp: { as: "resource", mimeType: "application/json" },
  }),
  textResource: op((_: unknown) => ({ text: "raw text content", mimeType: "text/plain" }), {
    mcp: { as: "resource" },
  }),
  blobResource: op((_: unknown) => ({ blob: "YWJj" }), {
    mcp: { as: "resource" },
  }),
})

async function connectedRichResourceClient() {
  const server = createMcpServer(richResourceTree, { name: "rich-resource-server", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "1.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { server, client }
}

describe("createMcpServer — resources/read rich content", () => {
  it("a plain object return value still wraps as JSON text (backward compat)", async () => {
    const { client } = await connectedRichResourceClient()
    const result = await client.readResource({ uri: "resource://plainResource" })

    const content = result.contents[0] as { text: string; mimeType?: string }
    expect(JSON.parse(content.text)).toEqual({ theme: "dark" })
    expect(content.mimeType).toBe("application/json")
  })

  it("a handler returning { text, mimeType } directly uses those fields instead of JSON.stringify", async () => {
    const { client } = await connectedRichResourceClient()
    const result = await client.readResource({ uri: "resource://textResource" })

    const content = result.contents[0] as { text: string; mimeType?: string }
    expect(content.text).toBe("raw text content")
    expect(content.mimeType).toBe("text/plain")
  })

  it("a handler returning { blob } directly uses the blob field", async () => {
    const { client } = await connectedRichResourceClient()
    const result = await client.readResource({ uri: "resource://blobResource" })

    const content = result.contents[0] as { blob: string }
    expect(content.blob).toBe("YWJj")
  })
})

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

// ============================================================================
// 8. Shared input pipeline (packages/api-tree/src/input.ts) — sourceMap
// ============================================================================
//
// Tool calls, resource template reads, and prompt calls are all now
// assembled via the shared `assemble` pipeline (packages/api-tree/src/input.ts)
// — stores are plain objects with property access — instead of
// handing the raw arguments/captured-vars object to the handler directly.
// With no `meta.mcp.sourceMap`, this must be behaviorally identical to
// before (already covered by the describe blocks above, all still
// passing). These tests cover the NEW capability: `sourceMap` lets a leaf
// pull a named param from a different key (or, in the future, a different
// store) than the surface's default convention.

describe("createMcpServer — sourceMap support (tools)", () => {
  const sourceMapTree = api_({
    // Handler expects `id`, but sourceMap pulls it from the `identifier` key
    // of the call's `arguments` — an aliasing override, not the default
    // same-named lookup.
    get: op((input: { id: string }) => ({ id: input.id, name: "Alice" }), {
      mcp: { sourceMap: { id: { store: "argument", key: "identifier" } } },
    }),
  })

  async function connectedSourceMapClient() {
    const server = createMcpServer(sourceMapTree, { name: "sourcemap-tool-server", version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "1.0.0" })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    return { client }
  }

  it("resolves a param from its sourceMap-declared key instead of its own name", async () => {
    const { client } = await connectedSourceMapClient()
    const result = await client.callTool({ name: "get", arguments: { identifier: "42" } })

    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(JSON.parse(content[0]!.text)).toEqual({ id: "42", name: "Alice" })
  })

  it("without sourceMap, a tool still resolves params by their own name (unchanged default)", async () => {
    const { client } = await connectedClient()
    const result = await client.callTool({ name: "users_get", arguments: { id: "42" } })

    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(JSON.parse(content[0]!.text)).toEqual({ id: "42", name: "Alice" })
  })
})

describe("createMcpServer — sourceMap support (resource templates)", () => {
  const sourceMapResourceTree = api_({
    users: api_({}, {
      fallback: {
        name: "userId",
        subtree: api_({
          // Handler expects `id`, sourceMap pulls it from the "uri-variable"
          // store's "userId" key (the fallback-captured segment name).
          profile: op((input: { id: string }) => ({ id: input.id, name: "Alice" }), {
            mcp: { as: "resource", sourceMap: { id: { store: "uri-variable", key: "userId" } } },
          }),
        }),
      },
    }),
  })

  async function connectedSourceMapResourceClient() {
    const server = createMcpServer(sourceMapResourceTree, {
      name: "sourcemap-resource-server",
      version: "1.0.0",
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "1.0.0" })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    return { client }
  }

  it("resolves a template param from its sourceMap-declared key instead of the captured var's own name", async () => {
    const { client } = await connectedSourceMapResourceClient()
    const result = await client.readResource({ uri: "resource://users/42/profile" })

    expect(result.contents).toHaveLength(1)
    const content = result.contents[0] as { text: string }
    expect(JSON.parse(content.text)).toEqual({ id: "42", name: "Alice" })
  })

  it("without sourceMap, a resource template still binds the captured var by its own name (unchanged default)", async () => {
    const { client } = await connectedResourceClient()
    const result = await client.readResource({ uri: "resource://users/42/profile" })

    expect(result.contents).toHaveLength(1)
    const content = result.contents[0] as { text: string }
    expect(JSON.parse(content.text)).toEqual({ id: "42", name: "Alice" })
  })
})

// ============================================================================
// 9. Streaming — a handler returning an AsyncIterable (async generator) is
// drained into progress notifications + collected content instead of going
// through the plain-value path. See docs/design/middleware-and-caller-
// context.md's "Streaming and Progress" section.
// ============================================================================

const streamingTree = api_({
  // Progress + chunk effects, untagged yields, and a generator return value —
  // all four kinds this projector must interpret.
  progressAndChunks: op(async function* (_: unknown) {
    yield { kind: "progress" as const, progress: 1, total: 3 }
    yield { kind: "chunk" as const, data: "first" }
    yield { kind: "progress" as const, progress: 2, total: 3 }
    yield { kind: "chunk" as const, data: "second" }
    return "done"
  }),
  untaggedOnly: op(async function* (_: unknown) {
    yield "alpha"
    yield "beta"
  }),
  noReturn: op(async function* (_: unknown) {
    yield { kind: "chunk" as const, data: "only-chunk" }
  }),
  plainNonStreaming: op((_: unknown) => "not a stream"),
})

async function connectedStreamingClient() {
  const server = createMcpServer(streamingTree, { name: "streaming-test-server", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "1.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client }
}

describe("createMcpServer — tools/call streaming", () => {
  it("sends a progress notification for each StreamProgress yield when the caller supplies a progressToken", async () => {
    const { client } = await connectedStreamingClient()
    const progressUpdates: unknown[] = []

    const result = await client.callTool(
      { name: "progressAndChunks", arguments: {} },
      undefined,
      { onprogress: (p) => progressUpdates.push(p) },
    )

    expect(result.isError).toBeFalsy()
    expect(progressUpdates).toEqual([
      { progress: 1, total: 3 },
      { progress: 2, total: 3 },
    ])
  })

  it("does not send progress notifications when the caller supplies no progressToken", async () => {
    const { client } = await connectedStreamingClient()
    const progressUpdates: unknown[] = []
    // No `onprogress` option — the SDK never attaches a progressToken to the
    // request, so the server-side check on `extra._meta?.progressToken` must
    // skip sending notifications entirely (not just skip client-side
    // reporting of the same notifications).
    const result = await client.callTool({ name: "progressAndChunks", arguments: {} })

    expect(result.isError).toBeFalsy()
    expect(progressUpdates).toEqual([])
  })

  it("collects StreamChunk yields into content blocks, in yield order", async () => {
    const { client } = await connectedStreamingClient()
    const result = await client.callTool({ name: "progressAndChunks", arguments: {} })

    const content = result.content as Array<{ type: string; text: string }>
    // Two chunks ("first", "second") plus the generator's return value ("done").
    expect(content.map((c) => c.text)).toEqual(["first", "second", "done"])
  })

  it("treats untagged yields as chunks", async () => {
    const { client } = await connectedStreamingClient()
    const result = await client.callTool({ name: "untaggedOnly", arguments: {} })

    const content = result.content as Array<{ type: string; text: string }>
    expect(content.map((c) => c.text)).toEqual(["alpha", "beta"])
  })

  it("appends the generator's return value as the final content entry", async () => {
    const { client } = await connectedStreamingClient()
    const result = await client.callTool({ name: "progressAndChunks", arguments: {} })

    const content = result.content as Array<{ type: string; text: string }>
    expect(content[content.length - 1]!.text).toBe("done")
  })

  it("a generator with no meaningful return value still surfaces its chunks", async () => {
    const { client } = await connectedStreamingClient()
    const result = await client.callTool({ name: "noReturn", arguments: {} })

    const content = result.content as Array<{ type: string; text: string }>
    expect(content.map((c) => c.text)).toEqual(["only-chunk"])
  })

  it("a non-async-iterable return value is handled unchanged (backwards compat)", async () => {
    const { client } = await connectedStreamingClient()
    const result = await client.callTool({ name: "plainNonStreaming", arguments: {} })

    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(content).toHaveLength(1)
    expect(content[0]!.text).toBe("not a stream")
  })
})

// ============================================================================
// 10. opts.detection — opt-out of the Result/streaming structural sniffing
// (see CreateMcpServerOptions.detection). Both default to `true`.
// ============================================================================

describe("createMcpServer — detection", () => {
  const resultLikeTree = api_({
    getThing: op((_: unknown) => ({ kind: "ok", value: 42 })),
  })

  async function connectedClientFor(tree: ReturnType<typeof api_>, detection?: { result?: boolean; streaming?: boolean }) {
    const server = createMcpServer(tree, {
      name: "detection-test-server",
      version: "1.0.0",
      ...(detection !== undefined ? { detection } : {}),
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "1.0.0" })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    return { client }
  }

  it("defaults (detection omitted): Result-shape output is unwrapped, matching prior behavior", async () => {
    const { client } = await connectedClientFor(resultLikeTree)
    const result = await client.callTool({ name: "getThing", arguments: {} })

    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(JSON.parse(content[0]!.text)).toEqual(42)
  })

  it("detection.result: false — a Result-shaped return value passes through untouched", async () => {
    const { client } = await connectedClientFor(resultLikeTree, { result: false })
    const result = await client.callTool({ name: "getThing", arguments: {} })

    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(JSON.parse(content[0]!.text)).toEqual({ kind: "ok", value: 42 })
  })

  const streamingTree2 = api_({
    getStream: op(async function* (_: unknown) {
      yield 1
      yield 2
    }),
  })

  it("defaults (detection omitted): an async-iterable return value is drained/streamed, matching prior behavior", async () => {
    const { client } = await connectedClientFor(streamingTree2)
    const result = await client.callTool({ name: "getStream", arguments: {} })

    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(content.map((c) => c.text)).toEqual(["1", "2"])
  })

  it("detection.streaming: false — an async-iterable return value is NOT streamed; treated as a plain value", async () => {
    const { client } = await connectedClientFor(streamingTree2, { streaming: false })
    const result = await client.callTool({ name: "getStream", arguments: {} })

    // Not drained via collectStreamedToolContent — falls through to the
    // ordinary content path, which wraps the (async generator) object as a
    // single JSON text block rather than one block per yield.
    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(content).toHaveLength(1)
    expect(content.map((c) => c.text)).not.toEqual(["1", "2"])
  })
})

describe("createMcpServer — sourceMap support (prompts)", () => {
  const sourceMapPromptTree = api_({
    // Handler expects `text`, sourceMap pulls it from the `body` argument key.
    summarize: op((input: { text: string }) => `summary of: ${input.text}`, {
      mcp: { as: "prompt", sourceMap: { text: { store: "argument", key: "body" } } },
    }),
  })

  async function connectedSourceMapPromptClient() {
    const server = createMcpServer(sourceMapPromptTree, {
      name: "sourcemap-prompt-server",
      version: "1.0.0",
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "1.0.0" })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    return { client }
  }

  it("resolves a prompt argument from its sourceMap-declared key instead of its own name", async () => {
    const { client } = await connectedSourceMapPromptClient()
    const result = await client.getPrompt({ name: "summarize", arguments: { body: "hello" } })

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]!.content).toEqual({
      type: "text",
      text: JSON.stringify("summary of: hello"),
    })
  })

  it("without sourceMap, a prompt still resolves arguments by their own name (unchanged default)", async () => {
    const { client } = await connectedPromptClient()
    const result = await client.getPrompt({ name: "summarize", arguments: { text: "hello" } })

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]!.content).toEqual({
      type: "text",
      text: JSON.stringify("summary of: hello"),
    })
  })
})

// ============================================================================
// 11. Sampling — CreateMcpServerOptions.sampling opts a handler into
// `stores.caller.createMessage` (MCP's `sampling/createMessage`, wired to the
// SDK's own `Server.createMessage`).
//
// Note there is no "sampling capability advertisement" test mirroring the
// resources/prompts capability tests above: per the MCP spec, `sampling` is
// a CLIENT capability (the CLIENT declares support for being asked to
// sample), not a server one — `ServerCapabilitiesSchema`
// (@modelcontextprotocol/sdk/types.js) has no `sampling` field at all, so
// there is nothing for this server to advertise either way. What
// `CreateMcpServerOptions.sampling` actually gates is covered directly
// below: whether `stores.caller.createMessage` exists for a handler to call.
// A mock CLIENT-side `sampling/createMessage` handler stands in for "the
// connected client supports sampling" — the SDK's `Server.createMessage`
// itself asserts against the CLIENT's declared `ClientCapabilities.sampling`
// before sending the request, and `client.setRequestHandler` is how a test
// double answers it over `InMemoryTransport`, same wiring `Client` uses for
// real clients.
// ============================================================================

describe("createMcpServer — sampling", () => {
  it("stores.caller.createMessage is unavailable to a handler when sampling is not enabled", async () => {
    let sawCreateMessage: unknown = "not-checked"
    const samplingOffTree = api_({
      check: op((_: unknown) => ({ ok: true }), {}),
    })
    const server = createMcpServer(samplingOffTree, {
      name: "sampling-off-server",
      version: "1.0.0",
      middleware: [
        (next) => (input, stores) => {
          sawCreateMessage = stores.caller?.createMessage
          return next(input, stores)
        },
      ],
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: { sampling: {} } })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    await client.callTool({ name: "check", arguments: {} })
    expect(sawCreateMessage).toBeUndefined()
  })

  it("stores.caller.createMessage is available to a handler when sampling: true is passed", async () => {
    let sawCreateMessage: unknown = "not-checked"
    const samplingOnTree = api_({
      check: op((_: unknown) => ({ ok: true }), {}),
    })
    const server = createMcpServer(samplingOnTree, {
      name: "sampling-on-server",
      version: "1.0.0",
      sampling: true,
      middleware: [
        (next) => (input, stores) => {
          sawCreateMessage = stores.caller?.createMessage
          return next(input, stores)
        },
      ],
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: { sampling: {} } })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    await client.callTool({ name: "check", arguments: {} })
    expect(typeof sawCreateMessage).toBe("function")
  })

  // A leaf handler is always `(input) => output` (see api-tree's `Handler`
  // type, node.ts) — it never receives `stores` directly, only middleware
  // does (see this file's middleware.test.ts and server.ts's own doc on
  // `McpMiddleware`). So "a tool handler that uses createMessage" is wired
  // the same way any other caller-context value reaches a handler: a small
  // bridging middleware reads `stores.caller.createMessage` and runs the
  // rest of the call inside an `AsyncLocalStorage` context the handler can
  // read from — the exact pattern middleware.test.ts already demonstrates
  // for `stores.caller` in general ("middleware sets up an
  // AsyncLocalStorage caller-context the handler can read").
  const createMessageAls = new AsyncLocalStorage<CreateMessageFn>()
  const bridgeCreateMessage: McpMiddleware = (next) => (input, stores) => {
    const createMessage = stores.caller?.createMessage as CreateMessageFn | undefined
    if (createMessage === undefined) return next(input, stores)
    return createMessageAls.run(createMessage, () => next(input, stores))
  }

  it("a tool handler can call stores.caller.createMessage (bridged via ALS) and use the client's completion in its result", async () => {
    // Handler asks the connected client to complete a prompt built from its
    // own input, then folds the completion text into its return value — the
    // LLM-in-the-loop pattern sampling exists for.
    const askTree = api_({
      askLlm: op(async (input: { question: string }) => {
        const createMessage = createMessageAls.getStore()!
        const result = await createMessage({
          messages: [{ role: "user", content: { type: "text", text: input.question } }],
          maxTokens: 100,
        })
        const text = result.content.type === "text" ? result.content.text : ""
        return { question: input.question, answer: text }
      }, {}),
    })

    const server = createMcpServer(askTree, {
      name: "sampling-ask-server",
      version: "1.0.0",
      sampling: true,
      middleware: [bridgeCreateMessage],
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: { sampling: {} } })
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      // `SamplingMessage.content` is single-block-or-array (tool-call
      // support) — narrow to the single-text-block case this test sends.
      const firstMessage = request.params.messages[0]
      const firstBlock = firstMessage !== undefined
        ? (Array.isArray(firstMessage.content) ? firstMessage.content[0] : firstMessage.content)
        : undefined
      const askedText = firstBlock !== undefined && firstBlock.type === "text" ? firstBlock.text : ""
      return {
        model: "mock-model",
        role: "assistant",
        content: { type: "text", text: `answer to: ${askedText}` },
      }
    })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const result = await client.callTool({ name: "askLlm", arguments: { question: "what is 2+2?" } })

    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(JSON.parse(content[0]!.text)).toEqual({
      question: "what is 2+2?",
      answer: "answer to: what is 2+2?",
    })
  })

  it("stores.caller.createMessage rejects when the connected client hasn't declared sampling support", async () => {
    // Sampling is enabled server-side (opts.sampling: true), but the
    // connected CLIENT declares no `sampling` capability — the SDK's own
    // `Server.createMessage` asserts against the client's declared
    // capabilities and rejects before ever sending the request. Proves
    // `CreateMcpServerOptions.sampling` only controls whether the FIELD
    // exists on `stores.caller`, not whether the call itself can succeed —
    // that remains gated by the client, exactly as the MCP spec intends.
    const askTree = api_({
      askLlm: op(async (_input: unknown) => {
        const createMessage = createMessageAls.getStore()!
        await createMessage({
          messages: [{ role: "user", content: { type: "text", text: "hi" } }],
          maxTokens: 10,
        })
        return { ok: true }
      }, {}),
    })

    const server = createMcpServer(askTree, {
      name: "sampling-unsupported-client-server",
      version: "1.0.0",
      sampling: true,
      middleware: [bridgeCreateMessage],
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    // No `capabilities: { sampling: {} }` on the client this time.
    const client = new Client({ name: "test-client", version: "1.0.0" })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const result = await client.callTool({ name: "askLlm", arguments: {} })
    expect(result.isError).toBe(true)
  })
})

// ============================================================================
// 12. Logging — MCP Tier 2. `CreateMcpServerOptions.logging` opts a handler
// into `stores.caller.sendLog` (MCP's `notifications/message`, wired to the
// SDK's own `Server.sendLoggingMessage`) and advertises the `logging`
// server capability. Log-level negotiation (`logging/setLevel`) is the
// SDK's own doing once the capability is declared (see server.ts's
// "Logging" doc section) — covered here by proving a level below the
// client's negotiated minimum is actually dropped.
// ============================================================================

describe("createMcpServer — logging", () => {
  it("advertises the logging capability only when opts.logging is set", async () => {
    const tree = api_({ check: op((_: unknown) => ({ ok: true }), {}) })

    const offServer = createMcpServer(tree, { name: "logging-off-server", version: "1.0.0" })
    const [offClientTransport, offServerTransport] = InMemoryTransport.createLinkedPair()
    const offClient = new Client({ name: "test-client", version: "1.0.0" })
    await Promise.all([offServer.connect(offServerTransport), offClient.connect(offClientTransport)])
    expect(offClient.getServerCapabilities()?.logging).toBeUndefined()

    const onServer = createMcpServer(tree, { name: "logging-on-server", version: "1.0.0", logging: true })
    const [onClientTransport, onServerTransport] = InMemoryTransport.createLinkedPair()
    const onClient = new Client({ name: "test-client", version: "1.0.0" })
    await Promise.all([onServer.connect(onServerTransport), onClient.connect(onClientTransport)])
    expect(onClient.getServerCapabilities()?.logging).toEqual({})
  })

  it("stores.caller.sendLog is unavailable to a handler when logging is not enabled", async () => {
    let sawSendLog: unknown = "not-checked"
    const tree = api_({ check: op((_: unknown) => ({ ok: true }), {}) })
    const server = createMcpServer(tree, {
      name: "logging-off-server",
      version: "1.0.0",
      middleware: [
        (next) => (input, stores) => {
          sawSendLog = stores.caller?.sendLog
          return next(input, stores)
        },
      ],
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "1.0.0" })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    await client.callTool({ name: "check", arguments: {} })
    expect(sawSendLog).toBeUndefined()
  })

  it("stores.caller.sendLog is available to a handler when logging: true is passed", async () => {
    let sawSendLog: unknown = "not-checked"
    const tree = api_({ check: op((_: unknown) => ({ ok: true }), {}) })
    const server = createMcpServer(tree, {
      name: "logging-on-server",
      version: "1.0.0",
      logging: true,
      middleware: [
        (next) => (input, stores) => {
          sawSendLog = stores.caller?.sendLog
          return next(input, stores)
        },
      ],
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "1.0.0" })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    await client.callTool({ name: "check", arguments: {} })
    expect(typeof sawSendLog).toBe("function")
  })

  // A leaf handler is always `(input) => output` (never receives `stores`
  // directly, see the sampling section's matching comment above) — bridge
  // `sendLog` through ALS the same way `bridgeCreateMessage` does for
  // `createMessage`.
  const sendLogAls = new AsyncLocalStorage<SendLogFn>()
  const bridgeSendLog: McpMiddleware = (next) => (input, stores) => {
    const sendLog = stores.caller?.sendLog as SendLogFn | undefined
    if (sendLog === undefined) return next(input, stores)
    return sendLogAls.run(sendLog, () => next(input, stores))
  }

  it("a tool handler can call stores.caller.sendLog (bridged via ALS) and the client receives a notifications/message", async () => {
    const logTree = api_({
      doWork: op(async (input: { note: string }) => {
        const sendLog = sendLogAls.getStore()!
        await sendLog({ level: "info", data: { note: input.note }, logger: "doWork" })
        return { done: true }
      }, {}),
    })

    const server = createMcpServer(logTree, {
      name: "logging-emit-server",
      version: "1.0.0",
      logging: true,
      middleware: [bridgeSendLog],
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "1.0.0" })

    const received: Array<{ level: string; logger?: string | undefined; data: unknown }> = []
    client.setNotificationHandler(LoggingMessageNotificationSchema, async (notification) => {
      received.push(notification.params)
    })

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const result = await client.callTool({ name: "doWork", arguments: { note: "hello" } })
    expect(result.isError).toBeFalsy()

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({ level: "info", logger: "doWork", data: { note: "hello" } })
  })

  it("logging/setLevel negotiation: a message below the client's minimum level is dropped", async () => {
    const logTree = api_({
      doWork: op(async (_input: unknown) => {
        const sendLog = sendLogAls.getStore()!
        await sendLog({ level: "debug", data: "should be dropped" })
        await sendLog({ level: "error", data: "should arrive" })
        return { done: true }
      }, {}),
    })

    const server = createMcpServer(logTree, {
      name: "logging-negotiated-server",
      version: "1.0.0",
      logging: true,
      middleware: [bridgeSendLog],
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "1.0.0" })

    const received: Array<{ level: string; data: unknown }> = []
    client.setNotificationHandler(LoggingMessageNotificationSchema, async (notification) => {
      received.push(notification.params)
    })

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    // Client negotiates a minimum level of "error" via logging/setLevel — the
    // SDK's own Server registers this handler once `logging: true` declares
    // the capability (see server.ts's "Logging" doc section); no code in
    // this package handles the request itself.
    await client.setLoggingLevel("error")

    await client.callTool({ name: "doWork", arguments: {} })

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({ level: "error", data: "should arrive" })
  })
})
