// examples/library-api/scripts/generate-client.ts
//
// Codegen entry point: generates a standalone typed TypeScript client for
// the library-api example (src/tree.ts) and writes it to
// src/client.generated.ts. Run via `bun run codegen:client` (see
// package.json).
//
// extractToolSchemas walks the TS source with the TypeScript compiler API,
// so this script must run at build/codegen time (a Bun/Node process), not
// bundled into the runtime client itself.

import { extractToolSchemas } from "@rhi-zone/fractal-api-tree/tree"
import { generateClientFromNode } from "@rhi-zone/fractal-http-api-projector/codegen"
import { api } from "../src/tree.ts"

const treePath = new URL("../src/tree.ts", import.meta.url).pathname
const outPath = new URL("../src/client.generated.ts", import.meta.url).pathname

const schemas = extractToolSchemas(treePath)
const source = generateClientFromNode(api, schemas)

await Bun.write(outPath, source)

console.log(`Wrote ${source.length} bytes to ${outPath}`)
