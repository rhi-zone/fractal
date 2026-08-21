// CreateJsonRpcServerOptions.middleware.
//
// Covers: middleware is `F => F` where `F = (input, stores) => result` (see
// docs/design/middleware-and-caller-context.md) — a middleware can read from
// the raw pre-assembly `stores` (params/caller), can inspect/transform the
// assembled `input`, the handler itself never receives `stores` (structural,
// not a convention), and composition order (first entry = outermost
// wrapper). Mirrors CLI's `CliOpts.middleware` tests (cli-api-projector/src/
// middleware.test.ts) — same contract, JSON-RPC's HTTP transport in place of
// argv dispatch.

import { describe, expect, it } from "bun:test";
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node";
import { createJsonRpcHttpHandler } from "./server.ts";
import type { JsonRpcMiddleware } from "./server.ts";
import type { JsonRpcResponse } from "./wire.ts";

function post(handler: (req: Request) => Promise<Response>, body: unknown): Promise<Response> {
  return handler(
    new Request("http://localhost/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user": "alice" },
      body: JSON.stringify(body),
    }),
  );
}

describe("CreateJsonRpcServerOptions.middleware", () => {
  it("with no middleware configured, the handler is called directly", async () => {
    const tree = api_({ echo: op((input: { x: string }) => ({ got: input.x })) });
    const handler = createJsonRpcHttpHandler(tree);
    const res = await post(handler, { jsonrpc: "2.0", method: "echo", params: { x: "1" }, id: 1 });
    const body = (await res.json()) as JsonRpcResponse;
    expect(body).toMatchObject({ result: { got: "1" } });
  });

  it("middleware can read from stores — params and caller (request headers)", async () => {
    const tree = api_({ echo: op((input: { x: string }) => ({ got: input.x })) });
    let seenParamsX: unknown;
    let seenCallerUser: unknown;
    const readStores: JsonRpcMiddleware = (next) => (input, stores) => {
      seenParamsX = stores.params?.x;
      seenCallerUser = stores.caller?.["x-user"];
      return next(input, stores);
    };
    const handler = createJsonRpcHttpHandler(tree, { middleware: [readStores] });
    await post(handler, { jsonrpc: "2.0", method: "echo", params: { x: "1" }, id: 1 });
    expect(seenParamsX).toBe("1");
    expect(seenCallerUser).toBe("alice");
  });

  it("middleware wraps the handler call — can transform input before and output after", async () => {
    const tree = api_({ echo: op((input: { x: number }) => ({ got: input.x })) });
    const doubleInput: JsonRpcMiddleware = (next) => (input, stores) =>
      next({ ...input, x: (input.x as number) * 2 }, stores);
    const wrapOutput: JsonRpcMiddleware = (next) => async (input, stores) => {
      const result = await next(input, stores);
      return { wrapped: result };
    };
    const handler = createJsonRpcHttpHandler(tree, { middleware: [wrapOutput, doubleInput] });
    const res = await post(handler, { jsonrpc: "2.0", method: "echo", params: { x: 5 }, id: 1 });
    const body = (await res.json()) as JsonRpcResponse;
    expect(body).toMatchObject({ result: { wrapped: { got: 10 } } });
  });

  it("the handler does not receive stores — only the assembled input", async () => {
    const tree = api_({
      whatArgs: op((input: unknown) => ({ argCount: Object.keys(input as object).length })),
    });
    const passStores: JsonRpcMiddleware = (next) => (input, stores) => next(input, stores);
    const handler = createJsonRpcHttpHandler(tree, { middleware: [passStores] });
    const res = await post(handler, { jsonrpc: "2.0", method: "whatArgs", params: { x: "1" }, id: 1 });
    const body = (await res.json()) as JsonRpcResponse;
    expect(body).toMatchObject({ result: { argCount: 1 } });
  });

  it("composes multiple middleware — first entry is outermost (sees the call first and last)", async () => {
    const tree = api_({ echo: op((input: { x: string }) => ({ got: input.x })) });
    const order: string[] = [];
    const outer: JsonRpcMiddleware = (next) => async (input, stores) => {
      order.push("outer:before");
      const result = await next(input, stores);
      order.push("outer:after");
      return result;
    };
    const inner: JsonRpcMiddleware = (next) => async (input, stores) => {
      order.push("inner:before");
      const result = await next(input, stores);
      order.push("inner:after");
      return result;
    };
    const handler = createJsonRpcHttpHandler(tree, { middleware: [outer, inner] });
    await post(handler, { jsonrpc: "2.0", method: "echo", params: { x: "1" }, id: 1 });
    expect(order).toEqual(["outer:before", "inner:before", "inner:after", "outer:after"]);
  });

  it("middleware runs for Notifications too, even though no Response is sent back", async () => {
    let called = false;
    const tree = api_({ ping: op((_: unknown) => ({ ok: true })) });
    const observe: JsonRpcMiddleware = (next) => (input, stores) => {
      called = true;
      return next(input, stores);
    };
    const handler = createJsonRpcHttpHandler(tree, { middleware: [observe] });
    const res = await post(handler, { jsonrpc: "2.0", method: "ping" });
    expect(res.status).toBe(204);
    expect(called).toBe(true);
  });
});
