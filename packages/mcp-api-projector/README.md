# @rhi-zone/fractal-mcp-api-projector

MCP (Model Context Protocol) projection for the function-core tree.

## What it does

Walks an `api()`/`op()` tree and produces MCP tools, resources, and prompts
— one per leaf, driven by each leaf's tree position and `meta` (tags feed
tool annotation hints like `readOnlyHint`/`idempotentHint`/`destructiveHint`
for free; a `meta.mcp.resource`/`meta.mcp.prompt` marker routes a leaf into
`projectResources`/`projectPrompts` instead of `projectTools`). `createMcpServer`
wires all three projections plus sampling (`stores.caller.createMessage`,
so a handler can call back into the connected client's model) onto the SDK's
`Server`; `createStdioMcpServer`/`createHttpMcpServer` are one-call presets
for the two common transports. A generated `createMcpClient` gives a typed
caller over the same tree for testing or cross-service use.

## Key exports

- `toTools(tree, opts?)` / `projectTools`, `projectResources`, `projectPrompts` — walk a `Node` tree into `McpTool[]` / `McpResource[]` / `McpPrompt[]`
- `createMcpServer(tree, opts?)` — wire tools/resources/prompts + sampling onto an SDK `Server`
- `createStdioMcpServer`, `createHttpMcpServer` — transport-owning one-call presets
- `createMcpClient` — typed client over the projected tree
- `SamplingConfig`, `CreateMessageFn` and re-exported SDK sampling types (`CreateMessageRequestParams`, `CreateMessageResult`, ...)
- `mcpErrors`, `McpErrorEncoder` — structured error → MCP error-response mapping

## Usage

```ts
import { toTools, createStdioMcpServer } from "@rhi-zone/fractal-mcp-api-projector"
import { api } from "./tree.ts"

const tools = toTools(api)
// tools[i] -> { name: "books_add", inputSchema: {...}, annotations: {...} }

await createStdioMcpServer(api, { name: "library", version: "1.0.0" })
```

## Install

```bash
bun add @rhi-zone/fractal-mcp-api-projector
```

See the [root README](../../README.md) for the full picture across all projections.
