# @rhi-zone/fractal

One install and one name for the whole framework — the function core plus every
protocol projection, each behind its own subpath.

## What it does

Nothing at runtime. This package is a pure re-export facade: the root is
`@rhi-zone/fractal-api-tree` (`api`/`op`/`Result`/the tag lattice), and each
protocol projector is a subpath. Every module in `src/` is a single
`export * from` line, so the umbrella can never drift from the surface it
fronts.

| Import | Fronts |
|---|---|
| `@rhi-zone/fractal` | [`@rhi-zone/fractal-api-tree`](../api-tree) — the `api()`/`op()` function core |
| `@rhi-zone/fractal/http` | [`@rhi-zone/fractal-http-api-projector`](../http-api-projector) |
| `@rhi-zone/fractal/cli` | [`@rhi-zone/fractal-cli-api-projector`](../cli-api-projector) |
| `@rhi-zone/fractal/json-rpc` | [`@rhi-zone/fractal-json-rpc-api-projector`](../json-rpc-api-projector) |
| `@rhi-zone/fractal/graphql` | [`@rhi-zone/fractal-graphql-api-projector`](../graphql-api-projector) — optional peer |
| `@rhi-zone/fractal/mcp` | [`@rhi-zone/fractal-mcp-api-projector`](../mcp-api-projector) — optional peer |

Each subpath re-exports its projector's **root** surface only. The fronted
packages' own deeper subpaths (`@rhi-zone/fractal-http-api-projector/preset`,
`/layers`, `/extensions/*`, ...) are not mirrored — import the projector package
directly for those. It is already installed as a dependency of this one.

## Install

```bash
bun add @rhi-zone/fractal
```

That gives you the core, HTTP, CLI, and JSON-RPC. GraphQL and MCP are **optional
peer dependencies** — they carry protocol-specific runtimes (`graphql` and
`@modelcontextprotocol/sdk`), so a consumer projecting only to HTTP does not
execute a GraphQL engine or the MCP SDK. Ask for them explicitly:

```bash
bun add @rhi-zone/fractal @rhi-zone/fractal-graphql-api-projector
bun add @rhi-zone/fractal @rhi-zone/fractal-mcp-api-projector
```

Importing `@rhi-zone/fractal/graphql` or `/mcp` without the matching peer
installed fails at module resolution, naming the package to add.

## Usage

Author the tree once, project it wherever:

```ts
import { api, op } from "@rhi-zone/fractal"
import { http, createFetch } from "@rhi-zone/fractal/http"
import { runCli } from "@rhi-zone/fractal/cli"
import { createJsonRpcHttpHandler } from "@rhi-zone/fractal/json-rpc"

const tree = api({
  books: api({
    list: op(() => [...store.values()], http.get),
  }),
})

const fetch = createFetch(tree)                     // HTTP + /openapi.json
const rpc = createJsonRpcHttpHandler(tree)          // JSON-RPC 2.0 over POST
await runCli(tree, ["books", "list"])               // CLI
```

## Why an umbrella instead of one merged package

The five projectors stay five packages because each carries its own
protocol-specific runtime, and a consumer who wants an HTTP router should not
install a GraphQL engine to get one. The umbrella removes the discovery
friction that split created without giving the bloat back: its dependency split
is drawn on exactly the same line as the package split, with the two
third-party-carrying projectors as optional peers.

`src/module-graph.test.ts` checks that rather than trusting it — it walks the
static import graph out of each facade module and fails if the `/http`, `/cli`,
`/json-rpc`, or root closure reaches graphql-js or the MCP SDK, with positive
controls proving the walk can see those runtimes where they genuinely are.

Full rationale, including the alternatives rejected and one measured caveat
about `type-ir`'s own dependencies:
[`docs/design/decisions.md`](../../docs/design/decisions.md) §
"Umbrella package `@rhi-zone/fractal`".

See the [root README](../../README.md) for the full picture across all projections.
