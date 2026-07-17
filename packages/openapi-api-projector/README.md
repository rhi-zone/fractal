# @rhi-zone/fractal-openapi-api-projector

OpenAPI 3.1 projection for the function-core tree.

## What it does

Walks an `api()`/`op()` tree once and, for each leaf, computes the same
HTTP path/verb/name that `@rhi-zone/fractal-http-api-projector`'s tree-walk dispatch and
`@rhi-zone/fractal-mcp-api-projector`'s tool projection would derive (self-contained —
it duplicates the segment/verb logic rather than depending on http's
private dispatch internals, so it stays decoupled but stays in sync by
convention). Request/response schemas come from a `SchemaMap` (see
`@rhi-zone/fractal-type-ir`) when a source file or pre-computed map is
given; otherwise they degrade to `{ type: "object" }` placeholders.

## Key exports

- `toOpenApi(tree, opts?)` — build an OpenAPI 3.1 document from a `Node` tree
- `OpenApiOpts` — `title`, `version`, `sourceFile`, `schemas`
- `OpenApiDoc`, `JsonSchemaLike` — document and schema shapes

## Usage

```ts
import { toOpenApi } from "@rhi-zone/fractal-openapi-api-projector"
import { api } from "./tree.ts"

const doc = await toOpenApi(api, {
  title: "Library API",
  version: "1.0.0",
  sourceFile: "./src/tree.ts",
})
```
