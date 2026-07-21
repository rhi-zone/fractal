# fractal

Define your API as plain functions, project it to any protocol surface.

**https://docs.rhi.zone/fractal/**

The composition unit is `Node<P,Res> = { meta, handler }`. `meta` is the reflection descriptor — walkable, serialisable — built during route construction. `handler` is the executable. Transports, validation, and static types are opt-in layers composed via combinators; they are not in the core.

Write the tree once. Multiple interpreters walk it to produce an HTTP server with OpenAPI, a GraphQL server with SDL, an MCP server (tools/resources/prompts/sampling), a CLI, and type-safe clients for each — all from the same definition.

## Packages

| Package | Role |
|---------|------|
| [`@rhi-zone/fractal-api-tree`](packages/api-tree) | Core: `api`/`op` tree constructors, `Node`/`Handler`/`Meta`, the tag lattice, source-level schema extraction |
| [`@rhi-zone/fractal-type-ir`](packages/type-ir) | Type IR — subtyping hierarchy + open metadata bag, projectable to 20+ targets (JSON Schema, OpenAPI, GraphQL SDL, SQL DDL, Protobuf, Zod, ...) |
| [`@rhi-zone/fractal-http-api-projector`](packages/http-api-projector) | HTTP projection — compiled router, OpenAPI 3.1, typed client |
| [`@rhi-zone/fractal-graphql-api-projector`](packages/graphql-api-projector) | GraphQL projection — SDL, resolver dispatch, subscriptions, typed client |
| [`@rhi-zone/fractal-mcp-api-projector`](packages/mcp-api-projector) | MCP projection — tools, resources, prompts, sampling |
| [`@rhi-zone/fractal-cli-api-projector`](packages/cli-api-projector) | CLI projection — subcommand dispatch, shell completions, streaming |

## Quick example

Author once:

```ts
import { api, op } from "@rhi-zone/fractal-api-tree"
import { http } from "@rhi-zone/fractal-http-api-projector/verbs"

const tree = api({
  books: api({
    list: op(() => [...store.values()], http.get),
    add: op((input: { title: string; author: string }) => addBook(input), http.post),
  }),
})
```

Project to HTTP, with OpenAPI served for free:

```ts
import { createFetch } from "@rhi-zone/fractal-http-api-projector/preset"

const fetch = createFetch(tree)
await fetch(new Request("http://localhost/books/list"))
```

Project the same tree to MCP tools:

```ts
import { toTools } from "@rhi-zone/fractal-mcp-api-projector"

const tools = toTools(tree) // [{ name: "books_list", ... }, { name: "books_add", ... }]
```

...or to a CLI:

```ts
import { runCli } from "@rhi-zone/fractal-cli-api-projector"

await runCli(tree, ["books", "add", "--title", "Dune", "--author", "Herbert"])
```

...or to GraphQL SDL and a resolver map — see [`packages/graphql-api-projector`](packages/graphql-api-projector).

## Development

```bash
bun install
bun run typecheck
bun run test
```
