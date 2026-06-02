# fractal

HTTP/RPC/IPC API library where endpoints are plain data composed from a small set of primitives.

**https://docs.rhi.zone/fractal/**

The composition unit is `Node<P,Res> = { meta, handler }`. `meta` is the reflection descriptor — walkable, serialisable — built during route construction. `handler` is the executable. Transports, validation, and static types are opt-in layers composed via combinators; they are not in the core.

Multiple interpreters walk one `Node` tree to produce an HTTP server, an OpenAPI document, or a test harness from one definition.

## Packages

| Package | Role |
|---------|------|
| `@rhi-zone/fractal-core` | `Node<P,Res>`, `Handler`, `Req`, `Pass`, `choice`, `pipe`, `capture`, `typed`, `leaf`, `run`, `resolveSchema`, Standard Schema types |
| `@rhi-zone/fractal-http` | HTTP kit: `path`, `methods`, `param`, `query`, `header`, `body`, `validate`, `serve` |
| `@rhi-zone/fractal-worker` | Worker/in-process kit: `procedure`, `field`, `dispatch` |
| `@rhi-zone/fractal-openapi` | OpenAPI 3.0 / JSON-Schema projection: `toOpenApi`, `toJsonSchema` |

## Development

```bash
bun install
bun run build
bun run typecheck
bun run test
```
