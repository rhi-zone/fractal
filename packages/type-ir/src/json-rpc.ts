// packages/type-ir/src/json-rpc.ts — @rhi-zone/fractal-type-ir
//
// JSON-RPC 2.0 method signature projection: lowers an `interface` TypeRef
// (a service's method surface — see TypeKinds.interface's doc comment,
// index.ts) to a flat array of `JsonRpcMethod` descriptors, one per method,
// each carrying a params schema, a result schema, and an error schema.
// Sibling to `toProtoService` (protobuf.ts) — same source kind
// (`interface`/`method`), same per-method walk — but JSON-RPC has no IDL of
// its own to render; params/result/error are plain JSON Schema (built via
// `toJsonSchema`, json-schema.ts), matching the wire format JSON-RPC 2.0
// already uses.
//
// JSON-RPC 2.0 spec: https://www.jsonrpc.org/specification
//
// Params: §4 permits either a `by-position` (array) or `by-name` (object)
// structure. This projector always emits an object schema (by-name) — every
// param gets a named property, `required` mirroring the ones without
// `meta.optional: true` — since an object schema can document each param's
// name and type individually; a positional array schema would degrade to an
// untyped tuple with no per-param documentation. A transport that wants
// positional dispatch can still read `paramsSchema.properties` in insertion
// order to recover the positional list.
//
// Result: §5 "result" carries the value returned by a successful call. A
// `stream`-kind return type (TypeKinds.stream — an `AsyncIterable<T>`) has no
// single-value JSON-RPC "result" position to sit in; per the framework
// layer's design (`packages/json-rpc-api-projector`), a streaming method's
// individual elements are instead delivered as JSON-RPC Notification
// messages over a persistent transport (WebSocket) — `resultSchema` here
// describes ONE ELEMENT's shape (the notification payload), and
// `JsonRpcMethod.streaming` records that this method streams rather than
// returning its result schema directly, mirroring protobuf.ts's
// `ProtoRpc.responseStreaming` convention (the synthesized wrapper describes
// the stream's element type, not the stream itself).
//
// Error: §5.1 defines a fixed error OBJECT shape (`code`/`message`/optional
// `data`) plus a reserved code range (-32768 to -32000). This projector
// builds that envelope via `jsonRpcErrorSchema` for every method; a method's
// own application-specific error payload — carried, by convention, as
// `meta.errorType: TypeRef` on the method's own TypeRef (open metadata bag,
// same convention as `meta.discriminator`/`meta.messageName` elsewhere in
// this package) — becomes the envelope's `data` schema when present. Absent
// `meta.errorType`, `errorSchema` still describes the envelope but `data` is
// left unconstrained (`{}`, matching a JSON Schema with no `data` keyword —
// any value or no value at all validates).
//
// See:
//   docs/design/design-philosophy.md          — open metadata bag over fixed schema
//   packages/type-ir/src/protobuf.ts          — sibling projection (toProtoService, structural mirror)
//   packages/type-ir/src/json-schema.ts       — toJsonSchema (params/result/error schema source)
//   packages/json-rpc-api-projector/src/project.ts — framework-layer consumer (method dispatch, naming)

import type { TypeRef, TypeShape } from "./index.ts"
import { toJsonSchema, type JsonSchema } from "./json-schema.ts"

// ============================================================================
// Standard JSON-RPC 2.0 error codes (§5.1)
// ============================================================================

/** Invalid JSON was received by the server. */
export const JSON_RPC_PARSE_ERROR = -32700
/** The JSON sent is not a valid Request object. */
export const JSON_RPC_INVALID_REQUEST = -32600
/** The method does not exist / is not available. */
export const JSON_RPC_METHOD_NOT_FOUND = -32601
/** Invalid method parameter(s). */
export const JSON_RPC_INVALID_PARAMS = -32602
/** Internal JSON-RPC error. */
export const JSON_RPC_INTERNAL_ERROR = -32603
/** Lower bound (inclusive) of the range reserved for implementation-defined server errors (-32000 to -32099). */
export const JSON_RPC_SERVER_ERROR_MIN = -32099
/** Upper bound (inclusive) of the range reserved for implementation-defined server errors (-32000 to -32099). */
export const JSON_RPC_SERVER_ERROR_MAX = -32000

// ============================================================================
// Types
// ============================================================================

/**
 * One method's full JSON-RPC signature — params/result/error schemas plus
 * the descriptive metadata every other type-ir projector surfaces
 * (description/deprecated, read from `meta.description`/`meta.deprecated`).
 */
export type JsonRpcMethod = {
  readonly name: string
  readonly paramsSchema: JsonSchema
  readonly resultSchema: JsonSchema
  readonly errorSchema: JsonSchema
  readonly description?: string
  readonly deprecated?: boolean
  /**
   * True when the method's return type was a `stream` TypeRef — its result
   * is delivered as a sequence of JSON-RPC Notifications (one per element)
   * rather than a single "result" response; `resultSchema` describes ONE
   * element. See module doc's "Result" section.
   */
  readonly streaming?: boolean
}

/** Loose runtime check: true when `v` looks like a `TypeRef` (has a `.shape`). Used to read the optional `meta.errorType` convention without requiring callers to prove its type statically. */
function isTypeRef(v: unknown): v is TypeRef {
  return typeof v === "object" && v !== null && "shape" in v
}

// ============================================================================
// Error envelope (§5.1)
// ============================================================================

/**
 * The standard JSON-RPC 2.0 error object schema: `{ code, message, data? }`
 * (§5.1). `dataSchema`, when supplied, constrains `data`'s shape; omitted,
 * `data` is left unconstrained (any value, or absent, validates).
 */
export function jsonRpcErrorSchema(dataSchema?: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: {
      code: { type: "integer" },
      message: { type: "string" },
      data: dataSchema ?? {},
    },
    required: ["code", "message"],
  }
}

// ============================================================================
// Params / result schemas
// ============================================================================

/**
 * Build the by-name params object schema (see module doc's "Params" section)
 * from a method/function TypeRef's ordered `params` list — one property per
 * param, `required` mirroring each param TypeRef's own `meta.optional`.
 */
function toParamsSchema(params: readonly { readonly name: string; readonly type: TypeRef }[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const p of params) {
    properties[p.name] = toJsonSchema(p.type)
    if (p.type.meta.optional !== true) required.push(p.name)
  }
  const schema: JsonSchema = { type: "object", properties }
  if (required.length > 0) schema.required = required
  return schema
}

/**
 * Build the result schema from a method/function TypeRef's `returnType` —
 * see module doc's "Result" section for the `stream` case. `returnType`
 * absent (a bare callable with no declared return) degrades to `{ type:
 * "null" }`, matching JSON-RPC's convention that a no-result call still
 * carries a `result` key (`null`) per §5.
 */
function toResultSchema(returnType: TypeRef | undefined): { readonly schema: JsonSchema; readonly streaming: boolean } {
  if (returnType === undefined) return { schema: { type: "null" }, streaming: false }
  if (returnType.shape.kind === "stream") {
    const s = returnType.shape as TypeShape & { kind: "stream" }
    return { schema: toJsonSchema(s.element), streaming: true }
  }
  return { schema: toJsonSchema(returnType), streaming: false }
}

// ============================================================================
// Method / interface projection
// ============================================================================

/**
 * Lower one method/function TypeRef to a `JsonRpcMethod` descriptor.
 * `name` is the caller-supplied JSON-RPC method name (the framework layer
 * derives this from tree position — see json-rpc-api-projector's
 * project.ts — this function takes it as-given, mirroring `toProtoMessage`'s
 * own caller-supplied `name` parameter).
 */
export function toJsonRpcMethod(name: string, ref: TypeRef): JsonRpcMethod {
  const m = ref.shape as TypeShape & {
    kind: "method" | "function"
    params: readonly { readonly name: string; readonly type: TypeRef }[]
    returnType: TypeRef
  }
  const { schema: resultSchema, streaming } = toResultSchema(m.returnType)
  const errorType = ref.meta.errorType
  const method: JsonRpcMethod = {
    name,
    paramsSchema: toParamsSchema(m.params ?? []),
    resultSchema,
    errorSchema: jsonRpcErrorSchema(isTypeRef(errorType) ? toJsonSchema(errorType) : undefined),
    ...(typeof ref.meta.description === "string" ? { description: ref.meta.description } : {}),
    ...(ref.meta.deprecated === true ? { deprecated: true } : {}),
    ...(streaming ? { streaming: true } : {}),
  }
  return method
}

/**
 * Lower an `interface` TypeRef (a service's method surface — see
 * TypeKinds.interface's doc comment) to a flat array of `JsonRpcMethod`
 * descriptors, one per entry in `shape.methods`, in object-key order.
 */
export function toJsonRpcMethods(ref: TypeRef): JsonRpcMethod[] {
  const shape = ref.shape as TypeShape & { kind: "interface" }
  return Object.entries(shape.methods).map(([methodName, methodRef]) => toJsonRpcMethod(methodName, methodRef))
}
