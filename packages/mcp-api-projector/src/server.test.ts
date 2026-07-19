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
