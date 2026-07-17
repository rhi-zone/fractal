# @rhi-zone/fractal-codegen

Build-time extractor: derives runtime JSON Schema and descriptions from op
input types and JSDoc, using the TypeScript compiler API.

## What it does

Walks an `api()`/`op()` tree's source file with the TypeScript compiler,
resolves each leaf's handler input type, and produces a JSON-Schema-shaped
description of it plus its JSDoc comment — used to populate MCP tool
schemas and OpenAPI request/response bodies without hand-written schemas.
Handles the obvious cases (object literals, primitives, unions, optional
fields); exotic types punt to `{ type: "object" }` with a self-documenting
`$comment` rather than guessing.

## Key exports

- `createExtractorProgram`, `schemaFromType`, `schemaFromFunctionNode`, `schemaFromReturnType` — low-level type-to-schema extraction (`./extract`)
- `extractToolSchemas`, `extractRouteTypeRefs`, `extractToolTypeRefs` — whole-tree walkers producing a `SchemaMap` (`./tree`)
- `buildSchema`, `compileValidator`, `compileValidatorModule` — compile a schema into a validator (`./compile`)
- `buildValidatorModuleSource`, `writeValidatorModule` — emit a validator module to disk (`./build`)
- `fractal-codegen` — CLI binary (`./cli.ts`)

## Usage

```ts
import { extractToolSchemas } from "@rhi-zone/fractal-codegen"

const schemas = extractToolSchemas({
  sourceFile: "./src/tree.ts",
  exportName: "api",
})
// schemas.books_add -> { type: "object", properties: { title: {...}, ... } }
```
