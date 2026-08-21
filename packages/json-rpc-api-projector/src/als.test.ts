// CreateJsonRpcServerOptions.als.
//
// Covers: handler runs inside the configured AsyncLocalStorage context,
// `init` receives JSON-RPC dispatch context (JsonRpcAlsContext), concurrent
// invocations stay isolated, and ALS composes with `opts.middleware` as the
// innermost wrapper (middleware sees the call before/after the ALS-entered
// handler — see CLI's sibling `als` option, cli-api-projector/src/
// als.test.ts, for the same contract).

import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "bun:test";
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node";
import { createJsonRpcHttpHandler } from "./server.ts";
import type { JsonRpcMiddleware } from "./server.ts";
import type { JsonRpcResponse } from "./wire.ts";

function post(handler: (req: Request) => Promise<Response>, body: unknown): Promise<Response> {
  return handler(
    new Request("http://localhost/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("CreateJsonRpcServerOptions.als", () => {
  it("the handler runs inside the AsyncLocalStorage context set up by init", async () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>();
    const tree = api_({
      whoami: op((_: unknown) => ({ requestId: storage.getStore()?.requestId ?? "none" })),
    });
    const handler = createJsonRpcHttpHandler(tree, {
      als: { storage, init: () => ({ requestId: "req-1" }) },
    });
    const res = await post(handler, { jsonrpc: "2.0", method: "whoami", id: 1 });
    const body = (await res.json()) as JsonRpcResponse;
    expect(body).toMatchObject({ result: { requestId: "req-1" } });
  });

  it("init receives JSON-RPC dispatch context (meta, method, isNotification)", async () => {
    const storage = new AsyncLocalStorage<{ method: string }>();
    let seenMethod: string | undefined;
    let seenIsNotification: boolean | undefined;
    let seenDescription: unknown;
    const tree = api_({
      echo: op((_: unknown) => ({ ok: true }), { description: "an echo method" }),
    });
    const handler = createJsonRpcHttpHandler(tree, {
      als: {
        storage,
        init: (context) => {
          seenMethod = context.method;
          seenIsNotification = context.isNotification;
          seenDescription = context.meta.description;
          return { method: context.method };
        },
      },
    });
    await post(handler, { jsonrpc: "2.0", method: "echo", id: 1 });
    expect(seenMethod).toBe("echo");
    expect(seenIsNotification).toBe(false);
    expect(seenDescription).toBe("an echo method");
  });

  it("a Notification still enters the ALS context, with isNotification true", async () => {
    let seenIsNotification: boolean | undefined;
    const storage = new AsyncLocalStorage<{ ok: true }>();
    const tree = api_({ ping: op((_: unknown) => ({ ok: true })) });
    const handler = createJsonRpcHttpHandler(tree, {
      als: {
        storage,
        init: (context) => {
          seenIsNotification = context.isNotification;
          return { ok: true } as const;
        },
      },
    });
    const res = await post(handler, { jsonrpc: "2.0", method: "ping" });
    expect(res.status).toBe(204);
    expect(seenIsNotification).toBe(true);
  });

  it("no ALS configured — handler runs with no store active (undefined)", async () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>();
    const tree = api_({
      whoami: op((_: unknown) => ({ requestId: storage.getStore()?.requestId ?? "none" })),
    });
    const handler = createJsonRpcHttpHandler(tree);
    const res = await post(handler, { jsonrpc: "2.0", method: "whoami", id: 1 });
    const body = (await res.json()) as JsonRpcResponse;
    expect(body).toMatchObject({ result: { requestId: "none" } });
  });

  it("concurrent invocations stay isolated — each sees its own context value", async () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>();
    const tree = api_({
      whoami: op(async (_: unknown) => {
        await new Promise((r) => setTimeout(r, 0));
        return { requestId: storage.getStore()?.requestId ?? "none" };
      }),
    });

    let counter = 0;
    const runs = [1, 2, 3].map(async () => {
      const id = `req-${counter++}`;
      const handler = createJsonRpcHttpHandler(tree, { als: { storage, init: () => ({ requestId: id }) } });
      const res = await post(handler, { jsonrpc: "2.0", method: "whoami", id: 1 });
      const body = (await res.json()) as JsonRpcResponse;
      return { id, body };
    });

    const results = await Promise.all(runs);
    for (const { id, body } of results) {
      expect((body as { result: { requestId: string } }).result.requestId).toBe(id);
    }
  });

  it("composes with middleware — ALS wraps only the handler, not middleware's own code", async () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>();
    let seenBeforeNext: string | undefined;
    let seenAfterNext: string | undefined;

    const observe: JsonRpcMiddleware = (next) => async (input, stores) => {
      seenBeforeNext = storage.getStore()?.requestId;
      const result = await next(input, stores);
      seenAfterNext = storage.getStore()?.requestId;
      return result;
    };

    const tree = api_({
      whoami: op((_: unknown) => ({ requestId: storage.getStore()?.requestId ?? "none" })),
    });
    const handler = createJsonRpcHttpHandler(tree, {
      als: { storage, init: () => ({ requestId: "req-mw" }) },
      middleware: [observe],
    });
    const res = await post(handler, { jsonrpc: "2.0", method: "whoami", id: 1 });
    const body = (await res.json()) as JsonRpcResponse;
    expect(body).toMatchObject({ result: { requestId: "req-mw" } });
    expect(seenBeforeNext).toBeUndefined();
    expect(seenAfterNext).toBeUndefined();
  });
});
