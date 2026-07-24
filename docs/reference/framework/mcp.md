# MCP

`@rhi-zone/fractal-mcp-api-projector` projects a `Node` tree into a Model Context Protocol surface — tools, resources, prompts — over the `@modelcontextprotocol/sdk`.

## What it does

Walks the tree once per surface: leaves default to MCP **tools**; a leaf tagged `meta.mcp.as: "resource"` becomes a fixed resource (or a resource *template* when it sits under a `fallback`, e.g. `books/{bookId}`); a leaf tagged `meta.mcp.as: "prompt"` becomes a prompt. `readOnlyHint`/`idempotentHint`/`destructiveHint` annotations are derived from `meta.tags` (three-valued: a hint key is emitted only when the tag resolves, never guessed).

`createMcpServer` returns an *unconnected* `Server` — same stance as `createFetch` returning a plain fetch handler — leaving transport choice to the caller. `createStdioMcpServer`/`createHttpMcpServer` are one-call presets for the two common transports.

## Basic usage

```ts
import { api, op } from "@rhi-zone/fractal-api-tree"
import { toTools, createMcpServer, createStdioMcpServer } from "@rhi-zone/fractal-mcp-api-projector"

const tree = api({
  books: api({
    list: op(() => [{ id: "1", title: "Dune" }], { tags: { readOnly: true } }),
  }),
  config: op(() => ({ theme: "dark" }), { mcp: { as: "resource" } }),
})

// Just the tool descriptors:
const tools = toTools(tree)
// [{ name: "books_list", description: ..., inputSchema: {...}, annotations: { readOnlyHint: true } }]

// A full server, wired to stdio (Claude Desktop, local dev):
const server = await createStdioMcpServer(tree, { name: "books", version: "1.0.0" })

// ...or take the unconnected Server and pick your own transport:
const raw = createMcpServer(tree, { name: "books", version: "1.0.0" })
await raw.connect(myTransport)
```

## HTTP transport

```ts
import { createHttpMcpServer } from "@rhi-zone/fractal-mcp-api-projector"

const handler = await createHttpMcpServer(tree, { name: "books", version: "1.0.0" })
// (req: Request) => Promise<Response> — drop into Bun.serve/Deno.serve/a Worker directly
```

Session-based per the Streamable HTTP spec: requests are routed by `Mcp-Session-Id`, keyed off an internal `Map<sessionId, { server, transport }>` created on `initialize`.

## Typed client

```ts
import { createMcpClient } from "@rhi-zone/fractal-mcp-api-projector"

const client = createMcpClient(tree, sdkClient) // sdkClient: an SDK Client already connected to the server
await client.books.list()
```

Mirrors the tree the same way the HTTP client does — the client's independently-derived tool names/URIs land on the exact handlers the server's own projection dispatches to.

## Key exports

| Export | Description |
|---|---|
| `toTools(node, opts?)` | `Node` → `McpTool[]` |
| `projectTools`/`projectResources`/`projectPrompts` | Lower-level: descriptors + dispatch table in one walk |
| `createMcpServer(tree, opts)` | Unconnected `Server` |
| `createStdioMcpServer(tree, opts)` / `createHttpMcpServer(tree, opts)` | Transport-owning one-call presets |
| `createMcpClient(tree, sdkClient)` | Typed proxy client |
| `mcpErrors`/`validateAgainstSchema` | Error mapping + input validation helpers |
