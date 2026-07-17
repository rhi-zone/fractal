// packages/mcp-api-projector/src/presets.ts — @rhi-zone/fractal-mcp-api-projector
//
// Transport-owning convenience presets over `createMcpServer` (server.ts).
// `createMcpServer` deliberately returns an unconnected `Server` and leaves
// transport choice/wiring to the caller (see server.ts's module comment) —
// these presets are the "I don't want to think about it" one-call entry
// points for the two most common cases, mirroring `createFetch`
// (http-api-projector/src/preset.ts) which owns the HTTP stack the same way.
//
// Two presets, because those are the two transports the SDK actually ships
// that fit a one-call preset shape:
//
//   - `createStdioMcpServer` — `StdioServerTransport` (`server/stdio.js`).
//     The common case for CLI-launched MCP servers (Claude Desktop, most
//     local dev setups): one process, one stdio pipe, one session for the
//     life of the process. Connects and returns the `Server`.
//
//   - `createHttpMcpServer` — `WebStandardStreamableHTTPServerTransport`
//     (`server/webStandardStreamableHttp.js`), the fetch-Request/Response
//     flavor of the SDK's Streamable HTTP transport (as opposed to
//     `server/streamableHttp.js`'s `StreamableHTTPServerTransport`, which
//     wants Node's `http.IncomingMessage`/`ServerResponse`). Picked because
//     it returns a `(req: Request) => Promise<Response>` handler — the same
//     shape `createFetch` returns, and the shape `Bun.serve`/`Deno.serve`/a
//     Cloudflare Worker all accept directly.
//
//     Unlike stdio, one HTTP transport instance can't serve every request:
//     the Streamable HTTP spec is session-based (an `initialize` call gets a
//     fresh session ID, every later call for that session carries an
//     `Mcp-Session-Id` header and must reach the *same* transport/server
//     pair — it holds the session's protocol/negotiation state). So this
//     preset keeps a `Map<sessionId, { server, transport }>` and:
//       - a request with a known `Mcp-Session-Id` routes to its transport;
//       - a request with an unknown session id is rejected (session expired
//         or never existed — nothing to route to);
//       - a request with no session id must be an `initialize` call (peeked
//         via `isInitializeRequest` on the parsed body, since the transport
//         itself only reads the body after routing decides where it goes) —
//         anything else with no session id is a protocol error, not a new
//         session; this preset builds a fresh `createMcpServer` + transport
//         pair for it, connects them, and lets `onsessioninitialized` /
//         `onsessionclosed` keep the map in sync as the session's lifecycle
//         plays out.
//
// SSE (`server/sse.js`, the pre-Streamable-HTTP transport) is intentionally
// not presented here: it's the deprecated predecessor to Streamable HTTP,
// superseded for new servers, and would just duplicate the session-map
// plumbing above for a legacy wire format.

import type { Readable, Writable } from "node:stream"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { WebStandardStreamableHTTPServerTransportOptions } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import type { Node } from "@rhi-zone/fractal-api-tree/node"
import { createMcpServer } from "./server.ts"
import type { CreateMcpServerOptions } from "./server.ts"

export type CreateStdioMcpServerOptions = CreateMcpServerOptions & {
  /**
   * Streams to read/write instead of the real `process.stdin`/`process.stdout`
   * — mainly for tests, so a preset call doesn't reach for the actual
   * process streams. Forwarded as-is to `StdioServerTransport`'s
   * constructor, which defaults to the real process streams when omitted.
   */
  readonly stdio?: { readonly stdin?: Readable; readonly stdout?: Writable }
}

/**
 * Build an MCP `Server` from `tree` (via `createMcpServer`), connect it to a
 * `StdioServerTransport`, and return the connected server.
 *
 * ```ts
 * const server = await createStdioMcpServer(tree, { name: "my-api", version: "1.0.0" })
 * ```
 *
 * This is the CLI/local-process case: one stdio pipe, one session for the
 * life of the process. For a server address by multiple concurrent clients
 * over HTTP, see `createHttpMcpServer`.
 */
export async function createStdioMcpServer(
  tree: Node,
  opts: CreateStdioMcpServerOptions,
): Promise<Server> {
  const server = createMcpServer(tree, opts)
  const transport = new StdioServerTransport(opts.stdio?.stdin, opts.stdio?.stdout)
  await server.connect(transport)
  return server
}

export type CreateHttpMcpServerOptions = CreateMcpServerOptions & {
  /**
   * Forwarded to each session's `WebStandardStreamableHTTPServerTransport`,
   * except `sessionIdGenerator`/`onsessioninitialized`/`onsessionclosed` —
   * this preset owns those three to maintain its session map.
   */
  readonly transport?: Omit<
    WebStandardStreamableHTTPServerTransportOptions,
    "sessionIdGenerator" | "onsessioninitialized" | "onsessionclosed"
  >
}

const jsonRpcError = (status: number, code: number, message: string): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  })

/**
 * Build a fetch-compatible `(req: Request) => Promise<Response>` handler
 * that serves `tree` as an MCP server over Streamable HTTP.
 *
 * ```ts
 * const handler = createHttpMcpServer(tree, { name: "my-api", version: "1.0.0" })
 * Bun.serve({ fetch: handler })
 * ```
 *
 * Handles the transport's session lifecycle (see the module comment above
 * for the routing rules): a fresh `createMcpServer` + transport pair is
 * built and connected per new session, keyed by the session id the
 * transport itself generates on `initialize`.
 */
export function createHttpMcpServer(
  tree: Node,
  opts: CreateHttpMcpServerOptions,
): (req: Request) => Promise<Response> {
  const sessions = new Map<
    string,
    { readonly server: Server; readonly transport: WebStandardStreamableHTTPServerTransport }
  >()

  return async (req: Request): Promise<Response> => {
    const sessionId = req.headers.get("mcp-session-id") ?? undefined

    if (sessionId !== undefined) {
      const entry = sessions.get(sessionId)
      if (entry === undefined) {
        return jsonRpcError(404, -32001, `Unknown session: ${sessionId}`)
      }
      return entry.transport.handleRequest(req)
    }

    // No session id: the only valid request without one is `initialize` —
    // peek at the body (without consuming the request the transport will
    // itself read) to tell an initialize call from a stray/expired-session
    // request.
    const parsedBody: unknown = await req
      .clone()
      .json()
      .catch(() => undefined)

    if (!isInitializeRequest(parsedBody)) {
      return jsonRpcError(400, -32000, "Bad Request: No valid session ID provided")
    }

    const server = createMcpServer(tree, opts)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport })
      },
      onsessionclosed: (id) => {
        sessions.delete(id)
      },
      ...opts.transport,
    })

    await server.connect(transport)
    return transport.handleRequest(req, { parsedBody })
  }
}
