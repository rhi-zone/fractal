// packages/codegen/src/index.ts — @rhi-zone/fractal-codegen
//
// Build-time extractor: derive runtime JSON-Schema + descriptions from op input
// types and JSDoc via the TypeScript compiler API. Obvious cases only; exotic
// types punt to `{ type: "object" }` with a self-documenting `$comment`.

export {
  createExtractorProgram,
  extractJsDoc,
  opFunctionNode,
  schemaFromFunctionNode,
  schemaFromReturnType,
  schemaFromType,
  type JsonSchema,
} from "./extract.ts"

export {
  extractToolSchemas,
  type SchemaMap,
  type ToolSchema,
} from "./tree.ts"
