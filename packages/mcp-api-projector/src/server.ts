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
// `Server` registers exactly two request handlers (`tools/list`,
// `tools/call`) and defers to the SDK for everything else (initialize
// handshake, transport framing, protocol version negotiation).
//
// Handler resolution: `projectTools` walks the tree ONCE and returns both
// the flat `McpTool[]` and a `name → Handler` map built during that same
// walk (project.ts's `ProjectToolsResult`) — no second tree walk per call,
// and no risk of the name-construction logic drifting between the tools
// list and the dispatch table.
//
// Transport-agnostic by design: `createMcpServer` returns the `Server`
// instance unconnected. The caller picks a transport
// (`StdioServerTransport`, `SSEServerTransport`, `StreamableHTTPServerTransport`,
// …) and calls `server.connect(transport)` — matching `createFetch`'s
// stance of returning a plain callable and leaving `Bun.serve`/`Deno.serve`/
// worker wiring to the caller.
//
// See:
//   packages/mcp-api-projector/src/project.ts   — toTools / projectTools (tool descriptors + handler map)
//   packages/http-api-projector/src/preset.ts   — sibling preset (createFetch, structural mirror)

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import type {
  CallToolResult,
  Implementation,
  ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js"
import type { Node } from "@rhi-zone/fractal-api-tree/node"
import { projectTools } from "./project.ts"
import type { SchemaMap } from "./project.ts"

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
  /**
   * Additional capabilities to advertise beyond `{ tools: {} }` (always
   * included — this preset always registers tool handlers). Merged under
   * `tools`, so `{ resources: {} }` adds resource support without
   * disturbing the tool capability this preset wires up.
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

  const implementation: Implementation = {
    name: opts.name,
    version: opts.version,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(opts.description !== undefined ? { description: opts.description } : {}),
  }

  const server = new Server(implementation, {
    capabilities: { ...opts.capabilities, tools: { ...opts.capabilities?.tools } },
  })

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }))

  const toolsByName = new Map(tools.map((t) => [t.name, t] as const))

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params
    const handler = handlers.get(name)

    if (handler === undefined) {
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
      const result = await handler(args ?? {})
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        isError: true,
        content: [{ type: "text", text: message }],
      }
    }
  })

  return server
}
