// packages/mcp-api-projector/src/server.ts — @rhi-zone/fractal-mcp-api-projector
//
// OOTB preset: `createMcpServer(tree)` wires a Node tree into a running
// `@modelcontextprotocol/sdk` `Server` — the same one-call DX leap that
// `createFetch(tree)` (http-api-projector's preset.ts) provides for HTTP.
//
// Uses the SDK's low-level `Server` (not the high-level `McpServer`)
// because `projectTools` already produces raw JSON Schema `inputSchema`
// per tool (derived-from-type via `SchemaMap`, see project.ts) — the
// high-level `McpServer.registerTool` wants a Zod raw shape instead, which
// would mean re-deriving a second schema representation for no benefit.
// `Server` always registers `tools/list` and `tools/call`; when the tree
// contains any leaf tagged `meta.mcp.as: "resource"`, it additionally
// registers `resources/list`, `resources/templates/list`, and
// `resources/read` (and advertises the `resources` capability — see
// `hasResources` below); when the tree contains any leaf tagged
// `meta.mcp.as: "prompt"`, it additionally registers `prompts/list` and
// `prompts/get` (and advertises the `prompts` capability — see
// `hasPrompts` below). Everything else (initialize handshake, transport
// framing, protocol version negotiation) is left to the SDK.
//
// Handler resolution: `projectTools`/`projectResources`/`projectPrompts`
// each walk the tree ONCE and return both their flat descriptor array and a
// dispatch table built during that same walk (project.ts's
// `ProjectToolsResult` / `ProjectResourcesResult` / `ProjectPromptsResult`)
// — no second tree walk per call, and no risk of the name/URI-construction
// logic drifting between the list and the dispatch table. Fixed resources
// dispatch by an exact `uri` map lookup; resource templates (URIs with
// `{var}` placeholders, from fallback nodes) dispatch by trying each
// compiled `RegExp` in turn and binding captured segments to named handler
// input fields. Prompts dispatch by an exact `name` map lookup, same as tools.
//
// Transport-agnostic by design: `createMcpServer` returns the `Server`
// instance unconnected. The caller picks a transport
// (`StdioServerTransport`, `SSEServerTransport`, `StreamableHTTPServerTransport`,
// …) and calls `server.connect(transport)` — matching `createFetch`'s
// stance of returning a plain callable and leaving `Bun.serve`/`Deno.serve`/
// worker wiring to the caller.
//
// See:
//   packages/mcp-api-projector/src/project.ts   — toTools/projectTools/projectResources (descriptors + dispatch tables)
//   packages/http-api-projector/src/preset.ts   — sibling preset (createFetch, structural mirror)

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js"
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import type {
  CallToolResult,
  ContentBlock,
  GetPromptResult,
  Implementation,
  ReadResourceResult,
  ServerCapabilities,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js"
import type { Meta, Node } from "@rhi-zone/fractal-api-tree/node"
import { assemble, composeErrorEncoders, isResultShape, isStreamChunk, isStreamProgress, matchKind } from "@rhi-zone/fractal-api-tree"
import type { DetectionOptions, ErrorEncoder, SourceMap, Stores } from "@rhi-zone/fractal-api-tree"

// Augment the shared StoreRegistry with MCP's store names — see
// http-api-projector/src/decode.ts for the matching augmentation and its doc.
declare module "@rhi-zone/fractal-api-tree" {
  interface StoreRegistry {
    argument: true
    "uri-variable": true
  }
}

// `caller` itself is declared once, in api-tree's input.ts — shared across
// all three projectors (see that file's doc comment on StoreRegistry) —
// rather than re-declared here.

import { isValidatorWrapped, wrapValidators } from "@rhi-zone/fractal-api-tree/build"
import type { GeneratedEntry } from "@rhi-zone/fractal-api-tree/build"
import type { AlsConfig } from "@rhi-zone/fractal-api-tree/context"
import { projectPrompts, projectResources, projectTools } from "./project.ts"
import type { ProjectPromptsOptions, ProjectResourcesOptions, SchemaMap } from "./project.ts"

// ============================================================================
// Minimal JSON Schema validation (required + property types only)
// ============================================================================
//
// Deliberately not a full JSON Schema validator (no $ref, no nested object/array
// schema recursion, no format/pattern/enum/min/max) — just enough to catch the
// two most common tool-call mistakes: a missing required field, and a field
// whose type obviously doesn't match. Anything beyond a bare `{ type: "object" }`
// (the MCP spec minimum used when no derived schema is available) is checked;
// that minimum itself is skipped since it carries no constraints.

/** JSON Schema "type" keyword values this checker understands. */
type JsonSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null"

function matchesJsonSchemaType(value: unknown, type: JsonSchemaType): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value)
    case "array":
      return Array.isArray(value)
    case "string":
      return typeof value === "string"
    case "number":
      return typeof value === "number"
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "boolean":
      return typeof value === "boolean"
    case "null":
      return value === null
    default:
      return true
  }
}

/** Result of `validateAgainstSchema`: either valid, or a list of human-readable errors. */
export type ValidationResult = { readonly valid: true } | { readonly valid: false; readonly errors: string[] }

/**
 * Validate `args` against a tool's `inputSchema` — `required` array presence
 * and `properties[key].type` for whichever properties are actually present.
 * Not a general JSON Schema validator (see module comment above); intended to
 * catch the common "forgot a field" / "wrong type" mistakes before a handler
 * runs, without pulling in a schema validation library.
 *
 * A schema that is just `{ type: "object" }` (no `properties`/`required`) is
 * the MCP spec minimum used when no derived schema exists — nothing to check,
 * so it always passes.
 */
export function validateAgainstSchema(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): ValidationResult {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined
  const required = schema.required as unknown

  const errors: string[] = []

  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string" && !(key in args)) {
        errors.push(`missing required field "${key}"`)
      }
    }
  }

  if (properties !== undefined && typeof properties === "object") {
    for (const [key, propSchema] of Object.entries(properties)) {
      if (!(key in args)) continue
      const expectedType = propSchema.type
      if (typeof expectedType !== "string") continue
      if (!matchesJsonSchemaType(args[key], expectedType as JsonSchemaType)) {
        errors.push(
          `field "${key}" expected type "${expectedType}", got ${
            args[key] === null ? "null" : Array.isArray(args[key]) ? "array" : typeof args[key]
          }`,
        )
      }
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}

// ============================================================================
// Rich content pass-through (tool call results, resource read results)
// ============================================================================
//
// A handler's return value drives the MCP content type it becomes: a plain
// value (string/number/object/array with no recognizable MCP content shape)
// is wrapped as `{ type: "text", ... }` for backward compatibility, but a
// value that already looks like MCP content (or an array of such values) is
// passed through untouched — this is how a handler returns an image, audio,
// or embedded resource instead of having everything flattened to JSON text.

/** MCP content-block `type` discriminator values recognized for pass-through. */
const MCP_CONTENT_TYPES = new Set(["text", "image", "audio", "resource"])

/**
 * True when `value` is a plain object whose `type` field is one of the
 * recognized MCP content-block discriminators, with the fields that
 * discriminator requires present (and of the right basic shape) — not just
 * a coincidental `type: "text"` on an unrelated object. Used to decide
 * whether a handler's return value is already MCP content (pass through)
 * or a plain value (wrap as text).
 */
function isMcpContentBlock(value: unknown): value is ContentBlock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const type = (value as { type?: unknown }).type
  if (typeof type !== "string" || !MCP_CONTENT_TYPES.has(type)) return false

  const v = value as Record<string, unknown>
  switch (type) {
    case "text":
      return typeof v.text === "string"
    case "image":
    case "audio":
      return typeof v.data === "string" && typeof v.mimeType === "string"
    case "resource":
      return typeof v.resource === "object" && v.resource !== null && typeof (v.resource as { uri?: unknown }).uri === "string"
    default:
      return false
  }
}

/**
 * Decide the `content` array for a `tools/call` result from a handler's raw
 * return value: an already-MCP-shaped value (or array of them) passes
 * through as-is; anything else is wrapped as a single text block, matching
 * the previous always-JSON.stringify behavior (with a string value used
 * verbatim instead of being double-stringified).
 */
export function toCallToolContent(result: unknown): ContentBlock[] {
  if (Array.isArray(result) && result.length > 0 && result.every(isMcpContentBlock)) {
    return result
  }
  if (isMcpContentBlock(result)) {
    return [result]
  }
  return [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }]
}

/** Resource content shape produced for a `resources/read` result. */
type ResourceContentEntry =
  | { uri: string; mimeType: string; text: string }
  | { uri: string; mimeType: string; blob: string }

/**
 * Decide the single `contents` entry for a `resources/read` result: if the
 * handler already returned `{ text }` or `{ blob }` (optionally with its own
 * `mimeType`), use those fields directly; otherwise fall back to
 * `JSON.stringify`-as-text, matching the previous always-JSON behavior.
 */
export function toResourceContent(result: unknown, uri: string, defaultMimeType: string): ResourceContentEntry {
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    const v = result as Record<string, unknown>
    if (typeof v.text === "string") {
      return { uri, mimeType: typeof v.mimeType === "string" ? v.mimeType : defaultMimeType, text: v.text }
    }
    if (typeof v.blob === "string") {
      return { uri, mimeType: typeof v.mimeType === "string" ? v.mimeType : defaultMimeType, blob: v.blob }
    }
  }
  return { uri, mimeType: defaultMimeType, text: JSON.stringify(result) }
}

// ============================================================================
// Streaming — a handler returning an AsyncIterable (see
// docs/design/middleware-and-caller-context.md's "Streaming and Progress"
// section) is drained here instead of going through the plain-value path.
// `StreamProgress` yields become `notifications/progress` (only when the
// caller supplied a `progressToken` — a client that never asked for progress
// has no token to correlate them against, so they're skipped, not queued);
// `StreamChunk` yields and untagged yields are both collected as content via
// `toCallToolContent`, matching HTTP's `streamAsSse` (route.ts) treating an
// untagged yield as a chunk by default. The generator's return value (not a
// yielded value) is the final result, appended the same way.
// ============================================================================

/**
 * True when `v` is an async iterable — a handler that returns one is
 * drained via `collectStreamedToolContent`/`collectStreamedMessages` instead
 * of going straight through `toCallToolContent`/plain-value handling.
 * Structural (`Symbol.asyncIterator` presence), mirroring HTTP's
 * `isAsyncIterable` (packages/http-api-projector/src/route.ts).
 */
function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  )
}

/**
 * Drain a tool handler's `AsyncIterable` return value into the `content`
 * array a `tools/call` result needs: `StreamProgress` yields become
 * `notifications/progress` sent via `extra.sendNotification` (only when the
 * request carried a `progressToken` in its `_meta`); `StreamChunk` yields and
 * untagged yields are both run through `toCallToolContent` and appended to
 * `content`; the generator's return value is run through the same
 * `toCallToolContent` and appended last, as the final result.
 */
async function collectStreamedToolContent(
  iterable: AsyncIterable<unknown>,
  extra: McpRequestExtra,
): Promise<ContentBlock[]> {
  const progressToken = extra._meta?.progressToken
  const content: ContentBlock[] = []
  const iterator = iterable[Symbol.asyncIterator]()
  for (;;) {
    const step = await iterator.next()
    if (step.done) {
      if (step.value !== undefined) content.push(...toCallToolContent(step.value))
      break
    }
    const value: unknown = step.value
    if (isStreamProgress(value)) {
      if (progressToken !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: value.progress,
            total: value.total ?? 1,
            ...(value.message !== undefined ? { message: value.message } : {}),
          },
        })
      }
    } else if (isStreamChunk(value)) {
      content.push(...toCallToolContent(value.data))
    } else {
      content.push(...toCallToolContent(value))
    }
  }
  return content
}

/**
 * Drain a resource-read handler's `AsyncIterable` return value into
 * additional `contents` entries for a `resources/read` result — each yielded
 * value (progress excluded — reported the same way as tools, via
 * `sendNotification`) and the final return value become one
 * `toResourceContent` entry apiece.
 */
async function collectStreamedResourceContents(
  iterable: AsyncIterable<unknown>,
  extra: McpRequestExtra,
  uri: string,
  defaultMimeType: string,
): Promise<ResourceContentEntry[]> {
  const progressToken = extra._meta?.progressToken
  const contents: ResourceContentEntry[] = []
  const iterator = iterable[Symbol.asyncIterator]()
  for (;;) {
    const step = await iterator.next()
    if (step.done) {
      if (step.value !== undefined) contents.push(toResourceContent(step.value, uri, defaultMimeType))
      break
    }
    const value: unknown = step.value
    if (isStreamProgress(value)) {
      if (progressToken !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: value.progress,
            total: value.total ?? 1,
            ...(value.message !== undefined ? { message: value.message } : {}),
          },
        })
      }
    } else if (isStreamChunk(value)) {
      contents.push(toResourceContent(value.data, uri, defaultMimeType))
    } else {
      contents.push(toResourceContent(value, uri, defaultMimeType))
    }
  }
  return contents
}

/**
 * Drain a prompt handler's `AsyncIterable` return value into the `messages`
 * array a `prompts/get` result needs — each yielded value (progress
 * excluded) and the final return value become one assistant text message
 * apiece, matching the plain-value fallback in the `GetPromptRequestSchema`
 * handler below (JSON.stringify-as-text) since a prompt yield has no
 * dedicated rich-content shape the way tool/resource content does.
 */
async function collectStreamedMessages(
  iterable: AsyncIterable<unknown>,
  extra: McpRequestExtra,
): Promise<Array<{ role: "assistant"; content: { type: "text"; text: string } }>> {
  const progressToken = extra._meta?.progressToken
  const messages: Array<{ role: "assistant"; content: { type: "text"; text: string } }> = []
  const iterator = iterable[Symbol.asyncIterator]()
  for (;;) {
    const step = await iterator.next()
    if (step.done) {
      if (step.value !== undefined) {
        messages.push({ role: "assistant", content: { type: "text", text: JSON.stringify(step.value) } })
      }
      break
    }
    const value: unknown = step.value
    if (isStreamProgress(value)) {
      if (progressToken !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: value.progress,
            total: value.total ?? 1,
            ...(value.message !== undefined ? { message: value.message } : {}),
          },
        })
      }
    } else if (isStreamChunk(value)) {
      messages.push({ role: "assistant", content: { type: "text", text: JSON.stringify(value.data) } })
    } else {
      messages.push({ role: "assistant", content: { type: "text", text: JSON.stringify(value) } })
    }
  }
  return messages
}

// ============================================================================
// Structured error types — composable error-to-transport mapping
//
// A handler's `Result.err(E)` value is transport-agnostic (e.g.
// `{ kind: "notFound", message: "Book not found" }`). `errorEncoder`
// (`CreateMcpServerOptions.errorEncoder`) maps `E` to an `McpErrorResponse`
// (error code + message) — mirrors HTTP's `HttpErrorEncoder`
// (packages/http-api-projector/src/route.ts) and CLI's `CliErrorEncoder`
// (packages/cli-api-projector/src/cli.ts). Returning `undefined` (including
// when `errorEncoder` itself is omitted) falls back to the existing default:
// an `isError` tool result with `Invalid input for tool "<name>": <JSON>`.
// ============================================================================

/** An error encoder's MCP-specific target shape — error code + message. */
export type McpErrorResponse = {
  readonly code: number
  readonly message: string
}

/** `ErrorEncoder<E, McpErrorResponse>` — maps a handler's error value to an MCP error code/message. */
export type McpErrorEncoder<E = unknown> = ErrorEncoder<E, McpErrorResponse>

/**
 * Pre-built `McpErrorEncoder`: maps error `kind` values to MCP error codes,
 * e.g. `mcpErrors({ notFound: ErrorCode.InvalidParams })`. The response
 * message defaults to the error value's own `JSON.stringify`, matching the
 * existing default error text. Internally a `composeErrorEncoders` over one
 * `matchKind` per mapping entry — first match wins (object key order).
 */
export function mcpErrors<E = unknown>(mapping: Record<string, number>): McpErrorEncoder<E> {
  const encoders = Object.entries(mapping).map(([kind, code]) =>
    matchKind<number>(kind, code),
  )
  const composed = composeErrorEncoders(...encoders)
  return (error) => {
    const code = composed(error)
    if (code === undefined) return undefined
    return { code, message: JSON.stringify(error) }
  }
}

/** Render an `McpErrorResponse` as a `CallToolResult`'s error content, for a named tool. */
function encodeToolError(name: string, response: McpErrorResponse): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `Error ${response.code} for tool "${name}": ${response.message}` }],
  }
}

// ============================================================================
// Input assembly — shared pipeline (packages/api-tree/src/input.ts)
// ============================================================================

/**
 * Assemble a handler's input bag from a single named store of raw values,
 * via the shared resolution pipeline `assemble`. Mirrors cli-api-projector's
 * `buildInput`: `paramNames` is the union of the raw values' own keys and any
 * name declared in `sourceMap` — so a param sourced purely from an override
 * (not present in the raw values at all) still gets assembled. Returns the
 * `stores` alongside the assembled `input` bag — `stores` is threaded into
 * `McpMiddleware` (see below), which sees both the assembled input AND the
 * raw pre-assembly stores; the handler itself only ever sees `input`.
 *
 * With an empty `sourceMap`, every param resolves from `storeName` by its own
 * key — i.e. `input` reduces to `values` unchanged, matching prior behavior
 * (tool calls got `request.params.arguments` directly; resource template
 * reads got the regex-captured vars object directly; prompt calls got
 * `request.params.arguments` directly).
 *
 * `extra` is the SDK's per-request `RequestHandlerExtra` (second argument to
 * every `setRequestHandler` callback below) — its `authInfo`/`sessionId`
 * populate the `caller` store: `caller.authInfo` returns the SDK's
 * `AuthInfo` object, `caller.sessionId` the session ID string. This
 * replaces the reverted `extra`-into-`McpMiddlewareContext` threading (commit
 * `027baa6`) — `extra` now flows through `stores.caller` like every other
 * projector's caller context; it is never exposed to middleware directly. See
 * docs/design/middleware-and-caller-context.md.
 */
function assembleInput(
  storeName: string,
  values: Record<string, unknown>,
  sourceMap: SourceMap,
  extra: McpRequestExtra,
): { readonly input: Record<string, unknown>; readonly stores: Stores } {
  // storeName is always one of MCP's declared store names ("argument" or
  // "uri-variable") at call sites below, but it's threaded through as a
  // plain string — cast past the declaration-merged `Stores`' literal keys.
  const stores = {
    [storeName]: values,
    caller: { authInfo: extra.authInfo, sessionId: extra.sessionId },
  } as Stores
  const paramNames = [...new Set([...Object.keys(values), ...Object.keys(sourceMap)])]
  return { input: assemble(stores, paramNames, sourceMap, storeName), stores }
}

// ============================================================================
// Middleware — around-hooks wrapping the handler call
//
// Middleware is F => F, where F = (input, stores) => result — see
// docs/design/middleware-and-caller-context.md. There is no separate context
// bag: `input` is the assembled, validated domain arguments (same shape the
// handler receives); `stores` is the raw pre-assembly stores built for input
// assembly (see `assembleInput`), giving middleware access to whatever the
// handler didn't declare. The handler itself is `(input) => result` — it
// never receives `stores`; that's structural (see `withAls` and the
// `(input, _stores) => handler(input)` base below), not a convention to
// remember.
// ============================================================================

/**
 * The SDK's per-request `RequestHandlerExtra` for this package's `Server`
 * (default `RequestT`/`NotificationT`, per `createMcpServer`'s use of the
 * SDK's low-level `Server` — see module doc above) — the second parameter
 * every `setRequestHandler` callback receives. Carries `authInfo`/`sessionId`,
 * consumed by `assembleInput` to populate the `caller` store; never threaded
 * to middleware directly (see `assembleInput`'s doc and
 * docs/design/middleware-and-caller-context.md).
 */
type McpRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>

/**
 * An MCP middleware wraps the handler-invoking function `next` (itself
 * `F => F`, see module doc above). Middleware compose like HTTP layers
 * (`packages/http-api-projector/src/layers.ts`) and CLI middleware
 * (`packages/cli-api-projector/src/cli.ts`): the first entry in
 * `CreateMcpServerOptions.middleware` is the OUTERMOST wrapper.
 */
export type McpMiddleware = (
  next: (input: Record<string, unknown>, stores: Stores) => unknown | Promise<unknown>,
) => (input: Record<string, unknown>, stores: Stores) => unknown | Promise<unknown>

/**
 * Compose `middleware` around `base`, first entry outermost. An empty array
 * returns `base` unchanged (identity — no wrapping overhead).
 */
function composeMiddleware(
  middleware: readonly McpMiddleware[],
  base: (input: Record<string, unknown>, stores: Stores) => unknown | Promise<unknown>,
): (input: Record<string, unknown>, stores: Stores) => unknown | Promise<unknown> {
  let wrapped = base
  for (let i = middleware.length - 1; i >= 0; i--) {
    wrapped = middleware[i]!(wrapped)
  }
  return wrapped
}

// ============================================================================
// ALS dispatch context — separate from McpMiddleware's (input, stores). ALS
// is a side channel (see docs/design/middleware-and-caller-context.md); this
// is dispatch metadata for `opts.als.init`, not a context bag threaded
// through middleware.
// ============================================================================

/** Dispatch context `CreateMcpServerOptions.als`'s `init` receives. */
export type McpAlsContext = {
  readonly meta: Meta
  readonly name: string
  readonly requestType: "tool" | "resource" | "prompt"
}

export type CreateMcpServerOptions<T = unknown> = {
  /** Server name, surfaced to MCP clients during the initialize handshake. */
  readonly name: string
  /** Server version, surfaced alongside `name`. */
  readonly version: string
  /** Optional human-readable server description/title (SDK `Implementation` fields). */
  readonly title?: string
  readonly description?: string
  /** Tool-name → derived input schema + JSDoc description (from codegen). Forwarded to `projectTools`. */
  readonly schemas?: SchemaMap
  /** URI scheme for derived resource URIs (see `projectResources`). Forwarded as-is. */
  readonly resources?: ProjectResourcesOptions
  /** Prompt projection options (see `projectPrompts`). Forwarded as-is. */
  readonly prompts?: ProjectPromptsOptions
  /**
   * Generated validators (from `buildValidatorModuleSource` /
   * `compileValidatorModule`, keyed by `"/"`-joined route path — see
   * `wrapValidators` in `@rhi-zone/fractal-api-tree/build`). When provided,
   * `tree` is wrapped via `wrapValidators` before `projectTools`/
   * `projectResources`/`projectPrompts` build their dispatch maps: any leaf
   * with a matching entry has its handler run through the generated
   * `parse()` (coercion + validation in one pass), and the manual
   * `validateAgainstSchema` check for that tool is skipped — the generated
   * validator takes over. Leaves with no matching entry (or when this option
   * is omitted entirely) keep going through `validateAgainstSchema` as
   * before.
   */
  readonly validators?: Readonly<Record<string, GeneratedEntry>>
  /**
   * Additional capabilities to advertise beyond `{ tools: {} }` (always
   * included — this preset always registers tool handlers), `{ resources: {} }`
   * (added automatically when the tree contains any resource leaves), and
   * `{ prompts: {} }` (added automatically when the tree contains any prompt
   * leaves).
   */
  readonly capabilities?: ServerCapabilities
  /**
   * Wrap each tool/resource/prompt handler call so it runs inside its own
   * `AsyncLocalStorage` context. `init` computes the per-invocation context
   * value from MCP-specific dispatch context (see `McpAlsContext`). Mirrors
   * HTTP's `PresetOptions.als` (`packages/http-api-projector/src/preset.ts`)
   * and CLI's `CliOpts.als` (`packages/cli-api-projector/src/cli.ts`). ALS is
   * the INNERMOST wrapper — closer to the handler than `opts.middleware` —
   * so the store is active only while the dispatched handler (and anything
   * it calls, transitively) runs; an `McpMiddleware`'s own code, before or
   * after calling `next`, is NOT itself inside the ALS context — Node's
   * `AsyncLocalStorage` doesn't propagate back out through an `await`'d call
   * once it settles. A middleware that needs cross-cutting context should
   * read it from `stores` (the second parameter every `McpMiddleware`
   * receives), or read the ALS store from code it invokes synchronously
   * inside `next`. Absent by default (no ALS wrapping).
   */
  readonly als?: AlsConfig<McpAlsContext, T>
  /**
   * Around-hooks wrapping each tool/resource/prompt handler call — `F => F`
   * where `F = (input, stores) => result` (see
   * docs/design/middleware-and-caller-context.md). Composes like an onion:
   * the first entry in the array is the OUTERMOST wrapper, matching HTTP's
   * layer composition (`packages/http-api-projector/src/layers.ts`) and
   * CLI's middleware (`packages/cli-api-projector/src/cli.ts`). `stores` is
   * the raw pre-assembly stores built for input assembly (see
   * `assembleInput`) — the vehicle for cross-cutting concerns (caller
   * identity, audit, ...); the handler itself never sees `stores`.
   *
   * When omitted (or empty), each handler is called directly — zero overhead.
   */
  readonly middleware?: readonly McpMiddleware[]
  /**
   * Opt-in configuration for the structural sniffing this preset applies to
   * a tool/resource/prompt handler's return value — `result` gates
   * `Result`-shape (`{kind:"ok"|"err"}`) unwrapping (tools only — resources
   * and prompts don't unwrap `Result` today), `streaming` gates
   * `AsyncIterable` detection (and, transitively, `StreamEffect` tag
   * interpretation on its yields — `collectStreamedToolContent`/
   * `collectStreamedResourceContents`/`collectStreamedMessages`). Both
   * default to `true` — existing behavior — when `detection` itself, or
   * either field, is omitted. Disable one when a handler legitimately
   * returns/yields data shaped like one of these DUs and it must NOT be
   * reinterpreted as the transport protocol (see
   * `docs/design/middleware-and-caller-context.md`'s "Streaming and
   * Progress" section, and `DetectionOptions`'s own doc,
   * `@rhi-zone/fractal-api-tree`). Mirrors HTTP's `PresetOptions.detection`
   * (`packages/http-api-projector/src/preset.ts`) and CLI's
   * `CliOpts.detection`.
   */
  readonly detection?: DetectionOptions
  /**
   * Maps a tool handler's `Result.err(E)` error value to an
   * `McpErrorResponse` (error code + message) — see
   * `McpErrorEncoder`/`mcpErrors` above. Called when `detection.result` is
   * on (default `true`) and a tool handler returns `{kind:"err", error}`.
   * Returning `undefined` (including when `errorEncoder` itself is omitted)
   * falls back to the existing default: an `isError` tool result with
   * `Invalid input for tool "<name>": <JSON>`. Compose several encoders with
   * `composeErrorEncoders` (`@rhi-zone/fractal-api-tree`) — first match
   * wins. Tools only, matching how `detection.result` itself only unwraps
   * `Result` for tools, not resources/prompts. Mirrors HTTP's
   * `PresetOptions.errorEncoder` (`packages/http-api-projector/src/preset.ts`)
   * and CLI's `CliOpts.errorEncoder` (`packages/cli-api-projector/src/cli.ts`).
   */
  readonly errorEncoder?: McpErrorEncoder
}

/**
 * Build an OOTB MCP `Server` from a Node tree: projects `tree` via
 * `projectTools` (project.ts) to get the flat `McpTool[]` + handler map,
 * registers `tools/list` and `tools/call` request handlers, and returns
 * the unconnected `Server` instance.
 *
 * The caller chooses a transport and connects it:
 *
 * ```ts
 * const server = createMcpServer(tree, { name: "my-api", version: "1.0.0" })
 * await server.connect(new StdioServerTransport())
 * ```
 *
 * A handler that throws (sync or async) is caught and surfaced as an MCP
 * tool error result (`isError: true`) rather than crashing the request —
 * that is the protocol's own error-signaling channel, distinct from a
 * transport-level failure. A generated validator's rejection (see
 * `CreateMcpServerOptions.validators`) is surfaced the same way but via a
 * different mechanism — the wrapped handler returns an err Result rather
 * than throwing, so it's caught by a return-value check, not the try/catch.
 */
export function createMcpServer<T = unknown>(tree: Node, opts: CreateMcpServerOptions<T>): Server {
  // Wire generated validators onto the tree BEFORE any projection walk — see
  // `CreateMcpServerOptions.validators`. Leaves with no matching entry keep
  // their original handler untouched (wrapValidators is a no-op there).
  const workingTree = opts.validators !== undefined ? wrapValidators(tree, opts.validators) : tree

  const { tools, handlers } = projectTools(workingTree, opts.schemas !== undefined ? { schemas: opts.schemas } : {})
  const {
    resources,
    resourceTemplates,
    handlers: resourceHandlers,
    templateHandlers,
  } = projectResources(workingTree, opts.resources ?? {})
  const hasResources = resources.length > 0 || resourceTemplates.length > 0

  const { prompts, handlers: promptHandlers } = projectPrompts(workingTree, opts.prompts ?? {})
  const hasPrompts = prompts.length > 0

  // Around-hooks wrapping each handler call — see CreateMcpServerOptions.middleware.
  const middleware = opts.middleware ?? []

  // Opt-in return-value detection — see CreateMcpServerOptions.detection.
  const detectResult = opts.detection?.result ?? true
  const detectStreaming = opts.detection?.streaming ?? true

  // ALS wrapping (see CreateMcpServerOptions.als) — innermost, closer to the
  // handler than `middleware`. Absent `opts.als` degrades to identity (no
  // wrapping, zero overhead), matching `middleware`'s own zero-overhead
  // no-op case.
  const withAls = (
    handler: (input: Record<string, unknown>) => unknown | Promise<unknown>,
    context: McpAlsContext,
  ): (input: Record<string, unknown>) => unknown | Promise<unknown> =>
    opts.als === undefined
      ? handler
      : (input) => opts.als!.storage.run(opts.als!.init(context), () => handler(input))

  // Bridge a plain handler `(input) => result` into `F => F`'s base case
  // `(input, stores) => handler(input)` — the handler never sees `stores`,
  // structurally (see McpMiddleware's module doc above).
  const toBase = (
    handler: (input: Record<string, unknown>) => unknown | Promise<unknown>,
  ): ((input: Record<string, unknown>, stores: Stores) => unknown | Promise<unknown>) =>
    (input, _stores) => handler(input)

  const implementation: Implementation = {
    name: opts.name,
    version: opts.version,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(opts.description !== undefined ? { description: opts.description } : {}),
  }

  const server = new Server(implementation, {
    capabilities: {
      ...opts.capabilities,
      tools: { ...opts.capabilities?.tools },
      ...(hasResources ? { resources: { ...opts.capabilities?.resources } } : {}),
      ...(hasPrompts ? { prompts: { ...opts.capabilities?.prompts } } : {}),
    },
  })

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }))

  const toolsByName = new Map(tools.map((t) => [t.name, t] as const))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params
    const dispatch = handlers.get(name)

    if (dispatch === undefined) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      }
    }

    // A generated validator (see CreateMcpServerOptions.validators) already
    // wraps dispatch.handler to run parse() — coercion + validation in one
    // pass — so the schema-derived fallback check below is skipped for this
    // tool specifically. Uncovered tools (no matching generated validator, or
    // opts.validators omitted entirely) keep going through it as before.
    const tool = toolsByName.get(name)
    const generatedValidatorHandlesThis = isValidatorWrapped(dispatch.handler)
    if (tool !== undefined && !generatedValidatorHandlesThis) {
      const result = validateAgainstSchema(tool.inputSchema, args ?? {})
      if (!result.valid) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Invalid input for tool "${name}": ${result.errors.join("; ")}` },
          ],
        }
      }
    }

    try {
      const { input, stores } = assembleInput("argument", args ?? {}, dispatch.sourceMap, extra)
      const toolContext: McpAlsContext = { meta: dispatch.meta, name, requestType: "tool" }
      const base = toBase(withAls(dispatch.handler, toolContext))
      const callHandler = middleware.length === 0
        ? base
        : composeMiddleware(middleware, base)
      let result = await callHandler(input, stores)

      // Streaming: an async-iterable result (e.g. an async generator
      // handler) is drained into progress notifications + collected content
      // instead of going through Result-unwrapping/toCallToolContent below —
      // checked first since neither a Result nor plain content is an async
      // iterable, so there's no ambiguity (matches HTTP's `runRoute`,
      // packages/http-api-projector/src/route.ts).
      if (detectStreaming && isAsyncIterable(result)) {
        return { content: await collectStreamedToolContent(result, extra) }
      }

      // Result unwrapping: applied whenever `detectResult` is on (matching
      // HTTP's `runRoute`, packages/http-api-projector/src/route.ts) — any
      // handler returning `{kind:"err", error}` gets a proper MCP tool
      // error result,
      // not just tools wrapped by a generated validator
      // (`generatedValidatorHandlesThis`, computed above, still only gates
      // the fallback `validateAgainstSchema` check, a separate concern). A
      // `kind:"ok"` Result is unwrapped to its `.value` before becoming
      // content, so an ordinary handler that happens to return this
      // package's own `Result<T,E>` shape (see
      // @rhi-zone/fractal-api-tree's `ok`/`err`) is treated the same way
      // regardless of validator wiring.
      if (detectResult && isResultShape(result)) {
        if (result.kind === "err") {
          const encoded = opts.errorEncoder?.(result.error)
          if (encoded !== undefined) return encodeToolError(name, encoded)
          return {
            isError: true,
            content: [
              { type: "text", text: `Invalid input for tool "${name}": ${JSON.stringify(result.error)}` },
            ],
          }
        }
        result = result.value
      }

      return {
        content: toCallToolContent(result),
      }
    } catch {
      // A thrown error is never surfaced verbatim to the caller — matching
      // HTTP's `runRoute` (route.ts), which already collapses a thrown
      // error to a generic "internal server error" 500 rather than leaking
      // `err.message`. A handler's thrown message can carry internals
      // (stack frames, file paths, driver-specific text, ...) that weren't
      // meant for an MCP client; a handler that WANTS to communicate a
      // specific, client-facing failure should return an `err(...)` Result
      // instead (see the Result-unwrapping check above), which IS surfaced
      // verbatim — that is the intentional, opt-in error-reporting channel.
      return {
        isError: true,
        content: [{ type: "text", text: "internal error" }],
      }
    }
  })

  if (hasResources) {
    server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources }))
    server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates }))

    const resourcesByUri = new Map(resources.map((r) => [r.uri, r] as const))

    server.setRequestHandler(ReadResourceRequestSchema, async (request, extra): Promise<ReadResourceResult> => {
      const { uri } = request.params

      // Fixed resources first (exact URI match), then templates (pattern match).
      const fixed = resourceHandlers.get(uri)
      if (fixed !== undefined) {
        const mimeType = resourcesByUri.get(uri)?.mimeType ?? "application/json"
        const fixedContext: McpAlsContext = { meta: fixed.meta, name: uri, requestType: "resource" }
        const base = toBase(withAls(fixed.handler, fixedContext))
        const callHandler = middleware.length === 0
          ? base
          : composeMiddleware(middleware, base)
        // No URI-variables for a fixed resource — assembleInput still builds
        // the `caller` store from `extra` so middleware sees it here too.
        const { input, stores } = assembleInput("uri-variable", {}, {}, extra)
        const result = await callHandler(input, stores)
        if (detectStreaming && isAsyncIterable(result)) {
          return { contents: await collectStreamedResourceContents(result, extra, uri, mimeType) }
        }
        return { contents: [toResourceContent(result, uri, mimeType)] }
      }

      for (const template of templateHandlers) {
        const match = template.pattern.exec(uri)
        if (match === null) continue
        const captured: Record<string, string> = {}
        template.paramNames.forEach((name, i) => {
          captured[name] = match[i + 1] as string
        })
        const { input, stores } = assembleInput("uri-variable", captured, template.sourceMap, extra)
        const templateContext: McpAlsContext = { meta: template.meta, name: uri, requestType: "resource" }
        const base = toBase(withAls(template.handler, templateContext))
        const callHandler = middleware.length === 0
          ? base
          : composeMiddleware(middleware, base)
        const result = await callHandler(input, stores)
        if (detectStreaming && isAsyncIterable(result)) {
          return { contents: await collectStreamedResourceContents(result, extra, uri, template.mimeType) }
        }
        return { contents: [toResourceContent(result, uri, template.mimeType)] }
      }

      throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`)
    })
  }

  if (hasPrompts) {
    server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts }))

    server.setRequestHandler(GetPromptRequestSchema, async (request, extra): Promise<GetPromptResult> => {
      const { name, arguments: args } = request.params
      const dispatch = promptHandlers.get(name)

      if (dispatch === undefined) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`)
      }

      const { input, stores } = assembleInput("argument", args ?? {}, dispatch.sourceMap, extra)
      const promptContext: McpAlsContext = { meta: dispatch.meta, name, requestType: "prompt" }
      const base = toBase(withAls(dispatch.handler, promptContext))
      const callHandler = middleware.length === 0
        ? base
        : composeMiddleware(middleware, base)
      const result = await callHandler(input, stores)

      // Streaming: collect all yields + the final return value into the
      // messages array — see `collectStreamedMessages`'s doc.
      if (detectStreaming && isAsyncIterable(result)) {
        return { messages: await collectStreamedMessages(result, extra) }
      }

      // A handler may already return a well-formed GetPromptResult (has a
      // `messages` array) — pass it through as-is. Otherwise wrap the plain
      // return value as a single assistant text message.
      if (
        typeof result === "object" &&
        result !== null &&
        Array.isArray((result as { messages?: unknown }).messages)
      ) {
        return result as GetPromptResult
      }

      return {
        messages: [{ role: "assistant", content: { type: "text", text: JSON.stringify(result) } }],
      }
    })
  }

  return server
}
