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
| `@rhi-zone/fractal-core` | `Node<P,Res>`, `Handler`, `Req`, `Pass`, `choice`, `pipe`, `capture`, `typed`, `leaf`, `run`, `resolveSchema`, Standard Schema types |
| `@rhi-zone/fractal-http` | HTTP kit: `path`, `methods`, `param`, `query`, `header`, `body`, `validate`, `serve` |
| `@rhi-zone/fractal-worker` | Worker/in-process kit: `procedure`, `field`, `dispatch` |
| `@rhi-zone/fractal-openapi` | OpenAPI 3.0 / JSON-Schema projection: `toOpenApi`, `toJsonSchema` |

## Quick Start

```ts
import { path, methods, param, body, validate, serve, leaf } from '@rhi-zone/fractal-http'

const app = path({
  todos: methods({
    GET: leaf(async () => todos),
    POST: body(validate(todoSchema, async (req) => create(req.body))),
  }),
})

// Serve an HTTP request
const response = await serve(app, { method: 'GET', url: '/todos' })

// Project to OpenAPI — same node, no re-description
import { toOpenApi } from '@rhi-zone/fractal-openapi'
const doc = toOpenApi(app, { title: 'Todos API', version: '1.0.0' })
```

`validate` accepts a `StandardSchemaV1` — validation and the emitted OpenAPI schema both come from the same object. No hand-rolling schemas twice.

## Protocol-agnostic core

The core (`fractal-core`) knows nothing about HTTP verbs, URL paths, or procedure names. Protocol-specific combinators live in per-protocol kits that consume and produce the same `Node<P,Res>` type:

- **HTTP kit** (`fractal-http`): `methods`, `path`, `param`, `query`, `header`, `body`, `validate`, `serve`
- **Worker kit** (`fractal-worker`): `procedure`, `field`, `dispatch`

`NodeMiddleware = (n: Node<P,Res>) => Node<P,Res>` is the extension point for cross-cutting concerns: an auth middleware wraps a node, contributes a security descriptor to `meta`, and enforces at request time. Business logic and core combinators transfer unchanged across kits.

## Reflection built in

Every `Node` carries a `meta: Meta` descriptor built during route construction. After construction:

```ts
import { toOpenApi } from '@rhi-zone/fractal-openapi'
const doc = toOpenApi(app, { title: 'My API', version: '1.0.0' })
// doc.paths has every route, parameter, requestBody schema, and security requirement
// derived from the same node tree that runs requests
```

## Guides

- [Concepts](./concepts.md) — core model: nodes, dispatch, tags, projections, metadata
- [Authoring](./authoring.md) — how to build trees with `op`, `node`, `service`, `param`, verb-helper bundles, and `mergeMeta`
- [Versioning](./versioning.md) — versioning model: layered strategies from zero-machinery to composed transforms _(design, not yet built)_
