// packages/api-tree/src/context.test.ts — createContext (./context.ts)
//
// Proves the cross-projector claim: ONE `createContext` call, fed one
// extractor per surface, produces `{ storage, init }` configs that plug
// directly into `createFetch`'s `PresetOptions.als`, `runCli`'s
// `CliOpts.als`, and `createMcpServer`'s `CreateMcpServerOptions.als` — with
// no cast at the call site (structural typing against `CliContextShape` /
// `McpContextShape` lines up with the real `CliAlsContext` / `McpAlsContext`)
// — and that `getStore()` reads back whichever surface most recently entered
// its context.

import { describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { runCli } from "@rhi-zone/fractal-cli-api-projector"
import { createGraphQLServer } from "@rhi-zone/fractal-graphql-api-projector"
import { createFetch } from "@rhi-zone/fractal-http-api-projector/preset"
import { createMcpServer } from "@rhi-zone/fractal-mcp-api-projector"
import { createContext } from "./context.ts"
import { api as api_, op } from "./node.ts"

type Ctx = { readonly source: string }

describe("createContext", () => {
  it("only includes projector configs for extractors that were provided", () => {
    const httpOnly = createContext<Ctx>({ http: () => ({ source: "http" }) })
    expect(httpOnly.http).toBeDefined()
    expect(httpOnly.cli).toBeUndefined()
    expect(httpOnly.mcp).toBeUndefined()

    const all = createContext<Ctx>({
      http: () => ({ source: "http" }),
      cli: () => ({ source: "cli" }),
      mcp: () => ({ source: "mcp" }),
      graphql: () => ({ source: "graphql" }),
    })
    expect(all.http).toBeDefined()
    expect(all.cli).toBeDefined()
    expect(all.mcp).toBeDefined()
    expect(all.graphql).toBeDefined()
  })

  it("all four configs share one AsyncLocalStorage instance", () => {
    const context = createContext<Ctx>({
      http: () => ({ source: "http" }),
      cli: () => ({ source: "cli" }),
      mcp: () => ({ source: "mcp" }),
      graphql: () => ({ source: "graphql" }),
    })
    expect(context.http?.storage).toBe(context.storage)
    expect(context.cli?.storage).toBe(context.storage)
    expect(context.mcp?.storage).toBe(context.storage)
    expect(context.graphql?.storage).toBe(context.storage)
  })

  it("http config drops directly into createFetch's PresetOptions.als", async () => {
    const context = createContext<Ctx>({ http: (req) => ({ source: `http:${new URL(req.url).pathname}` }) })
    const tree = api_({
      whoami: op((_: unknown) => ({ seen: context.getStore()?.source ?? "none" }), {
        http: { directives: [{ kind: "method", value: "GET" }] },
      }),
    })
    const fetchHandler = createFetch(tree, { als: context.http! })
    const res = await fetchHandler(new Request("http://localhost/whoami"))
    const body = (await res.json()) as { seen: string }
    expect(body.seen).toBe("http:/whoami")
    // Nothing active outside a dispatched request.
    expect(context.getStore()).toBeUndefined()
  })

  it("cli config drops directly into runCli's CliOpts.als", async () => {
    const context = createContext<Ctx>({ cli: (ctx) => ({ source: `cli:${ctx.leafName}` }) })
    const tree = api_({
      whoami: op((_: unknown) => ({ seen: context.getStore()?.source ?? "none" }), {}),
    })
    const out: string[] = []
    const io = {
      stdout: { write: (s: string) => { out.push(s) } },
      stderr: { write: (_: string) => {} },
      confirm: async () => true,
    }
    await runCli(tree, ["whoami"], io, { als: context.cli! })
    expect(JSON.parse(out.join(""))).toEqual({ seen: "cli:whoami" })
    expect(context.getStore()).toBeUndefined()
  })

  it("mcp config drops directly into createMcpServer's CreateMcpServerOptions.als", async () => {
    const context = createContext<Ctx>({ mcp: (ctx) => ({ source: `mcp:${ctx.name}` }) })
    const tree = api_({
      whoami: op((_: unknown) => ({ seen: context.getStore()?.source ?? "none" }), {}),
    })
    const server = createMcpServer(tree, { name: "test-server", version: "1.0.0", als: context.mcp! })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "1.0.0" })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const result = await client.callTool({ name: "whoami", arguments: {} })
    const content = (result as { content: Array<{ type: string; text?: string }> }).content[0]
    expect(JSON.parse(content?.text ?? "")).toEqual({ seen: "mcp:whoami" })
    expect(context.getStore()).toBeUndefined()
  })

  it("graphql config drops directly into createGraphQLServer's CreateGraphQLServerOptions.als", async () => {
    const context = createContext<Ctx>({ graphql: (ctx) => ({ source: `graphql:${ctx.fieldName}` }) })
    const tree = api_({
      whoami: op((_: unknown) => ({ seen: context.getStore()?.source ?? "none" }), { tags: { readOnly: true } }),
    })
    const server = createGraphQLServer(tree, { als: context.graphql! })
    const result = await server.execute("{ whoami }")
    expect(result.errors).toBeUndefined()
    expect(result.data).toEqual({ whoami: { seen: "graphql:whoami" } })
    expect(context.getStore()).toBeUndefined()
  })

  it("getStore() reflects whichever surface most recently entered its context, across all four", async () => {
    const context = createContext<Ctx>({
      http: () => ({ source: "http" }),
      cli: (ctx) => ({ source: `cli:${ctx.leafName}` }),
      mcp: (ctx) => ({ source: `mcp:${ctx.name}` }),
      graphql: (ctx) => ({ source: `graphql:${ctx.fieldName}` }),
    })

    // HTTP
    const httpTree = api_({
      whoami: op((_: unknown) => ({ seen: context.getStore()?.source }), {
        http: { directives: [{ kind: "method", value: "GET" }] },
      }),
    })
    const fetchHandler = createFetch(httpTree, { als: context.http! })
    const httpRes = await fetchHandler(new Request("http://localhost/whoami"))
    expect(((await httpRes.json()) as { seen: string }).seen).toBe("http")

    // CLI
    const cliTree = api_({ whoami: op((_: unknown) => ({ seen: context.getStore()?.source }), {}) })
    const out: string[] = []
    const io = {
      stdout: { write: (s: string) => { out.push(s) } },
      stderr: { write: (_: string) => {} },
      confirm: async () => true,
    }
    await runCli(cliTree, ["whoami"], io, { als: context.cli! })
    expect((JSON.parse(out.join("")) as { seen: string }).seen).toBe("cli:whoami")

    // MCP
    const mcpTree = api_({ whoami: op((_: unknown) => ({ seen: context.getStore()?.source }), {}) })
    const server = createMcpServer(mcpTree, { name: "test-server", version: "1.0.0", als: context.mcp! })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "1.0.0" })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const mcpResult = await client.callTool({ name: "whoami", arguments: {} })
    const content = (mcpResult as { content: Array<{ type: string; text?: string }> }).content[0]
    expect(JSON.parse(content?.text ?? "")).toEqual({ seen: "mcp:whoami" })

    // GraphQL
    const graphqlTree = api_({
      whoami: op((_: unknown) => ({ seen: context.getStore()?.source }), { tags: { readOnly: true } }),
    })
    const graphqlServer = createGraphQLServer(graphqlTree, { als: context.graphql! })
    const graphqlResult = await graphqlServer.execute("{ whoami }")
    expect(graphqlResult.errors).toBeUndefined()
    expect(graphqlResult.data).toEqual({ whoami: { seen: "graphql:whoami" } })

    // No leakage after all four have run.
    expect(context.getStore()).toBeUndefined()
  })
})
