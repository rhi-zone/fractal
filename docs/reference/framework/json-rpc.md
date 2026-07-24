# JSON-RPC

`@rhi-zone/fractal-json-rpc-api-projector` projects a `Node` tree into a JSON-RPC 2.0 surface — method dispatch over HTTP or WebSocket, plus a typed client — with method names derived from the tree path (dot-joined, e.g. `books.list`).

## What it does

`projectMethods`/`toMethods` walk the tree once into a flat `JsonRpcMethod[]` (name, params/result schema) plus a dispatch table keyed by that same dot-joined name. `createJsonRpcHttpHandler`/`createJsonRpcWebSocketHandlers` wrap that dispatch table in the JSON-RPC 2.0 request/response/error envelope (batch requests, notifications, the standard `-32xxx` error codes exported as `JSON_RPC_PARSE_ERROR` etc. from type-ir's `json-rpc` module — see [Type-IR: wire formats](../type-ir/wire-formats.md)).

## Basic usage

```ts
import { api, op } from "@rhi-zone/fractal-api-tree"
import { createJsonRpcHttpHandler } from "@rhi-zone/fractal-json-rpc-api-projector"

const tree = api({
  books: api({
    list: op(() => [{ id: "1", title: "Dune" }]),
  }),
})

const handler = createJsonRpcHttpHandler(tree)
// (req: Request) => Promise<Response>
// POST { "jsonrpc": "2.0", "method": "books.list", "params": {}, "id": 1 }
// -> { "jsonrpc": "2.0", "result": [{ "id": "1", "title": "Dune" }], "id": 1 }
```

## WebSocket

```ts
import { createJsonRpcWebSocketHandlers } from "@rhi-zone/fractal-json-rpc-api-projector"

const handlers = createJsonRpcWebSocketHandlers(tree)
// { onMessage(socket, data), ... } — wire into ws/Bun's WebSocket handlers
```

## Typed client

```ts
import { createJsonRpcHttpClient, createJsonRpcClient, createJsonRpcHttpCall } from "@rhi-zone/fractal-json-rpc-api-projector"

const client = createJsonRpcHttpClient(tree, "http://localhost:3000/rpc")
await client.books.list() // -> JSON-RPC call to method "books.list"

// or bring your own transport function:
const call = createJsonRpcHttpCall("http://localhost:3000/rpc")
const custom = createJsonRpcClient(tree, call)
```

`ClientError` (`JsonRpcClientError`) wraps a JSON-RPC error response (`code`/`message`/`data`).

## Key exports

| Export | Description |
|---|---|
| `toMethods(node, opts?)` / `projectMethods(node, opts?)` | `Node` → `JsonRpcMethod[]` / full result + dispatch table |
| `createJsonRpcHttpHandler(tree, opts?)` | Fetch-compatible HTTP handler |
| `createJsonRpcWebSocketHandlers(tree, opts?)` | WebSocket message handlers |
| `jsonRpcErrors(mapping)` | Error-to-JSON-RPC-code mapping |
| `createJsonRpcClient(tree, call)` | Typed proxy client over a `JsonRpcCall` function |
| `createJsonRpcHttpClient(tree, url, opts?)` / `createJsonRpcHttpCall(url, opts?)` | HTTP-transport client / raw call function |
