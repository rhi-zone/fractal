# @rhi-zone/fractal-json-rpc-api-projector

JSON-RPC 2.0 projection for the function-core `Node` tree.

## What it does

Walks an `api()`/`op()` tree and produces a flat `JsonRpcMethod[]` — one per
leaf — plus the name → handler dispatch table the transports resolve calls
through. Method names are DOT-joined from tree position (`users.list`,
`books.bookId.get`), not MCP's underscore-joined convention; a `fallback`
node contributes its own name as a literal segment, with the captured value
resolved through `params` at call time. Tags (`readOnly`/`destructive`/
`idempotent`/`streaming`/`deprecated`) surface as flat three-valued fields on
the method descriptor. Ships two transports over the same dispatch core —
`createJsonRpcHttpHandler` (HTTP POST, single endpoint, batch requests per
§6) and `createJsonRpcWebSocketHandlers` (duck-typed `{ message }` handler
for Bun/`ws`/Deno) — plus a typed client (`createJsonRpcClient`/
`createJsonRpcHttpClient`) built as a recursive proxy over the same tree. A
handler returning an `AsyncIterable` streams as JSON-RPC Notifications over
WebSocket (correlated to the call via `subscription: id`) or drains to an
array over HTTP, which has no push channel.

## Key exports

- `projectMethods(tree, opts?)` / `toMethods` — walk a `Node` tree into `JsonRpcMethod[]` + dispatch table (`./project`)
- `createJsonRpcHttpHandler(tree, opts?)` — `(req: Request) => Promise<Response>` HTTP POST transport (`./server`)
- `createJsonRpcWebSocketHandlers(tree, opts?)` — `{ message }` handler for any WebSocket server (`./server`)
- `jsonRpcErrors(mapping)` — `Result.err` → JSON-RPC error-object encoder, mirrors `mcpErrors`/`httpErrors`
- `createJsonRpcClient(tree, call)` — transport-agnostic typed client proxy (`./client`)
- `createJsonRpcHttpClient(tree, url, opts?)` / `createJsonRpcHttpCall` — HTTP POST client convenience
- `./wire` — wire-format types (`JsonRpcRequest`, `JsonRpcResponse`, ...) and standard error codes (`JSON_RPC_PARSE_ERROR`, ...)

## Usage

```ts
import { api, op } from "@rhi-zone/fractal-api-tree";
import {
  createJsonRpcHttpHandler,
  createJsonRpcHttpClient,
} from "@rhi-zone/fractal-json-rpc-api-projector";

const tree = api({
  books: api({
    list: op(() => []),
  }),
});

const handler = createJsonRpcHttpHandler(tree);
// POST { jsonrpc: "2.0", method: "books.list", params: {}, id: 1 }

const client = createJsonRpcHttpClient(tree, "http://localhost/rpc");
const books = await client.books.list();
```

## Install

```bash
bun add @rhi-zone/fractal-json-rpc-api-projector
```

See the [root README](../../README.md) for the full picture across all projections.
