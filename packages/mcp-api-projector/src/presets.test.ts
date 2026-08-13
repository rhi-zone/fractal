// The two transport presets.
//
// What each preset adds over `createMcpServer` is wiring, so that is what is
// tested. The transports themselves are the SDK's, and already covered there.
//
// The stdio case connects over an in-memory stream pair rather than the
// process's own, and asserts only that it connected. The HTTP case drives the
// returned handler with real `Request` objects through the whole session
// lifecycle: initialize, a routed follow-up, an unknown session, and a request
// that has no session and is not an initialize.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "bun:test";
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node";
import { createHttpMcpServer, createStdioMcpServer } from "./presets.ts";

const tree = api_({
  users: api_({
    get: op((input: { id: string }) => ({ id: input.id, name: "Alice" }), {
      tags: { readOnly: true },
    }),
  }),
});

// ============================================================================
// createStdioMcpServer
// ============================================================================

describe("createStdioMcpServer", () => {
  it("connects the server to a StdioServerTransport over supplied streams", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    const server = await createStdioMcpServer(tree, {
      name: "test-stdio-server",
      version: "1.0.0",
      stdio: { stdin, stdout },
    });

    // Connecting without throwing is the whole contract; framing and the read
    // loop belong to the SDK.
    expect(server).toBeDefined();

    await server.close();
  });
});

// ============================================================================
// createHttpMcpServer
// ============================================================================

function initializeRequest(): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    }),
  });
}

describe("createHttpMcpServer", () => {
  it("handles an initialize request and issues a session id", async () => {
    const handler = createHttpMcpServer(tree, { name: "test-http-server", version: "1.0.0" });

    const res = await handler(initializeRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("routes a follow-up request with the session id to the same session", async () => {
    const handler = createHttpMcpServer(tree, { name: "test-http-server", version: "1.0.0" });

    const initRes = await handler(initializeRequest());
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const listRes = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Session-Id": sessionId ?? "",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      }),
    );

    expect(listRes.status).toBe(200);
    const contentType = listRes.headers.get("content-type") ?? "";
    const text = await listRes.text();
    const body = contentType.includes("text/event-stream")
      ? text
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice("data:".length)
          .trim()
      : text;
    const parsed = JSON.parse(body ?? "{}");
    const names = (parsed.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    expect(names).toEqual(["users_get"]);
  });

  it("rejects a request carrying an unknown session id", async () => {
    const handler = createHttpMcpServer(tree, { name: "test-http-server", version: "1.0.0" });

    const res = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Session-Id": "does-not-exist",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
      }),
    );

    expect(res.status).toBe(404);
  });

  it("rejects a non-initialize request with no session id", async () => {
    const handler = createHttpMcpServer(tree, { name: "test-http-server", version: "1.0.0" });

    const res = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }),
      }),
    );

    expect(res.status).toBe(400);
  });
});
