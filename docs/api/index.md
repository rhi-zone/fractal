# API Reference

For settled design rationale, see [`docs/design/invariants.md`](../design/invariants.md). For API reference, see the per-package READMEs:

- [`packages/api-tree/README.md`](../../packages/api-tree/README.md)
- [`packages/http-api-projector/README.md`](../../packages/http-api-projector/README.md)
- [`packages/cli-api-projector/README.md`](../../packages/cli-api-projector/README.md)
- [`packages/mcp-api-projector/README.md`](../../packages/mcp-api-projector/README.md)
- [`packages/graphql-api-projector/README.md`](../../packages/graphql-api-projector/README.md)
- [`packages/type-ir/README.md`](../../packages/type-ir/README.md)

This page is a summary index.

## Packages

All 6 packages built and passing tests. `@rhi-zone/fractal-codegen` was merged into `@rhi-zone/fractal-type-ir` 2026-07-18, then its extractor/tree-walker/CLI (`extract.ts`/`tree.ts`/`cli.ts`/`build.ts`) moved on to `@rhi-zone/fractal-api-tree` the same day — they walk `api()`/`op()` authoring source, an api-tree concern, not type-ir's. `compile.ts` (`TypeRef` → validator code) stayed in type-ir as one of its 20+ projectors. `@rhi-zone/fractal-openapi-api-projector` and `@rhi-zone/fractal-client-api-projector` were both merged into `@rhi-zone/fractal-http-api-projector` the same day — OpenAPI only ever describes HTTP APIs and the runtime client only ever builds HTTP requests, so both are HTTP concerns, not separate projection packages; `createFetch` now auto-serves the generated OpenAPI document at `/openapi.json`.

| Package | Status | Description |
|---------|--------|-------------|
| `@rhi-zone/fractal-api-tree` | Built & green | Function-core model — function category (Fn/compose/pipe) + Result + Kleisli/applicative combinators (composeK/collect); Node/Op/Meta model in `./node`; Tags lattice in `./tags`; build-time extractor + source-level tree walker in `./extract`/`./tree`; `fractal-api-tree` build/watch/stub/check CLI |
| `@rhi-zone/fractal-http-api-projector` | Built & green | WHATWG renderer for the function-core tree — direct tree-walk `makeRouter`, `autoMethodLayer`, `corsLayer`, `createFetch`, `serveBun`/`serveNode`; OpenAPI 3.1 projection (`toOpenApi`/`toOpenApiFromRoute`) from routes + tags + codegen schemas, auto-served at `/openapi.json` by `createFetch`; runtime HTTP client (`createClient`/`createClientFromRoute`) whose verb/path derivation walks the same `HttpRoute` tree the router dispatches against |
| `@rhi-zone/fractal-type-ir` | Built & green | Type IR — subtyping hierarchy + open metadata bag for projections (JSON Schema, OpenAPI, SQL DDL, etc.), plus AOT validator codegen (`compile.ts`) |
| `@rhi-zone/fractal-mcp-api-projector` | Built & green | MCP tool projection for the function-core tree — `toTools`, annotation hints derived from `meta.tags` |
| `@rhi-zone/fractal-cli-api-projector` | Built & green | CLI projection for the function-core tree — subcommand dispatch, tag-driven confirm, codegen args |
| `@rhi-zone/fractal-graphql-api-projector` | Built & green | GraphQL projection for the function-core tree — `projectGraphQL`/`toSDL`/`toSchema`, resolver map dispatching onto tree handlers, server/client/codegen wiring |

## Core: `@rhi-zone/fractal-api-tree`

The composition unit is a plain tree, not a combinator chain:

```ts
type Node<H extends Handler = Handler> = {
  readonly handler?: H                                    // present on a leaf
  readonly children?: Readonly<Record<string, Node>>       // present on a branch
  readonly fallback?: { readonly name: string; readonly subtree: Node } // wildcard capture
  readonly meta: Meta                                      // open metadata bag (tags + projection namespaces)
}
```

A node with `handler` is a leaf; a node with `children` is a branch; both is valid. `fallback` lets keyed dispatch capture an unmatched segment as a named param and continue into a subtree.

| Export | Description |
|---|---|
| `op(fn, ...metas)` | Build a leaf node from a handler, merging metadata bundles via `mergeMeta` |
| `api(children, opts?)` | Build a branch node from a `{ key: Node }` map |
| `mergeMeta(...)` | Recursive metadata merge (objects deep-merge, arrays concat, later wins) |
| `isNode` / `isLeaf` | Discriminators — `isLeaf` is true when `handler` is present |
| `compose` / `pipe` | Plain function composition / left-to-right value threading |
| `ok` / `err` / `isOk` / `isErr` / `map` / `bind` / `match` | `Result<T, E>` — the fallible-value type and its combinators |
| `composeK` | Kleisli composition over `Result` |
| `collect` | Applicative record combinator — runs a record of `Result`-producers, short-circuits on first error |

The `Node`/`Meta` model lives in `./node.ts` (re-exported from the package root); the tags lattice lives in `./tags.ts`.

Dev tooling — build-time extraction over authored `api()`/`op()` source —
lives on separate subpaths, kept off the package root so runtime consumers
of the base model don't pull in the TypeScript compiler:

| Export | Description |
|---|---|
| `createExtractorProgram` / `schemaFromType` / `schemaFromFunctionNode` / `schemaFromReturnType` | (`./extract`) Build a TS compiler program and derive a `JsonSchema` from a type/function/return-type node. Obvious cases only; exotic types punt to `{ type: "object" }` with a self-documenting `$comment` |
| `typeRefFromType` / `typeRefFromFunctionNode` / `typeRefFromReturnType` | (`./extract`) Same, but produce a `TypeRef` instead of raw JSON Schema |
| `extractJsDoc` | (`./extract`) Pull JSDoc description text off a node |
| `extractToolSchemas` / `extractRouteTypeRefs` / `extractToolTypeRefs` | (`./tree`) Walk a `Node` tree AT THE SOURCE LEVEL, keying schemas/type-refs by the same underscore-joined name used by MCP/OpenAPI |
| `fractal-api-tree` CLI | `build`/`watch`/`stub`/`check` subcommands over a validator module (`./cli.ts`), orchestrating `./tree`'s extraction into `@rhi-zone/fractal-type-ir`'s `compileValidatorModule` (`./build.ts`) |

## HTTP kit: `@rhi-zone/fractal-http-api-projector`

A WHATWG-request/response renderer for the same `Node` tree — no separate combinator vocabulary, just a tree-walk projector plus DX sugar.

| Export | Description |
|---|---|
| `http.get` / `.post` / `.put` / `.patch` / `.delete` / `.head` / `.options` | Verb-helper metadata bundles — pin the HTTP verb and imply behavioral tags (e.g. `http.get` → `readOnly: true`) |
| `crud(handlers)` | Convention constructor for the 5-op REST-resource shape, wiring `http.*` bundles for you |
| `httpProjection(tree, opts?)` | One-call `Node => HttpRoute` with the standard rewriter pipeline pre-composed |
| `mapRoute` | Shared tree-recursion visitor for route rewriters |
| `fusePipeline` / `skipEmptyInput` | Optional pipeline-optimization rewriters |
| `toRouter` / `radixRouter` / `compiledCharRouter` / `mapCharRouter` | Compile an `HttpRoute` tree into a dispatchable router (radix / char-trie variants) |
| `withALS` | Wrap a handler to run inside `AsyncLocalStorage`-scoped context |
| `toOpenApi(node, opts?)` / `toOpenApiFromRoute(route, opts?)` | Project a `Node` tree (or an already-projected `HttpRoute`) to an OpenAPI 3.1 document — see below |

`validate`/schema wiring flows through `HttpProjectionOptions.transforms` and `createApplyValidation`, accepting a `StandardSchemaV1`. When the schema carries the `jsonSchema` trait, it flows into the emitted OpenAPI `requestBody`.

### OpenAPI projection

```ts
toOpenApi(node: Node, opts?: OpenApiOpts): Promise<OpenApiDoc>
```

OpenAPI only ever describes HTTP APIs, so this projection lives in `@rhi-zone/fractal-http-api-projector` (merged in from the former `@rhi-zone/fractal-openapi-api-projector`, 2026-07-18) and is built directly on this package's own `HttpRoute` tree — `toOpenApiFromRoute(route, opts?)` walks an already-projected route tree; `toOpenApi(node, opts?)` is the `Node`-tree convenience wrapper. Path + verb come from the same `HttpRoute` structure `makeRouterFromRoute` dispatches against, so the emitted paths always match the live HTTP router. When `opts.sourceFile` or `opts.schemas` is supplied, request/response JSON Schemas come from `@rhi-zone/fractal-api-tree/tree`'s `extractToolSchemas`. `meta.openapi` on a leaf carries per-operation overrides (`operationId`, `summary`, `description`, `tags`, `deprecated`); unrecognised keys pass through onto the operation object.

`createFetch` (`PresetOptions.openapi`, default `true`) auto-mounts a `GET /openapi.json` handler that lazily builds and caches the document from the live route tree — zero extra setup. Pass `{ path, title, version, schemas, sourceFile }` to configure it, or `false` to disable.

## Type IR: `@rhi-zone/fractal-type-ir`

A subtyping hierarchy + open metadata bag used as the common target for schema projections (JSON Schema, OpenAPI, SQL DDL, etc.), plus an AOT validator codegen projector (`compile.ts`) that `@rhi-zone/fractal-api-tree`'s CLI hands extracted `TypeRef`s to. The build-time extractor and tree walker themselves (formerly here, merged in from the former `@rhi-zone/fractal-codegen`) moved to `@rhi-zone/fractal-api-tree`'s `./extract`/`./tree` subpaths (2026-07-18) — they walk `api()`/`op()` AUTHORING source, which is api-tree's concern, not type-ir's.

| Export | Description |
|---|---|
| `types.*` / `t(shape, meta?)` | Constructors for each `TypeShape` kind (`boolean`, `string`, `object`, `array`, `union`, `enum`, `ref`, …) and the `TypeRef` wrapper (`shape` + open `meta` bag) |
| `ancestors(kind)` / `resolve(kind, handlers)` | Walk/resolve a kind's parent chain (e.g. `int32` → `integer` → `number`) |
| `registerParent(kind, parent)` | Extend the built-in parent lattice with a custom kind |
| `partial` / `required` / `pick` / `omit` / `extend` / `nullable` / `withMeta` / `deepPartial` / `deepRequired` | Structural transforms over object `TypeRef`s |
| `buildSchema` / `compileValidator` / `compileValidatorModule` | Compile a `TypeRef` into a runtime validator |

## MCP projection: `@rhi-zone/fractal-mcp-api-projector`

```ts
toTools(node: Node, opts?: ToToolsOptions): McpTool[]
```

Walks a `Node` tree and projects each leaf into an MCP tool descriptor, deriving annotation hints (`readOnlyHint`, `idempotentHint`, `destructiveHint`) from `meta.tags`.

## CLI projection: `@rhi-zone/fractal-cli-api-projector`

| Export | Description |
|---|---|
| `runCli(tree, opts?)` | Entry point — dispatches a CLI invocation against a `Node` tree as nested subcommands |
| `walkCliCommands(tree)` | Enumerate the tree as a flat list of `CliCommandEntry` (for help text/completion) |

Tag-driven behavior mirrors the other projections: `destructive`/non-`readOnly` ops get an interactive confirm prompt; codegen'd schemas drive argument parsing.

## HTTP client: `@rhi-zone/fractal-http-api-projector`

```ts
createClient(tree: Node, opts?: ClientOptions): AnyClient
createClientFromRoute(route: HttpRoute, opts?: ClientOptions): AnyClient
```

The runtime HTTP client only ever builds HTTP requests, so it lives in `@rhi-zone/fractal-http-api-projector` (merged in from the former `@rhi-zone/fractal-client-api-projector`, 2026-07-18) and is built directly on this package's own `HttpRoute` tree, exactly like the OpenAPI projection — `createClientFromRoute(route, opts?)` walks an already-projected route tree; `createClient(node, opts?)` is the `Node`-tree convenience wrapper. It builds a nested proxy object mirroring the route tree's shape: branch children become nested client objects, a `fallback` becomes a function keyed by its capture name (e.g. `client.books.bookId("book-1").read()`), and leaves become async callables that fire the matching HTTP request. Because both walk the same `HttpRoute` tree `makeRouterFromRoute` dispatches against, client and server routes always agree. `ClientError` wraps a non-OK response (status + parsed body).
