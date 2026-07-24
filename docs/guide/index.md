# Introduction

fractal is an HTTP/RPC/IPC API library where endpoints are plain data composed from a small set of primitives. Transports, validation, and static types are opt-in layers composed via combinators — not built into the core.

## Status

::: info Status: Early / In Development
Core packages are built and green. The example demonstrates the projection payoff. Not yet published.
:::

## Motivation

Hono's API surface is not a reflectable value: routes and middleware are registered procedurally, so the API shape cannot be traversed, transformed, or shared across transports without rewriting. Per-surface re-description and hand-synced types are the result.

fractal makes the API an inert-data structure that multiple interpreters walk to produce artifacts: an HTTP server, an OpenAPI document, a test harness. The structure is defined once; the surfaces are derived.

## Design Constraint

The primitive set must be small and uniform. Composed presets ship alongside the primitives.

This constraint is load-bearing: composability alone does not yield a small mental model. A maximally-composable core without presets shifts assembly burden to the user. A deliberately tiny primitive set plus presets makes the common cases simple without foreclosing the general case.

## Packages

| Package | Role |
|---------|------|
| `@rhi-zone/fractal-api-tree` | `api`, `op`, `mergeMeta`, `Node`, `Meta`, `Handler` — the protocol-agnostic tree model |
| `@rhi-zone/fractal-http-api-projector` | HTTP kit: `http.get`/`post`/`put`/`patch`/`delete`, `httpProjection`, `createFetch`, `makeRouterFromRoute`, `crud`, `toOpenApi` (OpenAPI 3.1 projection, auto-served at `/openapi.json` by `createFetch`), `createClient` (runtime HTTP client) |
| `@rhi-zone/fractal-mcp-api-projector` | MCP tool projection: `toTools` |
| `@rhi-zone/fractal-cli-api-projector` | CLI projection over the same tree |

## Quick Start

```ts
import { api, op } from '@rhi-zone/fractal-api-tree/node'
import { http } from '@rhi-zone/fractal-http-api-projector/verbs'
import { createFetch } from '@rhi-zone/fractal-http-api-projector'

const todos: Record<string, { id: string; title: string }> = {}

const app = api({
  todos: api({
    list: op(() => Object.values(todos), http.get),
    add: op((input: { title: string }) => {
      const id = `todo-${Object.keys(todos).length + 1}`
      const todo = { id, ...input }
      todos[id] = todo
      return todo
    }, http.post),
  }),
})

// Serve HTTP requests — GET /todos/list, POST /todos/add
const fetch = createFetch(app)
const response = await fetch(new Request('http://localhost/todos/list'))

// Project to OpenAPI — same tree, no re-description
import { toOpenApi } from '@rhi-zone/fractal-http-api-projector'
const doc = await toOpenApi(app, { title: 'Todos API', version: '1.0.0' })
// ...or just GET /openapi.json — createFetch auto-serves it by default
```

`op(fn, ...contributions)` attaches metadata (verb bundles, tags, custom
fields) to a handler; `api(children, opts?)` groups nodes into a branch.
Both return the same `Node` value — projections dispatch on `node.handler`
vs. `node.children`, not on a separate wrapper type.

## Protocol-agnostic core

The core (`@rhi-zone/fractal-api-tree`) knows nothing about HTTP verbs, URL paths, or procedure names — `Node`, `Meta`, `op`, and `api` are the entire surface. Protocol-specific combinators live in per-protocol kits that consume and produce that same `Node` type:

- **HTTP kit** (`@rhi-zone/fractal-http-api-projector`): `http.get`/`post`/`put`/`patch`/`delete` verb bundles, `httpProjection` (Node → HttpRoute), `createFetch` (OOTB fetch handler)
- **MCP kit** (`@rhi-zone/fractal-mcp-api-projector`): `toTools` (Node → MCP tool definitions)

A verb bundle like `http.get` is just a `Meta` value — `{ http: { directives: [...] }, tags: { readOnly: true } }` — passed as a contribution to `op`. Business logic and the core `api`/`op` combinators transfer unchanged across kits; only the metadata attached to each leaf differs per projection.

## Reflection built in

Every `Node` carries a `meta: Meta` descriptor built during tree construction. After construction:

```ts
import { toOpenApi } from '@rhi-zone/fractal-http-api-projector'
const doc = await toOpenApi(app, { title: 'My API', version: '1.0.0' })
// doc.paths has every route, parameter, and requestBody schema
// derived from the same node tree that runs requests
```

## Guides

- [Getting Started](./getting-started.md) — install, author a tree, project it to HTTP, MCP, CLI, and type-ir
- [Concepts](./concepts.md) — core model: nodes, dispatch, tags, projections, metadata
- [Authoring](./authoring.md) — how to build trees with `op`, `node`, `service`, `param`, verb-helper bundles, and `mergeMeta`
- [Decoding requests](./decode.md) — the stores-based decode system for turning a `Request` into handler input
- [The codegen CLI](./codegen-cli.md) — AOT validator generation from extracted leaf input types
- [Versioning](./versioning.md) — versioning model: layered strategies from zero-machinery to composed transforms _(design, not yet built)_
- [Design Philosophy](./design-philosophy.md) — the biases behind the shape of the library
