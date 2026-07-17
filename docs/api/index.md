# API Reference

The full API reference is in [`docs/design/handler-model.md`](../design/handler-model.md). This page is a summary index.

## Packages

All 8 packages built and passing tests (1589 tests, 0 failures verified this session).

| Package | Status | Description |
|---------|--------|-------------|
| `@rhi-zone/fractal-api-tree` | Built & green | Function-core model — function category (Fn/compose/pipe) + Result + Kleisli/applicative combinators (composeK/collect); Node/Op/Meta model in `./node`; Tags lattice in `./tags` |
| `@rhi-zone/fractal-http` | Built & green | WHATWG renderer for the function-core tree — direct tree-walk `makeRouter`, `autoMethodLayer`, `corsLayer`, `createFetch`, `serveBun`/`serveNode` |
| `@rhi-zone/fractal-codegen` | Built & green | Build-time extractor — derive runtime JSON-Schema + descriptions from op input types and JSDoc via the TypeScript compiler API (obvious cases; punts exotics) |
| `@rhi-zone/fractal-type-ir` | Built & green | Type IR — subtyping hierarchy + open metadata bag for projections (JSON Schema, OpenAPI, SQL DDL, etc.) |
| `@rhi-zone/fractal-mcp` | Built & green | MCP tool projection for the function-core tree — `toTools`, annotation hints derived from `meta.tags` |
| `@rhi-zone/fractal-cli` | Built & green | CLI projection for the function-core tree — subcommand dispatch, tag-driven confirm, codegen args |
| `@rhi-zone/fractal-openapi` | Built & green | OpenAPI 3.1 projection for the function-core tree — `toOpenApi` from routes + tags + codegen schemas |
| `@rhi-zone/fractal-client` | Built & green | Runtime HTTP client derived from the function-core tree — method/path mirror the server's tree-walk dispatch (`verbFromTags`) so routes match exactly |

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

## HTTP kit: `@rhi-zone/fractal-http`

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

`validate`/schema wiring flows through `HttpProjectionOptions.transforms` and `createApplyValidation`, accepting a `StandardSchemaV1`. When the schema carries the `jsonSchema` trait, it flows into the emitted OpenAPI `requestBody`.

## OpenAPI projection: `@rhi-zone/fractal-openapi`

```ts
toOpenApi(node: Node, opts?: OpenApiOpts): Promise<OpenApiDoc>
```

Walks the `Node` tree once (self-contained — it doesn't depend on `@rhi-zone/fractal-http`'s dispatch internals), computing for each leaf the HTTP path + verb (mirroring the http package's own tree-walk) and, when `opts.sourceFile` or `opts.schemas` is supplied, pulling request/response JSON Schemas from `@rhi-zone/fractal-codegen`'s `extractToolSchemas`. `meta.openapi` on a leaf carries per-operation overrides (`operationId`, `summary`, `description`, `tags`, `deprecated`); unrecognised keys pass through onto the operation object.

## Codegen: `@rhi-zone/fractal-codegen`

Build-time extractor — derives runtime JSON Schema + descriptions from an op's input types and JSDoc via the TypeScript compiler API. Obvious cases only; exotic types punt to `{ type: "object" }` with a self-documenting `$comment`.

| Export | Description |
|---|---|
| `createExtractorProgram` / `schemaFromType` / `schemaFromFunctionNode` / `schemaFromReturnType` | Build a TS compiler program and derive a `JsonSchema` from a type/function/return-type node |
| `typeRefFromType` / `typeRefFromFunctionNode` / `typeRefFromReturnType` | Same, but produce a `@rhi-zone/fractal-type-ir` `TypeRef` instead of raw JSON Schema |
| `extractJsDoc` | Pull JSDoc description text off a node |
| `extractToolSchemas` / `extractRouteTypeRefs` / `extractToolTypeRefs` | Walk a `Node` tree, keying schemas/type-refs by the same underscore-joined name used by MCP/OpenAPI |
| `buildSchema` / `compileValidator` / `compileValidatorModule` | Compile a `JsonSchema` into a runtime validator |
| `buildValidatorModuleSource` / `writeValidatorModule` / `stubValidatorModuleSource` / `writeStubValidatorModule` | Emit (or stub) a standalone validator module to disk |

## Type IR: `@rhi-zone/fractal-type-ir`

A subtyping hierarchy + open metadata bag used as the common target for schema projections (JSON Schema, OpenAPI, SQL DDL, etc.).

| Export | Description |
|---|---|
| `types.*` / `t(shape, meta?)` | Constructors for each `TypeShape` kind (`boolean`, `string`, `object`, `array`, `union`, `enum`, `ref`, …) and the `TypeRef` wrapper (`shape` + open `meta` bag) |
| `ancestors(kind)` / `resolve(kind, handlers)` | Walk/resolve a kind's parent chain (e.g. `int32` → `integer` → `number`) |
| `registerParent(kind, parent)` | Extend the built-in parent lattice with a custom kind |
| `partial` / `required` / `pick` / `omit` / `extend` / `nullable` / `withMeta` / `deepPartial` / `deepRequired` | Structural transforms over object `TypeRef`s |

## MCP projection: `@rhi-zone/fractal-mcp`

```ts
toTools(node: Node, opts?: ToToolsOptions): McpTool[]
```

Walks a `Node` tree and projects each leaf into an MCP tool descriptor, deriving annotation hints (`readOnlyHint`, `idempotentHint`, `destructiveHint`) from `meta.tags`.

## CLI projection: `@rhi-zone/fractal-cli`

| Export | Description |
|---|---|
| `runCli(tree, opts?)` | Entry point — dispatches a CLI invocation against a `Node` tree as nested subcommands |
| `walkCliCommands(tree)` | Enumerate the tree as a flat list of `CliCommandEntry` (for help text/completion) |

Tag-driven behavior mirrors the other projections: `destructive`/non-`readOnly` ops get an interactive confirm prompt; codegen'd schemas drive argument parsing.

## HTTP client: `@rhi-zone/fractal-client`

```ts
createClient(tree: Node, opts?: ClientOptions): AnyClient
```

Builds a nested proxy object mirroring the `Node` tree's shape: branch children become nested client objects, a `fallback` becomes a function keyed by its capture name (e.g. `client.books.bookId("book-1").read()`), and leaves become async callables that fire the matching HTTP request. Verb/path derivation duplicates the same self-contained tree-walk used by `@rhi-zone/fractal-openapi`, so client and server routes always agree. `ClientError` wraps a non-OK response (status + parsed body).
