# API Reference

The full API reference is in [`docs/design/handler-model.md`](../design/handler-model.md). This page is a summary index.

## Packages

| Package | Status | Key exports |
|---------|--------|-------------|
| `@rhi-zone/fractal-core` | Built & green | `Node`, `Handler`, `Req`, `Pass`, `pass`, `leaf`, `choice`, `pipe`, `capture`, `typed`, `run`, `resolveSchema`, `NodeMiddleware`, `StandardSchemaV1`, `StandardJSONSchemaV1` |
| `@rhi-zone/fractal-http` | Built & green | `path`, `methods`, `param`, `query`, `header`, `body`, `validate`, `serve`; re-exports all of core |
| `@rhi-zone/fractal-worker` | Built & green | `procedure`, `field`, `dispatch`; re-exports all of core |
| `@rhi-zone/fractal-openapi` | Built & green | `toOpenApi(node, info): OpenApiDocument`, `toJsonSchema(node, opts?): JsonSchemaFragment` |

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
