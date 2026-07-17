# @rhi-zone/fractal-client-api-projector

Runtime HTTP client derived from the function-core tree.

## What it does

Walks an `api()`/`op()` tree once at construction time and builds a nested
proxy object that mirrors the tree's shape: each leaf becomes a callable
that fires an HTTP request to the matching server route, and each
`fallback` (wildcard-capture) node becomes a function that takes the slug
value and returns the sub-client for that bound subtree (e.g.
`client.books.bookId("book-1").read()`). It's an enumerating projection
like OpenAPI/CLI-help, not a dispatching one — verb and path derivation
mirror `verbFromTags`/segment-inference from `@rhi-zone/fractal-http-api-projector` so
requests match the server's tree-walk router exactly. The current surface
is untyped (`unknown`/generics); a codegen'd typed client is future work.

## Key exports

- `createClient(tree, opts?)` — build the proxy client from a `Node` tree
- `ClientOptions` — `baseUrl`, injectable `fetch`
- `AnyClient` — the untyped proxy client's type
- `ClientError` — error thrown for non-2xx responses

## Usage

```ts
import { createClient } from "@rhi-zone/fractal-client-api-projector"
import { createFetch } from "@rhi-zone/fractal-http-api-projector/preset"
import { api } from "./tree.ts"

// in-process, no network:
const client = createClient(api, { fetch: createFetch(api) })

const book = await client.books.add({ title: "Dune", author: "Herbert", genre: "sci-fi" })
const same = await client.books.bookId(book.id).read()
```
