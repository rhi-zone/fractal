// packages/mcp-api-projector/src/index.ts — @rhi-zone/fractal-mcp-api-projector
export type {
  McpAnnotations,
  McpMeta,
  McpResource,
  McpResourceTemplate,
  McpTool,
  ProjectResourcesOptions,
  ProjectResourcesResult,
  ProjectToolsResult,
  ResourceTemplateHandler,
  SchemaMap,
  ToolSchema,
  ToToolsOptions,
} from "./project.ts"
export { getMcpMeta, projectResources, projectTools, toTools } from "./project.ts"
export type { CreateMcpServerOptions, ValidationResult } from "./server.ts"
export { createMcpServer, validateAgainstSchema } from "./server.ts"
