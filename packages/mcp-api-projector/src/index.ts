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
export type {
  CreateMcpServerOptions,
  CreateMessageFn,
  McpAlsContext,
  McpErrorEncoder,
  McpErrorResponse,
  McpMiddleware,
  SamplingConfig,
  ValidationResult,
} from "./server.ts"
export { createMcpServer, mcpErrors, validateAgainstSchema } from "./server.ts"
// SDK sampling types re-exported so consumers of `stores.caller.createMessage`
// (see `CreateMessageFn`, server.ts) don't need to reach into
// `@modelcontextprotocol/sdk/types.js` directly for the request/result shapes.
export type {
  CreateMessageRequestParams,
  CreateMessageRequestParamsBase,
  CreateMessageRequestParamsWithTools,
  CreateMessageResult,
  CreateMessageResultWithTools,
  SamplingMessage,
} from "@modelcontextprotocol/sdk/types.js"
export type { CreateHttpMcpServerOptions, CreateStdioMcpServerOptions } from "./presets.ts"
export { createHttpMcpServer, createStdioMcpServer } from "./presets.ts"
export type { AnyMcpClient, McpClientOptions } from "./client.ts"
export { createMcpClient, McpClientError } from "./client.ts"
