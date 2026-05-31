// examples/todo-api/src/generate-openapi.ts
// Project the todo-api node tree into an OpenAPI document and print it to
// stdout. Demonstrates the generic `toOpenApi` primitive end to end; the
// invocation glue (which tree, what info, where to write) is inherently
// app-specific, so it lives here as an example rather than in a package.

import { toOpenApi } from '@rhi-zone/fractal-standard-schema'
import type { OpenApiInfo } from '@rhi-zone/fractal-standard-schema'
import { tree } from './tree.ts'

const info: OpenApiInfo = {
  title: 'Todo API',
  version: '0.1.0',
}

const doc = toOpenApi(tree, info)

console.log(JSON.stringify(doc, null, 2))
