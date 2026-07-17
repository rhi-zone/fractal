// packages/mcp-api-projector/src/index.ts — @rhi-zone/fractal-mcp-api-projector
export type {
  McpAnnotations,
  McpMeta,
  McpPrompt,
  McpPromptArgument,
  McpResource,
  McpResourceTemplate,
  McpTool,
  ProjectPromptsOptions,
  ProjectPromptsResult,
  ProjectResourcesOptions,
  ProjectResourcesResult,
  ProjectToolsResult,
  ResourceTemplateHandler,
  SchemaMap,
  ToolSchema,
  ToToolsOptions,
} from "./project.ts"
export { getMcpMeta, projectPrompts, projectResources, projectTools, toTools } from "./project.ts"
export type { CreateMcpServerOptions, ValidationResult } from "./server.ts"
export { createMcpServer, validateAgainstSchema } from "./server.ts"
export type { CreateHttpMcpServerOptions, CreateStdioMcpServerOptions } from "./presets.ts"
export { createHttpMcpServer, createStdioMcpServer } from "./presets.ts"
