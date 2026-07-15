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
  typeRefFromFunctionNode,
  typeRefFromReturnType,
  typeRefFromType,
  type JsonSchema,
} from "./extract.ts"

export {
  extractToolSchemas,
  extractToolTypeRefs,
  type SchemaMap,
  type ToolSchema,
  type ToolTypeInfo,
  type TypeRefMap,
} from "./tree.ts"
