# @rhi-zone/fractal-example-library-api

Live end-to-end example: a library domain (books, catalog search, checkout)
authored once and projected to HTTP, MCP, and OpenAPI.

## What it does

`src/tree.ts` builds a single `api()`/`op()` tree and projects it through
`httpProjection()` to an `HttpRoute` that `createFetch` serves. `src/app.test.ts`
exercises the same tree through `createFetch` (HTTP), `toTools` (MCP), and
`extractToolSchemas` (codegen) to show that one authoring surface drives all
three without redundant per-projection wiring.

Patterns demonstrated:

- **`service()` class authoring** — `BooksService`'s methods (`list`, `add`)
  become leaf nodes automatically; a field literally named `fallback`
  (`{ name, subtree }`) becomes the node's wildcard-capture, replacing the
  old `param()`.
- **`moveTo` co-location** — `read`/`replace`/`remove` leaves live inside the
  `bookId` fallback subtree but each carries a `moveTo: ".."` directive so
  the HTTP pipeline places them at `/books/{bookId}` instead of nesting
  another path segment; `checkout` has no `moveTo` and stays nested.
  MCP/CLI/OpenAPI projections read raw tree position (no `moveTo`), so a
  `meta.http.dispatch = { kind: "method" }` marker on the parent node
  independently tells those projections the same co-location fact.
- **`http.*` verb-helper bundles** — `http.get`/`http.post`/`http.put`/
  `http.delete` each bundle a verb directive with implied tags
  (`readOnly`, `idempotent`, `destructive`), which light up MCP annotation
  hints and CLI confirmation prompts with no separate authoring.
  Per-leaf tags do not inherit from ancestor nodes.
  `checkout.start`/`checkout.reserve` show a branch/action subtree nested
  under a fallback with no placement needed.
- **CRUD-shaped resource, hand-assembled** — `catalog.search`/`catalog.genres`
  are plain `op(fn, http.get)` leaves grouped under `api()`, showing the
  pattern `crud()` automates for the standard 5-op case.
- **Codegen entry point** — `tree.ts` exports `api` so
  `extractToolSchemas` can walk the `api()` call and derive input schemas
  for inline ops (the `service()`-authored `books` subtree is skipped by
  codegen and degrades to the MCP spec-minimum placeholder schema).

## Usage

```ts
import { api, httpRoutes } from "./src/tree.ts"
import { createFetch } from "@rhi-zone/fractal-http/preset"
import { toTools } from "@rhi-zone/fractal-mcp"

const fetch = createFetch(api)
const res = await fetch(new Request("http://localhost/books/list"))

const tools = toTools(api) // MCP tool list for the same tree
```

Run the tests: `bun test` (from this directory or the workspace root).
