# fractal

HTTP/RPC/IPC API library where endpoints are plain data composed from a small set of primitives.

**https://docs.rhi.zone/fractal/**

The composition unit is `Node<P,Res> = { meta, handler }`. `meta` is the reflection descriptor — walkable, serialisable — built during route construction. `handler` is the executable. Transports, validation, and static types are opt-in layers composed via combinators; they are not in the core.

Multiple interpreters walk one `Node` tree to produce an HTTP server, an OpenAPI document, or a typed client — from one definition.

## Packages

| Package | Role |
|---------|------|
| `@rhi-zone/fractal-api-tree` | `Node<P,Res>`, `Handler`, `Req`, `Pass`, `choice`, `pipe`, `capture`, `typed`, `leaf`, `run`, `resolveSchema`, Standard Schema types |
| `@rhi-zone/fractal-http-api-projector` | HTTP kit: `path`, `methods`, `param`, `query`, `header`, `body`, `validate`, `route`, `serve`; OpenAPI 3.1 projection (`toOpenApi`) auto-served at `/openapi.json` by `createFetch`; runtime HTTP client (`createClient`) |
| `@rhi-zone/fractal-worker` | Worker/in-process kit: `procedure`, `field`, `dispatch` |

## Development

```bash
bun install
bun run build
bun run typecheck
bun run test
```
