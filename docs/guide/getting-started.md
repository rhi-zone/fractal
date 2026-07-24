# Getting Started

::: info Status
Not yet published to npm. Install from the monorepo (git or workspace link) until packages ship — see [Status](./index.md#status).
:::

## Install

The core packages are separate npm packages, composed via workspace/git dependency until publish:

```sh
bun add @rhi-zone/fractal-api-tree
bun add @rhi-zone/fractal-http-api-projector   # HTTP + OpenAPI + typed client
bun add @rhi-zone/fractal-type-ir              # type projections (Zod, JSON Schema, SQL DDL, ...)
```

Add other projector packages as needed: `@rhi-zone/fractal-mcp-api-projector`, `@rhi-zone/fractal-cli-api-projector`, `@rhi-zone/fractal-graphql-api-projector`, `@rhi-zone/fractal-json-rpc-api-projector`.

## Author a tree

The unit of composition is a plain data tree, not a registered router. `api()` builds a branch, `op()` builds a leaf:

```ts
import { api, op } from "@rhi-zone/fractal-api-tree"
import { http } from "@rhi-zone/fractal-http-api-projector/verbs"

const books = new Map<string, { id: string; title: string; author: string }>()

const tree = api({
  books: api({
    list: op(() => [...books.values()], http.get),
    add: op((input: { title: string; author: string }) => {
      const id = `book-${books.size + 1}`
      const book = { id, ...input }
      books.set(id, book)
      return book
    }, http.post),
  }),
})
```

`op(fn, ...contributions)` attaches metadata (verb bundles, tags, custom fields) to a handler. `api(children, opts?)` groups nodes into a branch. Both return the same `Node` value — projections dispatch on `node.handler` vs `node.children`, not on a wrapper type.

## Project to HTTP

```ts
import { createFetch } from "@rhi-zone/fractal-http-api-projector"

const fetch = createFetch(tree)

const res = await fetch(new Request("http://localhost/books/list"))
await res.json() // []

const created = await fetch(new Request("http://localhost/books/add", {
  method: "POST",
  body: JSON.stringify({ title: "Dune", author: "Herbert" }),
}))
```

OpenAPI 3.1 is served for free at `GET /openapi.json` — `createFetch` builds and caches it lazily from the live route tree.

## Project the same tree elsewhere

```ts
import { toTools } from "@rhi-zone/fractal-mcp-api-projector"
const tools = toTools(tree)
// [{ name: "books_list", ... }, { name: "books_add", ... }]

import { runCli } from "@rhi-zone/fractal-cli-api-projector"
await runCli(tree, ["books", "add", "--title", "Dune", "--author", "Herbert"])
```

No re-description: the same `tree` value drives the HTTP router, the OpenAPI document, the MCP tool list, and the CLI. See the [Framework reference](../reference/framework/http.md) for HTTP/MCP/CLI/GraphQL/JSON-RPC in depth.

## Your first type projection

Independent of the API tree, `@rhi-zone/fractal-type-ir` projects a `TypeRef` — a small subtyping IR — to 20+ target languages/formats:

```ts
import { t, types } from "@rhi-zone/fractal-type-ir"
import { toZod } from "@rhi-zone/fractal-type-ir/zod"
import { toPython } from "@rhi-zone/fractal-type-ir/python"

const book = t(types.object({
  id: t(types.string),
  title: t(types.string),
  year: t(types.integer),
}))

toZod(book)
// z.object({ id: z.string(), title: z.string(), year: z.number().int() })

toPython(book, "Book")
// @dataclass
// class Book:
//     id: str
//     title: str
//     year: int
```

Every projector is `TypeRef => string` (or a small document type for schema-based formats). See the [Type-IR reference](../reference/type-ir/index.md) for the full catalog, grouped by language.

## Next

- [Concepts](./concepts.md) — the node/dispatch/tags/metadata model
- [Authoring](./authoring.md) — building trees with `op`, `service`, `param`, verb bundles
- [Design philosophy](./design-philosophy.md) — the biases behind the shape of the library
