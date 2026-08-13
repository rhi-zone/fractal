// One-call entry points for the two transports most servers actually want.
//
// `createMcpServer` returns an unconnected `Server` on purpose, leaving
// transport choice to the caller. These two make that choice, for callers who
// would rather not — the same service `createFetch`
// (http-api-projector/src/preset.ts) provides by owning the HTTP stack outright.
//
// `createStdioMcpServer` connects a `StdioServerTransport`: one process, one
// pipe, one session for as long as the process lives. That is the shape a
// CLI-launched server runs in, which covers most local development and most
// desktop MCP clients.
//
// `createHttpMcpServer` returns a `(req: Request) => Promise<Response>` handler
// over the SDK's Streamable HTTP transport. Of the SDK's two implementations it
// uses the fetch-flavored `WebStandardStreamableHTTPServerTransport`, whose
// handler `Bun.serve`, `Deno.serve` and a Cloudflare Worker all accept as-is —
// the other wants Node's `IncomingMessage`/`ServerResponse`.
//
// HTTP needs more than stdio does, because Streamable HTTP is session-based. An
// `initialize` call is issued a session id, every later call carries it, and
// all of them must reach the same transport instance, which holds that
// session's negotiated state. So this preset keeps a map from session id to its
// server and transport, and routes on the way in:
//
//   - a known session id goes to its own transport;
//   - an unknown one is rejected — expired or never issued, either way there is
//     nothing to route it to;
//   - no session id at all is only valid for `initialize`, which gets a fresh
//     server and transport, connected and recorded. Anything else without a
//     session id is a protocol error, not an invitation to start one.
//
// Recognizing `initialize` means reading the body before the transport does,
// which is why the request is cloned and the parsed body handed onward rather
// than parsed twice.
//
// The SDK's older SSE transport is not offered here. Streamable HTTP replaced
// it, and wrapping it would mean maintaining the same session plumbing twice,
// once for a wire format new servers have no reason to choose.

import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { WebStandardStreamableHTTPServerTransportOptions } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Node } from "@rhi-zone/fractal-api-tree/node";
import { createMcpServer } from "./server.ts";
import type { CreateMcpServerOptions } from "./server.ts";

export type CreateStdioMcpServerOptions = CreateMcpServerOptions & {
  /**
   * Streams to use in place of the process's own. Forwarded to
   * `StdioServerTransport`, which falls back to `process.stdin`/`process.stdout`
   * when this is omitted. Mainly for tests, which should not have to give up
   * their real streams to exercise a preset.
   */
  readonly stdio?: { readonly stdin?: Readable; readonly stdout?: Writable };
};

/**
 * Serve `tree` over stdio: build the server, connect it, hand it back
 * connected.
 *
 * ```ts
 * const server = await createStdioMcpServer(tree, { name: "my-api", version: "1.0.0" })
 * ```
 *
 * One pipe, one session, for as long as the process runs. For a server several
 * clients address concurrently, see `createHttpMcpServer`.
 */
export async function createStdioMcpServer(
  tree: Node,
  opts: CreateStdioMcpServerOptions,
): Promise<Server> {
  const server = createMcpServer(tree, opts);
  const transport = new StdioServerTransport(opts.stdio?.stdin, opts.stdio?.stdout);
  await server.connect(transport);
  return server;
}

export type CreateHttpMcpServerOptions = CreateMcpServerOptions & {
  /**
   * Forwarded to each session's transport. Three options are missing from the
   * type — `sessionIdGenerator`, `onsessioninitialized` and `onsessionclosed` —
   * because this preset supplies them itself to keep its session map true.
   */
  readonly transport?: Omit<
    WebStandardStreamableHTTPServerTransportOptions,
    "sessionIdGenerator" | "onsessioninitialized" | "onsessionclosed"
  >;
};

const jsonRpcError = (status: number, code: number, message: string): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * Serve `tree` over Streamable HTTP, as a handler any fetch-shaped runtime can
 * take.
 *
 * ```ts
 * const handler = createHttpMcpServer(tree, { name: "my-api", version: "1.0.0" })
 * Bun.serve({ fetch: handler })
 * ```
 *
 * Sessions are handled for you: one server and transport per session, created
 * on `initialize`, kept until the session closes. The module comment above has
 * the routing rules.
 */
export function createHttpMcpServer(
  tree: Node,
  opts: CreateHttpMcpServerOptions,
): (req: Request) => Promise<Response> {
  const sessions = new Map<
    string,
    { readonly server: Server; readonly transport: WebStandardStreamableHTTPServerTransport }
  >();

  return async (req: Request): Promise<Response> => {
    const sessionId = req.headers.get("mcp-session-id") ?? undefined;

    if (sessionId !== undefined) {
      const entry = sessions.get(sessionId);
      if (entry === undefined) {
        return jsonRpcError(404, -32001, `Unknown session: ${sessionId}`);
      }
      return entry.transport.handleRequest(req);
    }

    // The body has to be read to tell an `initialize` from a request that
    // simply lost its session — but the transport will read it too, so this
    // reads a clone and passes the parsed result along rather than leaving the
    // real request drained.
    const parsedBody: unknown = await req
      .clone()
      .json()
      .catch(() => undefined);

    if (!isInitializeRequest(parsedBody)) {
      return jsonRpcError(400, -32000, "Bad Request: No valid session ID provided");
    }

    const server = createMcpServer(tree, opts);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
      ...opts.transport,
    });

    await server.connect(transport);
    return transport.handleRequest(req, { parsedBody });
  };
}
