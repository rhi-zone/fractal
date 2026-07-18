// packages/mcp-api-projector/src/client.ts — @rhi-zone/fractal-mcp-api-projector
//
// Runtime MCP client — the same recursive-proxy pattern as
// http-api-projector's `createClient` (see that module's doc for the full
// rationale), but dispatching through the MCP SDK's `Client` class instead
// of `fetch`. Built directly on the raw `Node` tree (not a projected
// intermediate), because tool/prompt name and resource URI derivation is
// exactly `project.ts`'s own walk — reusing that logic (not re-deriving it)
// is what keeps the client's names/URIs from drifting out of sync with what
// `createMcpServer` (server.ts) actually dispatches against.
//
// Name/URI derivation mirrors `projectTools`/`projectResources`/
// `projectPrompts` (project.ts) exactly:
//   - tool/prompt name: underscore-joined tree position, `meta.mcp.name` wins
//   - resource URI: slash-joined tree position + scheme prefix,
//     `meta.mcp.uri` wins; a fallback segment contributes a `{var}`
//     placeholder
//   - `meta.mcp.segment` overrides one branch node's own contribution to
//     both joins (same override, same source of truth as project.ts)
//
// The proxy shape mirrors the tree structure exactly, same as the HTTP
// client and the direct API:
//   - a branch child            → a nested client object, keyed by its own
//                                  tree key (not by any `meta.mcp.segment`
//                                  override — that only affects the derived
//                                  name/URI, never the navigation key)
//   - a `fallback`               → a function `(value: string) => sub-client`
//                                  keyed by `fallback.name`, capturing the
//                                  slug value into the accumulated
//                                  name-segment / URI-segment / substitution
//                                  map for everything under the subtree
//   - a leaf (`meta.mcp.as`)     → an async callable:
//       "tool" (default) → `client.callTool({ name, arguments: input })`
//       "resource"       → `client.readResource({ uri })`, `uri` assembled
//                           at call time by substituting any `{var}`
//                           placeholder with its captured slug value
//       "prompt"          → `client.getPrompt({ name, arguments: args })`
//
// Return-value ergonomics: `callTool`/`readResource` results are unwrapped
// when they carry exactly one `text` content block — the common case for a
// handler that returned a plain JS value, which the server wrapped via
// `JSON.stringify` (see server.ts's `toCallToolContent`/`toResourceContent`).
// Anything else (multi-part content, non-text content, an `isError` result)
// is surfaced as-is (or thrown, for `isError`) rather than guessing at a
// shape to force it into. Prompts are returned as the raw `GetPromptResult`
// (a `messages` array) — there is no single-value case to unwrap.
//
// See:
//   packages/mcp-api-projector/src/project.ts    — projectTools/projectResources/projectPrompts (name/URI source of truth)
//   packages/mcp-api-projector/src/server.ts     — createMcpServer (the dispatch this client mirrors)
//   packages/http-api-projector/src/client.ts    — sibling runtime client (structural mirror)

import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { CallToolResult, GetPromptResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js"
import { isLeaf } from "@rhi-zone/fractal-api-tree/node"
import type { Node } from "@rhi-zone/fractal-api-tree/node"
import { getMcpMeta } from "./project.ts"

// ============================================================================
// Public API types
// ============================================================================

export type McpClientOptions = {
  /** URI scheme prefix for derived resource URIs. Must match what `createMcpServer` was built with (defaults to `"resource://"`, same default as `projectResources`). */
  readonly resourceScheme?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMcpClient = Record<string, any>

/** Thrown when a tool call comes back with `isError: true`. */
export class McpClientError extends Error {
  constructor(
    message: string,
    readonly result: CallToolResult,
  ) {
    super(message)
    this.name = "McpClientError"
  }
}

// ============================================================================
// Internal: shared text-content unwrapping
//
// The server (server.ts's toCallToolContent/toResourceContent) wraps a
// plain handler return value as a single JSON.stringify'd text block. The
// client reverses that: a single text block round-trips through
// JSON.parse (falling back to the raw string when it isn't valid JSON — a
// handler is free to return a bare string). Anything else (multiple blocks,
// a non-text block, an already-MCP-shaped pass-through value) is handed
// back untouched — there is no single sensible shape to force it into.
// ============================================================================

function unwrapText(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function unwrapCallToolResult(result: CallToolResult): unknown {
  if (result.isError === true) {
    const content = result.content as Array<{ type: string; text?: string }>
    const message =
      content.length > 0 && content[0]!.type === "text" && typeof content[0]!.text === "string"
        ? content[0]!.text
        : "MCP tool call failed"
    throw new McpClientError(message, result)
  }
  const content = result.content as Array<{ type: string; text?: string }>
  if (content.length === 1 && content[0]!.type === "text" && typeof content[0]!.text === "string") {
    return unwrapText(content[0]!.text)
  }
  return result
}

function unwrapReadResourceResult(result: ReadResourceResult): unknown {
  const contents = result.contents as Array<{ text?: string }>
  if (contents.length === 1 && typeof contents[0]!.text === "string") {
    return unwrapText(contents[0]!.text)
  }
  return result
}

// ============================================================================
// Internal: URI template substitution
//
// A resource leaf's derived (or overridden) URI may carry `{var}`
// placeholders contributed by ancestor fallback nodes. Slug values are
// accumulated through the recursion (keyed by `fallback.name`) as the proxy
// is navigated, and substituted into the template at CALL time (not proxy-
// construction time) — matching the task's own framing and staying correct
// even when `meta.mcp.uri` is a hand-authored override that reuses the same
// `{var}` names as the derived URI would have.
// ============================================================================

function substituteSlugs(template: string, slugValues: Readonly<Record<string, string>>): string {
  return template.replace(/\{([^}]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(slugValues, name) ? slugValues[name]! : match,
  )
}

// ============================================================================
// Internal: leaf callers
// ============================================================================

function makeToolCaller(
  client: Client,
  name: string,
  slugValues: Readonly<Record<string, string>>,
): (input?: unknown) => Promise<unknown> {
  return async (input?: unknown): Promise<unknown> => {
    // Unlike HTTP (path params parsed server-side into handler input) and
    // unlike resource templates (server-side regex binds captured URI
    // segments into input — see server.ts's ReadResourceRequestSchema
    // handler), a `tools/call` dispatch (server.ts's CallToolRequestSchema
    // handler) just does `handler(args ?? {})` — there is no server-side
    // slug binding for tools. Any fallback value captured on the way to
    // this leaf must therefore be merged into the call arguments here;
    // caller-supplied fields win on key collision.
    const result = await client.callTool({
      name,
      arguments: { ...slugValues, ...((input ?? {}) as Record<string, unknown>) },
    })
    return unwrapCallToolResult(result as CallToolResult)
  }
}

function makeResourceCaller(
  client: Client,
  uriTemplate: string,
  slugValues: Readonly<Record<string, string>>,
): () => Promise<unknown> {
  return async (): Promise<unknown> => {
    const uri = substituteSlugs(uriTemplate, slugValues)
    const result = await client.readResource({ uri })
    return unwrapReadResourceResult(result as ReadResourceResult)
  }
}

function makePromptCaller(
  client: Client,
  name: string,
  slugValues: Readonly<Record<string, string>>,
): (args?: Record<string, string>) => Promise<GetPromptResult> {
  return async (args?: Record<string, string>): Promise<GetPromptResult> => {
    // Same reasoning as makeToolCaller: prompts/get dispatch (server.ts's
    // GetPromptRequestSchema handler) has no server-side slug binding either.
    return client.getPrompt({
      name,
      arguments: { ...slugValues, ...(args ?? {}) },
    }) as Promise<GetPromptResult>
  }
}

// ============================================================================
// Internal: recursive sub-client builder over the raw Node tree
//
// Mirrors project.ts's three walks exactly: `toolPrefix` accumulates the
// underscore-joined tree position (tools/prompts), `resourceSegments`
// accumulates the slash-joined tree position with a literal `{var}` for
// each fallback (resources), and `slugValues` accumulates the actual
// captured value for each fallback name encountered so far (substituted
// into a resource URI template at call time — see `substituteSlugs`).
// ============================================================================

function buildClientNode(
  node: Node,
  toolPrefix: string,
  resourceSegments: readonly string[],
  slugValues: Readonly<Record<string, string>>,
  client: Client,
  scheme: string,
): AnyMcpClient {
  const out: AnyMcpClient = {}

  for (const [key, child] of Object.entries(node.children ?? {})) {
    if (isLeaf(child)) {
      const mcp = getMcpMeta(child.meta)
      const as = mcp.as ?? "tool"

      if (as === "resource") {
        const leafSegments = [...resourceSegments, key]
        const derivedUri = `${scheme}${leafSegments.join("/")}`
        const uriTemplate = typeof mcp.uri === "string" ? mcp.uri : derivedUri
        out[key] = makeResourceCaller(client, uriTemplate, slugValues)
      } else {
        const name =
          typeof mcp.name === "string" ? mcp.name : toolPrefix.length > 0 ? `${toolPrefix}_${key}` : key
        out[key] =
          as === "prompt"
            ? makePromptCaller(client, name, slugValues)
            : makeToolCaller(client, name, slugValues)
      }
    } else {
      const childMcp = getMcpMeta(child.meta)
      const rawSeg = typeof childMcp.segment === "string" ? childMcp.segment : key
      const childToolPrefix = toolPrefix.length > 0 ? `${toolPrefix}_${rawSeg}` : rawSeg
      out[key] = buildClientNode(
        child,
        childToolPrefix,
        [...resourceSegments, rawSeg],
        slugValues,
        client,
        scheme,
      )
    }
  }

  if (node.fallback !== undefined) {
    const { name, subtree } = node.fallback
    const childToolPrefix = toolPrefix.length > 0 ? `${toolPrefix}_${name}` : name
    out[name] = (value: string): AnyMcpClient =>
      buildClientNode(
        subtree,
        childToolPrefix,
        [...resourceSegments, `{${name}}`],
        { ...slugValues, [name]: value },
        client,
        scheme,
      )
  }

  return out
}

// ============================================================================
// createMcpClient — public API
// ============================================================================

/**
 * Build a runtime MCP client from a `Node` tree and a connected MCP SDK
 * `Client`. The returned object mirrors the tree structure exactly (same
 * shape as `createClient` in http-api-projector):
 *
 *   - a branch child → a nested client object (keyed by its own tree key)
 *   - a `fallback`    → a function `(value: string) => sub-client` keyed by
 *                       `fallback.name`
 *   - a leaf          → an async callable, dispatched per `meta.mcp.as`:
 *       "tool" (default) → `(input?) => Promise<unknown>` via `callTool`
 *       "resource"        → `() => Promise<unknown>` via `readResource`
 *       "prompt"          → `(args?) => Promise<GetPromptResult>` via `getPrompt`
 *
 * Name/URI derivation reuses the exact same logic `projectTools`/
 * `projectResources`/`projectPrompts` (project.ts) use to build the server
 * side — the tree walk here is a second, independent computation of the
 * SAME derivation (not a different source of truth), so a client built from
 * the same tree a `createMcpServer` was built from always addresses the
 * right tool/resource/prompt.
 *
 * `client` must already be connected (`await client.connect(transport)`) —
 * this function only builds the proxy; it does no connection management.
 *
 * @param tree - The root node to project (same tree passed to `createMcpServer`).
 * @param client - A connected MCP SDK `Client` instance.
 * @param opts - Optional: `resourceScheme` (must match the server's `projectResources` scheme, default `"resource://"`).
 */
export function createMcpClient(tree: Node, client: Client, opts: McpClientOptions = {}): AnyMcpClient {
  const scheme = opts.resourceScheme ?? "resource://"
  return buildClientNode(tree, "", [], {}, client, scheme)
}
