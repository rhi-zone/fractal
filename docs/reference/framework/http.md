# HTTP

`@rhi-zone/fractal-http-api-projector` renders a `Node` tree into a WHATWG-request/response HTTP surface — router, OpenAPI 3.1 document, and typed client, all from the same tree.

## What it does

Walks the tree once into an `HttpRoute` (via `httpProjection`), then compiles that route into a dispatchable router. Path/verb come from `http.get`/`http.post`/etc verb bundles attached to each `op`; a route with no explicit verb defaults to a convention. `toOpenApi` and `createClient` both walk the *same* `HttpRoute`, so the server, its docs, and its client can never drift apart.

## Basic usage

```ts
import { api, op } from "@rhi-zone/fractal-api-tree"
import { http } from "@rhi-zone/fractal-http-api-projector/verbs"
import { createFetch } from "@rhi-zone/fractal-http-api-projector"

const tree = api({
  books: api({
    list: op(() => [{ id: "1", title: "Dune" }], http.get),
    add: op((input: { title: string }) => ({ id: "2", ...input }), http.post),
  }),
})

const fetch = createFetch(tree)
await fetch(new Request("http://localhost/books/list"))       // GET
await fetch(new Request("http://localhost/openapi.json"))     // auto-served OpenAPI 3.1
```

## OpenAPI

```ts
import { toOpenApi } from "@rhi-zone/fractal-http-api-projector"

const doc = await toOpenApi(tree, { title: "Books API", version: "1.0.0" })
// doc.paths["/books/list"].get, doc.paths["/books/add"].post, ...
```

`createFetch`'s `openapi` preset option (default `true`) mounts this at `GET /openapi.json` lazily and caches the built document. `meta.openapi` on a leaf (`operationId`, `summary`, `description`, `tags`, `deprecated`) carries per-operation overrides.

## Typed client

```ts
import { createClient } from "@rhi-zone/fractal-http-api-projector"

const client = createClient(tree)
await client.books.list()                 // GET /books/list
await client.books.add({ title: "Dune" }) // POST /books/add
```

The client is a nested proxy mirroring the route tree: branches become nested objects, a `fallback` becomes a function keyed by its capture name (`client.books.bookId("book-1").read()`), leaves become async callables. `ClientError` wraps a non-OK response.

## Key exports

| Export | From |
|---|---|
| `http.get`/`.post`/`.put`/`.patch`/`.delete`/`.head`/`.options` | `./verbs` — verb-helper `Meta` bundles, imply behavioral tags (`http.get` → `readOnly: true`) |
| `crud(handlers)` | `./dx` — convention constructor for the 5-op REST-resource shape |
| `httpProjection(tree, opts?)` | `./dx` — `Node => HttpRoute` |
| `toRouter`/`radixRouter`/`compiledCharRouter` | Compile an `HttpRoute` into a dispatchable router |
| `createFetch(tree, opts?)` | One-call fetch handler (router + OpenAPI mounted) |
| `toOpenApi(node, opts?)` / `toOpenApiFromRoute(route, opts?)` | `Node`/`HttpRoute` → OpenAPI 3.1 document |
| `createClient(tree, opts?)` / `createClientFromRoute(route, opts?)` | `Node`/`HttpRoute` → typed proxy client |
| `retry`/`timeout`/`interceptors`/`logging`/`pagination` | Client extensions (`./extensions/*`) |

See [`docs/api/index.md`](../../api/index.md) for the full export table.
