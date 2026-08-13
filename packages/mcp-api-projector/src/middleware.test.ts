// CreateMcpServerOptions.middleware.
//
// A middleware receives the assembled `input` and the `stores` it was assembled
// from, may change either on the way in or the result on the way out, and
// composes first-entry-outermost
// (docs/design/middleware-and-caller-context.md). The handler receives only
// `input`, whatever middleware sits above it. Driven through a real `Client`
// over `InMemoryTransport`, as server.test.ts is.

import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node";
import type { Node } from "@rhi-zone/fractal-api-tree/node";
import { createMcpServer } from "./server.ts";
import type { CreateMcpServerOptions, McpMiddleware } from "./server.ts";

async function connectedClient(tree: Node, opts: Omit<CreateMcpServerOptions, "name" | "version">) {
  const server = createMcpServer(tree, { name: "test-server", version: "1.0.0", ...opts });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  const block = content[0];
  return block?.type === "text" ? (block.text ?? "") : "";
}

describe("CreateMcpServerOptions.middleware — tools", () => {
  const tree = api_({
    echo: op((input: { x: string }) => ({ got: input.x }), { description: "an echo op" }),
  });

  it("with no middleware configured, the handler is called directly", async () => {
    const { client } = await connectedClient(tree, {});
    const result = await client.callTool({ name: "echo", arguments: { x: "1" } });
    expect(JSON.parse(textOf(result))).toEqual({ got: "1" });
  });

  it("middleware can read from stores — the raw pre-assembly argument store", async () => {
    let seenRawX: unknown;
    const readStores: McpMiddleware = (next) => (input, stores) => {
      seenRawX = stores.argument?.x;
      return next(input, stores);
    };
    const { client } = await connectedClient(tree, { middleware: [readStores] });
    await client.callTool({ name: "echo", arguments: { x: "1" } });
    expect(seenRawX).toBe("1");
  });

  it("middleware can inspect and transform input before and after the handler runs", async () => {
    const doubleInput: McpMiddleware = (next) => (input, stores) =>
      next({ ...input, x: String(Number(input.x) * 2) }, stores);
    const wrapOutput: McpMiddleware = (next) => async (input, stores) => {
      const result = await next(input, stores);
      return { wrapped: result };
    };
    const numTree = api_({ echo: op((input: { x: string }) => ({ got: Number(input.x) }), {}) });
    const { client } = await connectedClient(numTree, { middleware: [wrapOutput, doubleInput] });
    const result = await client.callTool({ name: "echo", arguments: { x: "5" } });
    expect(JSON.parse(textOf(result))).toEqual({ wrapped: { got: 10 } });
  });

  it("the handler does not receive stores — only the assembled input", async () => {
    // The middleware passes `stores` along faithfully; the handler still
    // reports only its input, because the base of the chain drops them.
    const argsTree = api_({
      whatArgs: op(
        (input: unknown) => ({
          argCount: (input as object) === null ? 0 : Object.keys(input as object).length,
          input,
        }),
        {},
      ),
    });
    const passStores: McpMiddleware = (next) => (input, stores) => next(input, stores);
    const { client } = await connectedClient(argsTree, { middleware: [passStores] });
    const result = await client.callTool({ name: "whatArgs", arguments: { x: "1" } });
    expect(JSON.parse(textOf(result))).toEqual({ argCount: 1, input: { x: "1" } });
  });

  it("middleware sets up an AsyncLocalStorage caller-context the handler can read", async () => {
    const als = new AsyncLocalStorage<{ name: string }>();
    const alsTree = api_({
      whoami: op((_: unknown) => ({ name: als.getStore()?.name ?? "none" }), {}),
    });
    const withAls: McpMiddleware = (next) => (input, stores) =>
      als.run({ name: String(stores.argument?.name ?? "unknown") }, () => next(input, stores));
    const { client } = await connectedClient(alsTree, { middleware: [withAls] });
    const result = await client.callTool({ name: "whoami", arguments: { name: "caller-1" } });
    expect(JSON.parse(textOf(result))).toEqual({ name: "caller-1" });
  });

  it("composes multiple middleware — first entry is outermost (sees the call first and last)", async () => {
    const order: string[] = [];
    const outer: McpMiddleware = (next) => async (input, stores) => {
      order.push("outer:before");
      const result = await next(input, stores);
      order.push("outer:after");
      return result;
    };
    const inner: McpMiddleware = (next) => async (input, stores) => {
      order.push("inner:before");
      const result = await next(input, stores);
      order.push("inner:after");
      return result;
    };
    const { client } = await connectedClient(tree, { middleware: [outer, inner] });
    await client.callTool({ name: "echo", arguments: { x: "1" } });
    expect(order).toEqual(["outer:before", "inner:before", "inner:after", "outer:after"]);
  });

  it("middleware can read the caller store — populated from the SDK's RequestHandlerExtra (sessionId/authInfo)", async () => {
    // `InMemoryTransport` manages no sessions and no auth, so both fields are
    // undefined here. The store is still built and still carries exactly what
    // the SDK supplied — undefined being a real value from `extra`, not a
    // stand-in.
    let sawCallerStore = false;
    let seenSessionId: unknown;
    let seenAuthInfo: unknown;
    const readCaller: McpMiddleware = (next) => (input, stores) => {
      sawCallerStore = stores.caller !== undefined;
      seenSessionId = stores.caller?.sessionId;
      seenAuthInfo = stores.caller?.authInfo;
      return next(input, stores);
    };
    const { client } = await connectedClient(tree, { middleware: [readCaller] });
    const result = await client.callTool({ name: "echo", arguments: { x: "1" } });
    expect(JSON.parse(textOf(result))).toEqual({ got: "1" });
    expect(sawCallerStore).toBe(true);
    expect(seenSessionId).toBeUndefined();
    expect(seenAuthInfo).toBeUndefined();
  });

  it("the handler's assembled input does not include caller fields unless explicitly sourceMapped", async () => {
    const { client } = await connectedClient(tree, {});
    const result = await client.callTool({ name: "echo", arguments: { x: "1" } });
    const parsed = JSON.parse(textOf(result));
    expect(parsed).toEqual({ got: "1" });
    expect(parsed.sessionId).toBeUndefined();
    expect(parsed.authInfo).toBeUndefined();
  });
});

describe("CreateMcpServerOptions.middleware — resources", () => {
  const tree = api_({
    config: op((_: unknown) => ({ debug: true }), { mcp: { as: "resource" } }),
    users: api_(
      {},
      {
        fallback: {
          name: "userId",
          subtree: api_({
            profile: op((input: { userId: string }) => ({ id: input.userId }), {
              mcp: { as: "resource" },
            }),
          }),
        },
      },
    ),
  });

  it("middleware wraps a fixed resource read", async () => {
    let called = false;
    const track: McpMiddleware = (next) => (input, stores) => {
      called = true;
      return next(input, stores);
    };
    const { client } = await connectedClient(tree, { middleware: [track] });
    await client.readResource({ uri: "resource://config" });
    expect(called).toBe(true);
  });

  it("middleware wraps a resource-template read and can read the captured slug from stores", async () => {
    let seenUserId: unknown;
    const track: McpMiddleware = (next) => (input, stores) => {
      seenUserId = stores["uri-variable"]?.userId;
      return next(input, stores);
    };
    const { client } = await connectedClient(tree, { middleware: [track] });
    const result = await client.readResource({ uri: "resource://users/u1/profile" });
    const content = result.contents[0] as { text: string };
    expect(JSON.parse(content.text)).toEqual({ id: "u1" });
    expect(seenUserId).toBe("u1");
  });
});

describe("CreateMcpServerOptions.middleware — prompts", () => {
  const tree = api_({
    greet: op(
      (input: { who: string }) => ({
        messages: [{ role: "assistant", content: { type: "text", text: `hi ${input.who}` } }],
      }),
      { mcp: { as: "prompt" } },
    ),
  });

  it("middleware can read the prompt's raw argument from stores", async () => {
    let seenWho: unknown;
    const track: McpMiddleware = (next) => (input, stores) => {
      seenWho = stores.argument?.who;
      return next(input, stores);
    };
    const { client } = await connectedClient(tree, { middleware: [track] });
    const result = await client.getPrompt({ name: "greet", arguments: { who: "world" } });
    expect((result.messages[0]?.content as { text: string }).text).toBe("hi world");
    expect(seenWho).toBe("world");
  });
});
