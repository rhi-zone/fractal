# API Reference

The full API reference is in [`docs/design/handler-model.md`](../design/handler-model.md). This page is a summary index.

## Packages

All 8 packages built and passing tests (1589 tests, 0 failures verified this session).

| Package | Status | Description |
|---------|--------|-------------|
| `@rhi-zone/fractal-core` | Built & green | Function-core model — function category (Fn/compose/pipe) + Result + Kleisli/applicative combinators (composeK/collect); Node/Op/Meta model in `./node`; Tags lattice in `./tags` |
| `@rhi-zone/fractal-http` | Built & green | WHATWG renderer for the function-core tree — direct tree-walk `makeRouter`, `autoMethodLayer`, `corsLayer`, `createFetch`, `serveBun`/`serveNode` |
| `@rhi-zone/fractal-codegen` | Built & green | Build-time extractor — derive runtime JSON-Schema + descriptions from op input types and JSDoc via the TypeScript compiler API (obvious cases; punts exotics) |
| `@rhi-zone/fractal-type-ir` | Built & green | Type IR — subtyping hierarchy + open metadata bag for projections (JSON Schema, OpenAPI, SQL DDL, etc.) |
| `@rhi-zone/fractal-mcp` | Built & green | MCP tool projection for the function-core tree — `toTools`, annotation hints derived from `meta.tags` |
| `@rhi-zone/fractal-cli` | Built & green | CLI projection for the function-core tree — subcommand dispatch, tag-driven confirm, codegen args |
| `@rhi-zone/fractal-openapi` | Built & green | OpenAPI 3.1 projection for the function-core tree — `toOpenApi` from routes + tags + codegen schemas |
| `@rhi-zone/fractal-client` | Built & green | Runtime HTTP client derived from the function-core tree — method/path mirror the server's tree-walk dispatch (`verbFromTags`) so routes match exactly |

## Core: `@rhi-zone/fractal-core`

The composition unit:

```ts
type Node<P extends Record<string, unknown> = Record<string, never>, Res = unknown> = {
  meta: Meta       // reflection descriptor — walkable, serialisable
  handler: Handler<P, Res>  // (req: Req<P>) => Promise<Res | Pass>
}
```

`P` is the set of params the handler requires from above. Combinators discharge entries from `P`. `run` requires `P = {}` — undischarged params are a compile error.

### Combinators

| Combinator | Signature | meta.kind |
|---|---|---|
| `leaf(fn)` | `(req: Req<P>) => Promise<Res>` → `Node<P,Res>` | `"leaf"` |
| `choice(...ns)` | `Node<P,Res>[]` → `Node<P,Res>` | `"choice"` |
| `capture(name, read, child)` | Generic in V | `"capture"` |
| `typed(schemaOrParse)` | Sync params refinement; accepts `StandardSchemaV1` | `"typed"` |
| `pipe(...mws)` | Compose `NodeMiddleware`s | (delegates to inner) |
| `run(n, req)` | Entrypoint; `P={}` required | — |

## HTTP kit: `@rhi-zone/fractal-http`

| Combinator | Effect | meta.kind |
|---|---|---|
| `path(table)` | Dispatch on first path segment, consume it | `"path"` |
| `methods(table)` | Dispatch on method; path-exhaustion guard | `"methods"` |
| `param(name, child)` | Capture path segment as string | `"param"` |
| `query(name, child)` | Capture query param as string | `"query"` |
| `header(name, child)` | Capture header as string | `"header"` |
| `body(child)` | Pull lazy body thunk | `"body"` |
| `validate(schemaOrParse, inner)` | Validate body; accepts `StandardSchemaV1` | `"validate"` |
| `serve(n, req)` | Entrypoint: `HttpRequest` → `HttpResponse`; `Pass` → 404 | — |

`validate` accepts either a `StandardSchemaV1` or a raw parse function. When given a `StandardSchemaV1` with the `jsonSchema` trait, the schema flows into the emitted OpenAPI `requestBody`.

## Worker kit: `@rhi-zone/fractal-worker`

| Combinator | Effect | meta.kind |
|---|---|---|
| `procedure(table)` | Dispatch by procedure name | `"procedure"` |
| `field(name, read, child)` | Capture a typed value; V is free (no string coercion) | `"field"` |
| `dispatch(n, call)` | Entrypoint: `WorkerCall` → `WorkerCallResult`; `Pass` → not-found | — |

## OpenAPI projection: `@rhi-zone/fractal-openapi`

```ts
toOpenApi(node, { title, version, description? }): OpenApiDocument
toJsonSchema(node, opts?): JsonSchemaFragment
```

Walks `node.meta` to produce OpenAPI 3.0. Handles: `leaf`, `choice`, `path`, `methods`, `param`, `query`, `header`, `body`, `validate`, `typed`, `capture`, `pipe`, `security`. Worker-kit kinds (`procedure`, `field`) are skipped with a warning.

Standard Schema schemas on `TypedMeta` and `ValidateMeta` are emitted as `requestBody` schemas. If the `jsonSchema` trait is absent or throws, the schema degrades to `{}`.
