// packages/json-rpc-api-projector/src/index.ts — @rhi-zone/fractal-json-rpc-api-projector
export type {
  Dispatch,
  JsonRpcMeta,
  JsonRpcMethod,
  JsonSchema,
  MethodSchema,
  ProjectMethodsOptions,
  ProjectMethodsResult,
  SchemaMap,
} from "./project.ts"
export { getJsonRpcMeta, projectMethods, toMethods } from "./project.ts"

export type {
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
} from "./wire.ts"
export {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  JSON_RPC_SERVER_ERROR_MAX,
  JSON_RPC_SERVER_ERROR_MIN,
  isJsonRpcError,
  isJsonRpcRequestShape,
  jsonRpcErrorResponse,
  jsonRpcSuccessResponse,
} from "./wire.ts"

export type { CreateJsonRpcServerOptions, JsonRpcErrorEncoder, JsonRpcSocket, JsonRpcWebSocketHandlers } from "./server.ts"
export { createJsonRpcHttpHandler, createJsonRpcWebSocketHandlers, jsonRpcErrors } from "./server.ts"

export type { AnyJsonRpcClient, FetchLike, JsonRpcCall, JsonRpcHttpClientOptions } from "./client.ts"
export { createJsonRpcClient, createJsonRpcHttpCall, createJsonRpcHttpClient, JsonRpcClientError } from "./client.ts"
