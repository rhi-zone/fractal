// packages/json-rpc-api-projector/src/wire.ts — @rhi-zone/fractal-json-rpc-api-projector
//
// JSON-RPC 2.0 wire-format types + the standard error envelope. Shared by
// server.ts (builds these) and client.ts (parses these) — kept in its own
// module rather than duplicated or defined one-sided, since both sides need
// the exact same shape.
//
// Spec: https://www.jsonrpc.org/specification

// Re-export the standard error codes from type-ir's json-rpc.ts — the ONE
// place they're defined (see that module's doc); this package never
// redeclares them.
export {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  JSON_RPC_SERVER_ERROR_MAX,
  JSON_RPC_SERVER_ERROR_MIN,
} from "@rhi-zone/fractal-type-ir/json-rpc"

/** A JSON-RPC 2.0 request `id` — string, number, or `null` (§4/§5: `null` is used, by convention, for an error that couldn't be correlated to a request id, e.g. a Parse error). */
export type JsonRpcId = string | number | null

/** A JSON-RPC 2.0 Request object (§4). `id` absent = a Notification (§4.1) — no response is ever sent for one. */
export type JsonRpcRequest = {
  readonly jsonrpc: "2.0"
  readonly method: string
  readonly params?: Record<string, unknown> | unknown[]
  readonly id?: JsonRpcId
}

/** A JSON-RPC 2.0 Notification (§4.1) — a Request with no `id`, sent server -> client for streaming results (see server.ts's "Streaming" section) or client -> server for fire-and-forget calls. */
export type JsonRpcNotification = {
  readonly jsonrpc: "2.0"
  readonly method: string
  readonly params?: unknown
}

/** A JSON-RPC 2.0 error object (§5.1). */
export type JsonRpcErrorObject = {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

/** A successful JSON-RPC 2.0 Response object (§5). */
export type JsonRpcSuccessResponse = {
  readonly jsonrpc: "2.0"
  readonly result: unknown
  readonly id: JsonRpcId
}

/** A failed JSON-RPC 2.0 Response object (§5.1). */
export type JsonRpcErrorResponse = {
  readonly jsonrpc: "2.0"
  readonly error: JsonRpcErrorObject
  readonly id: JsonRpcId
}

/** Either flavor of JSON-RPC 2.0 Response object. */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse

/** True when `res` is specifically an error response (has an `error` key). */
export function isJsonRpcError(res: JsonRpcResponse): res is JsonRpcErrorResponse {
  return "error" in res
}

/** Build a JSON-RPC 2.0 error Response object. */
export function jsonRpcErrorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", error: { code, message, ...(data !== undefined ? { data } : {}) }, id }
}

/** Build a JSON-RPC 2.0 success Response object. `result` defaults to `null` (never `undefined` — `undefined` isn't valid JSON) matching a `void`-returning method still carrying a `result` key per §5. */
export function jsonRpcSuccessResponse(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", result: result === undefined ? null : result, id }
}

/** True when `v` has the minimal shape of a JSON-RPC 2.0 Request object — `jsonrpc: "2.0"` and a string `method`. Anything else (wrong version, missing/non-string method) is an Invalid Request (§4) — including notably a bare array element that isn't itself an object, which the batch walk (server.ts) reports per-element rather than failing the whole batch. */
export function isJsonRpcRequestShape(v: unknown): v is JsonRpcRequest {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    typeof (v as { method?: unknown }).method === "string"
  )
}
