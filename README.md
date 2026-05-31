# fractal

HTTP/RPC/IPC API library with composition via combinators

**https://docs.rhi.zone/fractal/**

Endpoints are plain data composed from a small set of primitives. Transports, validation, and static types are opt-in layers composed onto the core via combinators — not built into it. The API structure is an inert-data tree: traversable, reflectable, and walked by multiple interpreters to produce an HTTP server, a typed client proxy, an OpenAPI document, or a test harness from one definition.

## Packages

| Package | Role |
|---------|------|
| `@rhi-zone/fractal-core` | Inert-data node IR, capability contracts, Context, combinator surface |
| `@rhi-zone/fractal-rpc-dispatch` | Shared dispatch utilities for rpc-style interpreters |
| `@rhi-zone/fractal-http` | HTTP server interpreter |
| `@rhi-zone/fractal-rpc` | RPC transport interpreter |
| `@rhi-zone/fractal-ipc` | IPC transport interpreter |
| `@rhi-zone/fractal-client` | Typed client-proxy interpreter |
| `@rhi-zone/fractal-standard-schema` | OpenAPI/JSON Schema/doc generation (zero runtime deps) |
| `@rhi-zone/fractal-facade` | Aggregator re-export |

## Development

```bash
bun install
bun run build
bun run typecheck
bun run test
```
