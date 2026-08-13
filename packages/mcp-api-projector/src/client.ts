// A runtime client over the same Node tree a server was built from,
// dispatching through the MCP SDK's `Client`. Like http-api-projector's own
// client, this is an enumerating projection rather than a dispatching one
// (docs/design/router-model.md, "Projections"): the whole tree is walked once,
// up front, into an object mirroring it.
//
// So navigating the client reads like navigating the tree:
//
//   branch child   → a nested client object under that child's own tree key —
//                    its key, never a `meta.mcp.segment` override, which
//                    affects the derived name or URI and not how you get there
//   fallback       → a function under the fallback's name, `(value) => …`,
//                    capturing the value for everything reached through it
//   leaf           → an async call, per `meta.mcp.as`:
//                      tool     → `callTool({ name, arguments })`
//                      resource → `readResource({ uri })`, the URI assembled
//                                 at call time from any captured values
//                      prompt   → `getPrompt({ name, arguments })`
//
// Names and URIs are derived here the same way project.ts derives them, by a
// second walk over the same tree rather than by consuming project.ts's output.
// That is a real duplication and the reason client.test.ts asserts, against a
// live server, that every name and URI this walk produces is one the server's
// own projection listed. Building on the raw tree is what makes the proxy's
// shape — branches, fallbacks, leaves — available at all; a projected tool list
// is flat and has lost it.
//
// Results are unwrapped where there is exactly one sensible value to unwrap: a
// single text block, which is what the server produces for a handler that
// returned a plain value. Multi-part content, non-text content and anything
// else come back as the raw result, because forcing a shape onto them would be
// guessing. An `isError` result is thrown rather than returned. Prompts are
// never unwrapped — a `GetPromptResult` is a list of messages, with no single
// value inside it.
//
// See:
//   packages/mcp-api-projector/src/project.ts — where the same names and URIs are derived for the server
//   packages/mcp-api-projector/src/server.ts  — the dispatch this client is aimed at
//   packages/http-api-projector/src/client.ts — sibling runtime client (structural mirror)

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  CallToolResult,
  GetPromptResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { isLeaf } from "@rhi-zone/fractal-api-tree/node";
import type { Node } from "@rhi-zone/fractal-api-tree/node";
import { getMcpMeta } from "./project.ts";
import type { McpBranchMeta, McpLeafMeta } from "./project.ts";

// ============================================================================
// Public API types
// ============================================================================

export type McpClientOptions = {
  /** The scheme resource URIs are built behind. Must be the one the server derived its URIs with, or reads will address nothing. Defaults to `"resource://"`, as `projectResources` does. */
  readonly resourceScheme?: string;
};

/**
 * The proxy's type. A branch's children, a fallback's capture function and a
 * leaf's call all live under the same object, so nothing narrower would
 * describe it without the tree's own types to project from.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMcpClient = Record<string, any>;

/** A tool call the server answered with `isError: true`. Carries the whole result, since the message is only its first text block. */
export class McpClientError extends Error {
  constructor(
    message: string,
    readonly result: CallToolResult,
  ) {
    super(message);
    this.name = "McpClientError";
  }
}

// ============================================================================
// Unwrapping a result
// ============================================================================
//
// The server turns a plain handler return value into one JSON text block
// (server.ts's `toCallToolContent` and `toResourceContent`). Undoing exactly
// that is what makes a proxy call read like the handler call it stands in for.
//
// So: one text block, parsed as JSON, or handed back as the string it is when
// it does not parse — a handler is free to return a bare string, and quoting
// is not evidence of anything. Anything else keeps its result wrapper.

function unwrapText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function unwrapCallToolResult(result: CallToolResult): unknown {
  if (result.isError === true) {
    const content = result.content as Array<{ type: string; text?: string }>;
    const message =
      content.length > 0 && content[0]!.type === "text" && typeof content[0]!.text === "string"
        ? content[0]!.text
        : "MCP tool call failed";
    throw new McpClientError(message, result);
  }
  const content = result.content as Array<{ type: string; text?: string }>;
  if (content.length === 1 && content[0]!.type === "text" && typeof content[0]!.text === "string") {
    return unwrapText(content[0]!.text);
  }
  return result;
}

function unwrapReadResourceResult(result: ReadResourceResult): unknown {
  const contents = result.contents as Array<{ text?: string }>;
  if (contents.length === 1 && typeof contents[0]!.text === "string") {
    return unwrapText(contents[0]!.text);
  }
  return result;
}

// ============================================================================
// URI template substitution
// ============================================================================
//
// A resource URI may carry placeholders, contributed by the fallback nodes
// above it. Their values are collected as the proxy is navigated and
// substituted when the call is made, not when the proxy is built — which is
// what keeps a hand-authored `meta.mcp.uri` working, placeholders and all,
// exactly as the derived URI would have.
//
// A placeholder with no captured value is left standing rather than blanked, so
// a URI that cannot be completed fails visibly at the server.

function substituteSlugs(template: string, slugValues: Readonly<Record<string, string>>): string {
  return template.replace(/\{([^}]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(slugValues, name) ? slugValues[name]! : match,
  );
}

// ============================================================================
// Leaf callers
// ============================================================================

function makeToolCaller(
  client: Client,
  name: string,
  slugValues: Readonly<Record<string, string>>,
): (input?: unknown) => Promise<unknown> {
  return async (input?: unknown): Promise<unknown> => {
    // A tool name records that a fallback was passed, but not what was passed
    // — "users_userId_get" is the same string whichever user it was. So unlike
    // a resource read, where the server binds what the URI captured, or an HTTP
    // request, where it binds what the path captured, a tool call has no
    // server-side source for the value. It has to travel as an argument, and
    // does. An argument the caller supplied under the same name wins.
    const result = await client.callTool({
      name,
      arguments: { ...slugValues, ...((input ?? {}) as Record<string, unknown>) },
    });
    return unwrapCallToolResult(result as CallToolResult);
  };
}

function makeResourceCaller(
  client: Client,
  uriTemplate: string,
  slugValues: Readonly<Record<string, string>>,
): () => Promise<unknown> {
  return async (): Promise<unknown> => {
    const uri = substituteSlugs(uriTemplate, slugValues);
    const result = await client.readResource({ uri });
    return unwrapReadResourceResult(result as ReadResourceResult);
  };
}

function makePromptCaller(
  client: Client,
  name: string,
  slugValues: Readonly<Record<string, string>>,
): (args?: Record<string, string>) => Promise<GetPromptResult> {
  return async (args?: Record<string, string>): Promise<GetPromptResult> => {
    // Prompt names lose captured values exactly as tool names do, so the
    // values travel as arguments here too.
    return client.getPrompt({
      name,
      arguments: { ...slugValues, ...args },
    }) as Promise<GetPromptResult>;
  };
}

// ============================================================================
// Building the proxy
// ============================================================================
//
// One descent, carrying three accumulators, because a leaf's surface is not
// known until it is reached: `toolPrefix` is the underscore-joined position a
// tool or prompt would be named from, `resourceSegments` the slash-joined
// position a resource URI would be built from, with a placeholder wherever a
// fallback was passed, and `slugValues` the values those fallbacks actually
// captured.

function buildClientNode(
  node: Node,
  toolPrefix: string,
  resourceSegments: readonly string[],
  slugValues: Readonly<Record<string, string>>,
  client: Client,
  scheme: string,
): AnyMcpClient {
  const out: AnyMcpClient = {};

  for (const [key, child] of Object.entries(node.children ?? {})) {
    if (isLeaf(child)) {
      const mcp = getMcpMeta(child.meta as McpLeafMeta & McpBranchMeta);
      const as = mcp.as ?? "tool";

      if (as === "resource") {
        const leafSegments = [...resourceSegments, key];
        const derivedUri = `${scheme}${leafSegments.join("/")}`;
        const uriTemplate = typeof mcp.uri === "string" ? mcp.uri : derivedUri;
        out[key] = makeResourceCaller(client, uriTemplate, slugValues);
      } else {
        const name =
          typeof mcp.name === "string"
            ? mcp.name
            : toolPrefix.length > 0
              ? `${toolPrefix}_${key}`
              : key;
        out[key] =
          as === "prompt"
            ? makePromptCaller(client, name, slugValues)
            : makeToolCaller(client, name, slugValues);
      }
    } else {
      const childMcp = getMcpMeta(child.meta as McpLeafMeta & McpBranchMeta);
      const rawSeg = typeof childMcp.segment === "string" ? childMcp.segment : key;
      const childToolPrefix = toolPrefix.length > 0 ? `${toolPrefix}_${rawSeg}` : rawSeg;
      out[key] = buildClientNode(
        child,
        childToolPrefix,
        [...resourceSegments, rawSeg],
        slugValues,
        client,
        scheme,
      );
    }
  }

  if (node.fallback !== undefined) {
    const { name, subtree } = node.fallback;
    const childToolPrefix = toolPrefix.length > 0 ? `${toolPrefix}_${name}` : name;

    // `fallback.subtree` may be a bare `op()` rather than an `api({...})`; the
    // Node model allows either (api-tree/node.ts). Recursing into a bare leaf
    // would read the `children` it does not have and hand back an empty object
    // with nothing callable on it. So when the subtree is the leaf, capturing
    // the value returns that leaf's caller directly — `widgets.widgetId("w-1")`
    // is itself the call, with no property to reach for afterwards. project.ts
    // and api-tree's `walkNodeType` (aa28952) handle the same case.
    out[name] = isLeaf(subtree)
      ? (value: string): unknown => {
          const mcp = getMcpMeta(subtree.meta as McpLeafMeta & McpBranchMeta);
          const as = mcp.as ?? "tool";
          const leafSlugValues = { ...slugValues, [name]: value };
          if (as === "resource") {
            const leafSegments = [...resourceSegments, `{${name}}`];
            const derivedUri = `${scheme}${leafSegments.join("/")}`;
            const uriTemplate = typeof mcp.uri === "string" ? mcp.uri : derivedUri;
            return makeResourceCaller(client, uriTemplate, leafSlugValues);
          }
          const toolName = typeof mcp.name === "string" ? mcp.name : childToolPrefix;
          return as === "prompt"
            ? makePromptCaller(client, toolName, leafSlugValues)
            : makeToolCaller(client, toolName, leafSlugValues);
        }
      : (value: string): AnyMcpClient =>
          buildClientNode(
            subtree,
            childToolPrefix,
            [...resourceSegments, `{${name}}`],
            { ...slugValues, [name]: value },
            client,
            scheme,
          );
  }

  return out;
}

// ============================================================================
// createMcpClient
// ============================================================================

/**
 * Build a client that mirrors `tree`, calling through an already-connected MCP
 * SDK `Client`:
 *
 *   - a branch   → a nested client object under its own tree key
 *   - a fallback → `(value: string) => …`, under the fallback's name
 *   - a leaf     → an async call, per `meta.mcp.as`:
 *       tool     → `(input?) => Promise<unknown>`
 *       resource → `() => Promise<unknown>`
 *       prompt   → `(args?) => Promise<GetPromptResult>`
 *
 * Pass the same tree the server was built from and the names and URIs will
 * match; the module comment above explains why they are derived again here
 * rather than shared, and what pins them together.
 *
 * Connecting is the caller's — this builds a proxy and manages no connection.
 *
 * @param tree   - The root node, as passed to `createMcpServer`.
 * @param client - A connected MCP SDK `Client`.
 * @param opts   - Optionally, the `resourceScheme` the server derives URIs with.
 */
export function createMcpClient(
  tree: Node,
  client: Client,
  opts: McpClientOptions = {},
): AnyMcpClient {
  const scheme = opts.resourceScheme ?? "resource://";
  return buildClientNode(tree, "", [], {}, client, scheme);
}
