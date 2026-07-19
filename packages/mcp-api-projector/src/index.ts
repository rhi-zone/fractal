// packages/mcp-api-projector/src/index.ts — @rhi-zone/fractal-mcp-api-projector
export type {
  Dispatch,
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
  ResourceDispatch,
  ResourceTemplateHandler,
  SchemaMap,
  ToolSchema,
  ToToolsOptions,
} from "./project.ts"
export { getMcpMeta, projectPrompts, projectResources, projectTools, toTools } from "./project.ts"
export type { CreateMcpServerOptions, McpAlsContext, McpMiddleware, ValidationResult } from "./server.ts"
export { createMcpServer, validateAgainstSchema } from "./server.ts"
export type { CreateHttpMcpServerOptions, CreateStdioMcpServerOptions } from "./presets.ts"
export { createHttpMcpServer, createStdioMcpServer } from "./presets.ts"
export type { AnyMcpClient, McpClientOptions } from "./client.ts"
export { createMcpClient, McpClientError } from "./client.ts"
