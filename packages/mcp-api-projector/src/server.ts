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

import { AsyncLocalStorage } from "node:async_hooks"
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
import type { Meta, Node } from "@rhi-zone/fractal-api-tree/node"
import { assemble, createStore, isResultShape } from "@rhi-zone/fractal-api-tree"
import type { SourceMap, Stores } from "@rhi-zone/fractal-api-tree"
import { isValidatorWrapped, wrapValidators } from "@rhi-zone/fractal-api-tree/build"
import type { GeneratedEntry } from "@rhi-zone/fractal-api-tree/build"
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

// ============================================================================
// Middleware — around-hooks wrapping the handler call
// ============================================================================

/** Context available to MCP middleware at the point the handler is invoked. */
export type McpMiddlewareContext = {
  readonly meta: Meta
  readonly name: string
  readonly requestType: "tool" | "resource" | "prompt"
}

/**
 * An MCP middleware wraps the handler-invoking function `next`, given
 * dispatch context for the tool/resource/prompt being called. Middleware
 * compose like HTTP layers (`packages/http-api-projector/src/layers.ts`) and
 * CLI middleware (`packages/cli-api-projector/src/cli.ts`): the first entry
 * in `CreateMcpServerOptions.middleware` is the OUTERMOST wrapper.
 */
export type McpMiddleware = (
  next: (input: Record<string, unknown>) => unknown | Promise<unknown>,
  context: McpMiddlewareContext,
) => (input: Record<string, unknown>) => unknown | Promise<unknown>

/**
 * Compose `middleware` around `base`, first entry outermost. An empty array
 * returns `base` unchanged (identity — no wrapping overhead).
 */
function composeMiddleware(
  middleware: readonly McpMiddleware[],
  base: (input: Record<string, unknown>) => unknown | Promise<unknown>,
  context: McpMiddlewareContext,
): (input: Record<string, unknown>) => unknown | Promise<unknown> {
  let wrapped = base
  for (let i = middleware.length - 1; i >= 0; i--) {
    wrapped = middleware[i]!(wrapped, context)
  }
  return wrapped
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
   * value from MCP-specific dispatch context (see `McpMiddlewareContext`) —
   * the same context shape `McpMiddleware` receives. Mirrors HTTP's
   * `PresetOptions.als` (`packages/http-api-projector/src/preset.ts`) and
   * CLI's `CliOpts.als` (`packages/cli-api-projector/src/cli.ts`). ALS is the
   * INNERMOST wrapper — closer to the handler than `opts.middleware` — so the
   * store is active only while the dispatched handler (and anything it
   * calls, transitively) runs; an `McpMiddleware`'s own code, before or after
   * calling `next`, is NOT itself inside the ALS context — Node's
   * `AsyncLocalStorage` doesn't propagate back out through an `await`'d call
   * once it settles. A middleware that needs the store should read it from
   * code it invokes synchronously inside `next`, or maintain its own context
   * via `context` (the dispatch info passed to every middleware) instead.
   * Absent by default (no ALS wrapping).
   */
  readonly als?: {
    readonly storage: AsyncLocalStorage<T>
    readonly init: (context: McpMiddlewareContext) => T
  }
  /**
   * Around-hooks wrapping each tool/resource/prompt handler call, with
   * access to MCP-specific dispatch context (see `McpMiddlewareContext`).
   * Composes like an onion: the first entry in the array is the OUTERMOST
   * wrapper, matching HTTP's layer composition
   * (`packages/http-api-projector/src/layers.ts`) and CLI's middleware
   * (`packages/cli-api-projector/src/cli.ts`). This is the mechanism for
   * wiring around-hooks that need MCP-specific context (ALS, audit, caller
   * context) at the projector level — see `McpMiddleware`.
   *
   * When omitted (or empty), each handler is called directly — zero overhead.
   */
  readonly middleware?: readonly McpMiddleware[]
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

  // ALS wrapping (see CreateMcpServerOptions.als) — innermost, closer to the
  // handler than `middleware`. Absent `opts.als` degrades to identity (no
  // wrapping, zero overhead), matching `middleware`'s own zero-overhead
  // no-op case.
  const withAls = (
    handler: (input: Record<string, unknown>) => unknown | Promise<unknown>,
    context: McpMiddlewareContext,
  ): (input: Record<string, unknown>) => unknown | Promise<unknown> =>
    opts.als === undefined
      ? handler
      : (input) => opts.als!.storage.run(opts.als!.init(context), () => handler(input))

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
      const input = assembleInput("argument", args ?? {}, dispatch.sourceMap)
      const toolContext: McpMiddlewareContext = { meta: dispatch.meta, name, requestType: "tool" }
      const baseHandler = withAls(dispatch.handler, toolContext)
      const callHandler = middleware.length === 0
        ? baseHandler
        : composeMiddleware(middleware, baseHandler, toolContext)
      const result = await callHandler(input)

      // A generated validator signals a rejection by returning an err
      // Result — `{kind:"err", error: ValidationError[]}` (see
      // @rhi-zone/fractal-api-tree/build's `wrapHandler`) — instead of
      // throwing, so this is a discriminated-union check on the return
      // value rather than another catch branch. Scoped to validator-wrapped
      // tools specifically so an ordinary handler's own domain data is never
      // mistaken for a validation failure just because it happens to carry a
      // `kind` field.
      if (generatedValidatorHandlesThis && isResultShape(result) && result.kind === "err") {
        return {
          isError: true,
          content: [
            { type: "text", text: `Invalid input for tool "${name}": ${JSON.stringify(result.error)}` },
          ],
        }
      }

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
      const fixed = resourceHandlers.get(uri)
      if (fixed !== undefined) {
        const mimeType = resourcesByUri.get(uri)?.mimeType ?? "application/json"
        const fixedContext: McpMiddlewareContext = { meta: fixed.meta, name: uri, requestType: "resource" }
        const baseHandler = withAls(fixed.handler, fixedContext)
        const callHandler = middleware.length === 0
          ? baseHandler
          : composeMiddleware(middleware, baseHandler, fixedContext)
        const result = await callHandler({})
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
        const templateContext: McpMiddlewareContext = { meta: template.meta, name: uri, requestType: "resource" }
        const baseHandler = withAls(template.handler, templateContext)
        const callHandler = middleware.length === 0
          ? baseHandler
          : composeMiddleware(middleware, baseHandler, templateContext)
        const result = await callHandler(input)
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
      const promptContext: McpMiddlewareContext = { meta: dispatch.meta, name, requestType: "prompt" }
      const baseHandler = withAls(dispatch.handler, promptContext)
      const callHandler = middleware.length === 0
        ? baseHandler
        : composeMiddleware(middleware, baseHandler, promptContext)
      const result = await callHandler(input)

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
