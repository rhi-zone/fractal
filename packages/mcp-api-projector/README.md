# @rhi-zone/fractal-mcp-api-projector

MCP (Model Context Protocol) tool projection for the function-core tree.

## What it does

Walks an `api()`/`op()` tree and produces a flat list of MCP tools, one per
leaf handler. Each tool's name is derived from its tree position
(underscore-joined path), its input schema comes from a pre-computed
`SchemaMap` (see `@rhi-zone/fractal-codegen`) when provided, and its
annotation hints (`readOnlyHint`, `idempotentHint`, `destructiveHint`) are
derived automatically from the leaf's `meta.tags` — so `http.get`/`http.put`/
`http.delete` bundles light these up for free with no separate MCP-specific
authoring.

## Key exports

- `toTools(tree, opts?)` — walk a `Node` tree and return `McpTool[]`
- `McpTool`, `McpAnnotations`, `ToToolsOptions` — result and options types
- `SchemaMap`, `ToolSchema` — re-exported schema-map types

## Usage

```ts
import { toTools } from "@rhi-zone/fractal-mcp-api-projector"
import { api } from "./tree.ts"

const tools = toTools(api)
// tools[i] -> { name: "books_add", inputSchema: {...}, annotations: {...} }
```
