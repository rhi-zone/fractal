# @rhi-zone/fractal-client-api-projector

Runtime HTTP client derived from the HTTP projector's `HttpRoute` tree.

## What it does

Walks an already-projected `HttpRoute` tree once at construction time and
builds a nested proxy object that mirrors its shape: a route position with a
single method and no children/fallback becomes a callable that fires an HTTP
request to the matching server route, and each `fallback` (wildcard-capture)
node becomes a function that takes the slug value and returns the sub-client
for that bound subtree (e.g. `client.books.bookId("book-1").read()`). It's an
enumerating projection like OpenAPI/CLI-help, not a dispatching one — since
path and verb come straight from the route tree's own structure (children
keys, `fallback`, `methods` keys), requests match the server's route
dispatch exactly, with no re-derivation. The current surface is untyped
(`unknown`/generics); a codegen'd typed client is future work.

Co-located operations (multiple HTTP methods placed at the same route
position by `applyMoveTo` — e.g. read/replace/remove all landing on a
resource's fallback position) lose their authored Node child name in the
route tree itself; `createClient(node, opts)` recovers it via a
handler-identity name map built from the `Node` tree, so those members keep
names like `.read()`/`.replace()`/`.remove()` instead of surfacing as their
HTTP verb. `createClientFromRoute(route, opts)` — the core, `Node`-free
entry point — degrades those members to their lowercased verb
(`.get()`/`.put()`/`.delete()`) when no such map is available.

## Key exports

- `createClient(node, opts?)` — build the proxy client from a `Node` tree
  (projects internally via `httpProjection`, recovers co-located names)
- `createClientFromRoute(route, opts?)` — build the proxy client from an
  already-projected `HttpRoute` tree
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
