// examples/todo-api/src/generate-openapi.ts
// Builds the app Node and prints a full OpenAPI 3.0 document.
// Run: bun run generate-openapi
//   (or: bun run examples/todo-api/src/generate-openapi.ts from repo root)

import { app } from './app.ts'
import { toOpenApi } from '@rhi-zone/fractal-openapi'

const doc = toOpenApi(app, {
  title: 'Todo API',
  version: '1.0.0',
  description: 'fractal example — generated from .meta tree',
})

console.log(JSON.stringify(doc, null, 2))
