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
} from "@modelcontextprotocol/sdk/types.js"
import type { Node } from "@rhi-zone/fractal-api-tree/node"
import { assemble, createStore } from "@rhi-zone/fractal-api-tree"
import type { SourceMap, Stores } from "@rhi-zone/fractal-api-tree"
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
// Input assembly — shared pipeline (packages/api-tree/src/input.ts)
// ============================================================================

/**
 * Assemble a handler's input bag from a single named store of raw values,
 * via the shared resolution pipeline `assemble`. Mirrors cli-api-projector's
 * `buildInput`: `paramNames` is the union of the raw values' own keys and any
 * name declared in `sourceMap` — so a param sourced purely from an override
 * (not present in the raw values at all) still gets assembled.
 *
 * With an empty `sourceMap`, every param resolves from `storeName` by its own
 * key — i.e. this reduces to `values` unchanged, matching prior behavior
 * (tool calls got `request.params.arguments` directly; resource template
 * reads got the regex-captured vars object directly; prompt calls got
 * `request.params.arguments` directly).
 */
function assembleInput(
  storeName: string,
  values: Record<string, unknown>,
  sourceMap: SourceMap,
): Record<string, unknown> {
  const stores: Stores = { [storeName]: createStore(values) }
  const paramNames = [...new Set([...Object.keys(values), ...Object.keys(sourceMap)])]
  return assemble(stores, paramNames, sourceMap, storeName)
}

export type CreateMcpServerOptions = {
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
   * Additional capabilities to advertise beyond `{ tools: {} }` (always
   * included — this preset always registers tool handlers), `{ resources: {} }`
   * (added automatically when the tree contains any resource leaves), and
   * `{ prompts: {} }` (added automatically when the tree contains any prompt
   * leaves).
   */
  readonly capabilities?: ServerCapabilities
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
 * transport-level failure.
 */
export function createMcpServer(tree: Node, opts: CreateMcpServerOptions): Server {
  const { tools, handlers } = projectTools(tree, opts.schemas !== undefined ? { schemas: opts.schemas } : {})
  const {
    resources,
    resourceTemplates,
    handlers: resourceHandlers,
    templateHandlers,
  } = projectResources(tree, opts.resources ?? {})
  const hasResources = resources.length > 0 || resourceTemplates.length > 0

  const { prompts, handlers: promptHandlers } = projectPrompts(tree, opts.prompts ?? {})
  const hasPrompts = prompts.length > 0

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

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params
    const dispatch = handlers.get(name)

    if (dispatch === undefined) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      }
    }

    const tool = toolsByName.get(name)
    if (tool !== undefined) {
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
      const input = assembleInput("argument", args ?? {}, dispatch.sourceMap)
      const result = await dispatch.handler(input)
      return {
        content: toCallToolContent(result),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        isError: true,
        content: [{ type: "text", text: message }],
      }
    }
  })

  if (hasResources) {
    server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources }))
    server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates }))

    const resourcesByUri = new Map(resources.map((r) => [r.uri, r] as const))

    server.setRequestHandler(ReadResourceRequestSchema, async (request): Promise<ReadResourceResult> => {
      const { uri } = request.params

      // Fixed resources first (exact URI match), then templates (pattern match).
      const fixedHandler = resourceHandlers.get(uri)
      if (fixedHandler !== undefined) {
        const mimeType = resourcesByUri.get(uri)?.mimeType ?? "application/json"
        const result = await fixedHandler({})
        return { contents: [toResourceContent(result, uri, mimeType)] }
      }

      for (const template of templateHandlers) {
        const match = template.pattern.exec(uri)
        if (match === null) continue
        const captured: Record<string, string> = {}
        template.paramNames.forEach((name, i) => {
          captured[name] = match[i + 1] as string
        })
        const input = assembleInput("uri-variable", captured, template.sourceMap)
        const result = await template.handler(input)
        return { contents: [toResourceContent(result, uri, template.mimeType)] }
      }

      throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`)
    })
  }

  if (hasPrompts) {
    server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts }))

    server.setRequestHandler(GetPromptRequestSchema, async (request): Promise<GetPromptResult> => {
      const { name, arguments: args } = request.params
      const dispatch = promptHandlers.get(name)

      if (dispatch === undefined) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`)
      }

      const input = assembleInput("argument", args ?? {}, dispatch.sourceMap)
      const result = await dispatch.handler(input)

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
