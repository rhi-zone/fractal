// packages/json-rpc-api-projector/src/server.test.ts — HTTP POST + WebSocket transport tests

import { describe, expect, it } from "bun:test";
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node";
import { err, ok } from "@rhi-zone/fractal-api-tree";
import {
  createJsonRpcHttpHandler,
  createJsonRpcWebSocketHandlers,
  jsonRpcErrors,
} from "./server.ts";
import type { JsonRpcSocket } from "./server.ts";
import type { JsonRpcNotification, JsonRpcResponse } from "./wire.ts";

function post(handler: (req: Request) => Promise<Response>, body: unknown): Promise<Response> {
  return handler(
    new Request("http://localhost/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

// ============================================================================
// HTTP POST transport
// ============================================================================

describe("createJsonRpcHttpHandler: single requests", () => {
  const tree = api_({
    add: op((input: { a: number; b: number }) => input.a + input.b),
  });

  it("dispatches a call and returns a success Response", async () => {
    const handler = createJsonRpcHttpHandler(tree);
    const res = await post(handler, {
      jsonrpc: "2.0",
      method: "add",
      params: { a: 2, b: 3 },
      id: 1,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcResponse;
    expect(body).toEqual({ jsonrpc: "2.0", result: 5, id: 1 });
  });

  it("unknown method -> METHOD_NOT_FOUND", async () => {
    const handler = createJsonRpcHttpHandler(tree);
    const res = await post(handler, { jsonrpc: "2.0", method: "nope", params: {}, id: 1 });
    const body = (await res.json()) as JsonRpcResponse;
    expect("error" in body && body.error.code).toBe(-32601);
  });

  it("malformed request shape -> INVALID_REQUEST", async () => {
    const handler = createJsonRpcHttpHandler(tree);
    const res = await post(handler, { foo: "bar" });
    const body = (await res.json()) as JsonRpcResponse;
    expect("error" in body && body.error.code).toBe(-32600);
  });

  it("malformed JSON -> PARSE_ERROR", async () => {
    const handler = createJsonRpcHttpHandler(tree);
    const res = await handler(
      new Request("http://localhost/rpc", { method: "POST", body: "{not json" }),
    );
    const body = (await res.json()) as JsonRpcResponse;
    expect("error" in body && body.error.code).toBe(-32700);
  });

  it("a Notification (no id) gets no response body — 204", async () => {
    const handler = createJsonRpcHttpHandler(tree);
    const res = await post(handler, { jsonrpc: "2.0", method: "add", params: { a: 1, b: 1 } });
    expect(res.status).toBe(204);
  });

  it("a thrown handler error collapses to INTERNAL_ERROR, never leaking the message", async () => {
    const boomTree = api_({
      boom: op((_: unknown) => {
        throw new Error("some internal detail");
      }),
    });
    const handler = createJsonRpcHttpHandler(boomTree);
    const res = await post(handler, { jsonrpc: "2.0", method: "boom", params: {}, id: 1 });
    const body = (await res.json()) as JsonRpcResponse;
    expect("error" in body && body.error.code).toBe(-32603);
    expect("error" in body && body.error.message).not.toContain("some internal detail");
  });
});

describe("createJsonRpcHttpHandler: id correlation + malformed shapes", () => {
  const tree = api_({
    add: op((input: { a: number; b: number }) => input.a + input.b),
  });

  it("a malformed-shape body that still carries an id echoes that id back", async () => {
    const handler = createJsonRpcHttpHandler(tree);
    const res = await post(handler, { jsonrpc: "2.0", method: 123, id: "req-9" });
    const body = (await res.json()) as JsonRpcResponse;
    expect("error" in body && body.error.code).toBe(-32600);
    expect(body.id).toBe("req-9");
  });

  it("a malformed-shape body with no id -> null id", async () => {
    const handler = createJsonRpcHttpHandler(tree);
    const res = await post(handler, { foo: "bar" });
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.id).toBe(null);
  });

  it("a top-level non-object, non-array body -> INVALID_REQUEST", async () => {
    const handler = createJsonRpcHttpHandler(tree);
    const res = await post(handler, "just a string");
    const body = (await res.json()) as JsonRpcResponse;
    expect("error" in body && body.error.code).toBe(-32600);
  });

  it("positional (array) params degrade to an empty object rather than positional mapping", async () => {
    const handler = createJsonRpcHttpHandler(tree);
    const res = await post(handler, { jsonrpc: "2.0", method: "add", params: [1, 2], id: 1 });
    const body = (await res.json()) as JsonRpcResponse;
    // a, b both resolve to undefined -> NaN, which serializes over JSON as
    // null (not a thrown error, and not positionally mapped to 3).
    expect("result" in body && body.result).toBe(null);
  });

  it("an unknown method as a Notification (no id) yields no error response, silently", async () => {
    const handler = createJsonRpcHttpHandler(tree);
    const res = await post(handler, { jsonrpc: "2.0", method: "nope" });
    expect(res.status).toBe(204);
  });

  it("a Notification whose handler returns err(...) is dropped silently, not surfaced as an error", async () => {
    const boomTree = api_({
      withdraw: op((_: unknown) => err({ kind: "insufficientFunds" })),
    });
    const handler = createJsonRpcHttpHandler(boomTree);
    const res = await post(handler, { jsonrpc: "2.0", method: "withdraw", params: {} });
    expect(res.status).toBe(204);
  });
});

describe("createJsonRpcHttpHandler: batch requests (§6)", () => {
  const tree = api_({
    add: op((input: { a: number; b: number }) => input.a + input.b),
    notifyOnly: op((_: unknown) => "ignored"),
  });

  it("dispatches each element, collecting non-Notification responses", async () => {
    const handler = createJsonRpcHttpHandler(tree);
    const res = await post(handler, [
      { jsonrpc: "2.0", method: "add", params: { a: 1, b: 1 }, id: 1 },
      { jsonrpc: "2.0", method: "add", params: { a: 2, b: 2 }, id: 2 },
    ]);
    const body = (await res.json()) as JsonRpcResponse[];
    expect(body).toHaveLength(2);
    expect(body.map((r) => "result" in r && r.result)).toEqual([2, 4]);
  });

  it("a batch made entirely of Notifications sends no body — 204", async () => {
    const handler = createJsonRpcHttpHandler(tree);
    const res = await post(handler, [
      { jsonrpc: "2.0", method: "notifyOnly", params: {} },
      { jsonrpc: "2.0", method: "notifyOnly", params: {} },
    ]);
    expect(res.status).toBe(204);
  });

  it("an empty batch array is itself an Invalid Request", async () => {
    const handler = createJsonRpcHttpHandler(tree);
    const res = await post(handler, []);
    const body = (await res.json()) as JsonRpcResponse;
    expect("error" in body && body.error.code).toBe(-32600);
  });

  it("a mixed batch — success, error, and Notification elements — each reported independently", async () => {
    const handler = createJsonRpcHttpHandler(tree);
    const res = await post(handler, [
      { jsonrpc: "2.0", method: "add", params: { a: 1, b: 1 }, id: 1 },
      { jsonrpc: "2.0", method: "nope", params: {}, id: 2 },
      { jsonrpc: "2.0", method: "notifyOnly", params: {} },
      42,
    ]);
    const body = (await res.json()) as JsonRpcResponse[];
    // notifyOnly (Notification) produces no response; the other 3 elements each do.
    expect(body).toHaveLength(3);
    const byId = new Map(body.map((r) => [r.id, r]));
    const r1 = byId.get(1)!;
    const r2 = byId.get(2)!;
    const rNull = byId.get(null)!;
    expect("result" in r1 && r1.result).toBe(2);
    expect("error" in r2 && r2.error.code).toBe(-32601);
    expect("error" in rNull && rNull.error.code).toBe(-32600);
  });
});

describe("createJsonRpcHttpHandler: Result unwrapping + error encoding", () => {
  const tree = api_({
    withdraw: op((input: { amount: number }) =>
      input.amount > 100
        ? err({ kind: "insufficientFunds", message: "not enough" })
        : ok(input.amount),
    ),
  });

  it("ok(...) unwraps to the plain result", async () => {
    const handler = createJsonRpcHttpHandler(tree);
    const res = await post(handler, {
      jsonrpc: "2.0",
      method: "withdraw",
      params: { amount: 10 },
      id: 1,
    });
    const body = (await res.json()) as JsonRpcResponse;
    expect("result" in body && body.result).toBe(10);
  });

  it("err(...) with no encoder -> INVALID_PARAMS, raw error as data", async () => {
    const handler = createJsonRpcHttpHandler(tree);
    const res = await post(handler, {
      jsonrpc: "2.0",
      method: "withdraw",
      params: { amount: 200 },
      id: 1,
    });
    const body = (await res.json()) as JsonRpcResponse;
    expect("error" in body && body.error.code).toBe(-32602);
    expect("error" in body && (body.error.data as { kind: string }).kind).toBe("insufficientFunds");
  });

  it("err(...) with a matching jsonRpcErrors encoder -> custom code", async () => {
    const handler = createJsonRpcHttpHandler(tree, {
      errorEncoder: jsonRpcErrors({ insufficientFunds: -32001 }),
    });
    const res = await post(handler, {
      jsonrpc: "2.0",
      method: "withdraw",
      params: { amount: 200 },
      id: 1,
    });
    const body = (await res.json()) as JsonRpcResponse;
    expect("error" in body && body.error.code).toBe(-32001);
    expect("error" in body && body.error.message).toBe("not enough");
  });

  it("jsonRpcErrors composed mapping — a second configured kind maps to its own code, first-match-wins by key order", async () => {
    const multiTree = api_({
      act: op((input: { mode: string }) => {
        if (input.mode === "a") return err({ kind: "kindA", message: "A failed" });
        if (input.mode === "b") return err({ kind: "kindB" });
        return ok("fine");
      }),
    });
    const handler = createJsonRpcHttpHandler(multiTree, {
      errorEncoder: jsonRpcErrors({ kindA: -32001, kindB: -32002 }),
    });

    const resA = await post(handler, {
      jsonrpc: "2.0",
      method: "act",
      params: { mode: "a" },
      id: 1,
    });
    const bodyA = (await resA.json()) as JsonRpcResponse;
    expect("error" in bodyA && bodyA.error.code).toBe(-32001);

    const resB = await post(handler, {
      jsonrpc: "2.0",
      method: "act",
      params: { mode: "b" },
      id: 2,
    });
    const bodyB = (await resB.json()) as JsonRpcResponse;
    // kindB's error value has no `message` field -> falls back to JSON.stringify(error)
    expect("error" in bodyB && bodyB.error.code).toBe(-32002);
    expect("error" in bodyB && bodyB.error.message).toBe(JSON.stringify({ kind: "kindB" }));
    expect("error" in bodyB && bodyB.error.data).toEqual({ kind: "kindB" });
  });

  it("jsonRpcErrors with no matching kind -> undefined -> falls back to INVALID_PARAMS", async () => {
    const handler = createJsonRpcHttpHandler(tree, {
      errorEncoder: jsonRpcErrors({ someOtherKind: -32005 }),
    });
    const res = await post(handler, {
      jsonrpc: "2.0",
      method: "withdraw",
      params: { amount: 200 },
      id: 1,
    });
    const body = (await res.json()) as JsonRpcResponse;
    expect("error" in body && body.error.code).toBe(-32602);
  });
});

describe("createJsonRpcHttpHandler: detection option", () => {
  it("detection.result: false — a Result-shaped return value passes through untouched as the result", async () => {
    const tree = api_({
      withdraw: op((input: { amount: number }) =>
        input.amount > 100 ? err({ kind: "insufficientFunds" }) : ok(input.amount),
      ),
    });
    const handler = createJsonRpcHttpHandler(tree, { detection: { result: false } });
    const res = await post(handler, {
      jsonrpc: "2.0",
      method: "withdraw",
      params: { amount: 10 },
      id: 1,
    });
    const body = (await res.json()) as JsonRpcResponse;
    expect("result" in body && body.result).toEqual({ kind: "ok", value: 10 });
  });

  it("detection.streaming: false — an AsyncIterable return value is NOT drained, treated as a plain (empty-looking) result", async () => {
    const tree = api_({
      watch: op(async function* (_: unknown) {
        yield "a";
      }),
    });
    const handler = createJsonRpcHttpHandler(tree, { detection: { streaming: false } });
    const res = await post(handler, { jsonrpc: "2.0", method: "watch", params: {}, id: 1 });
    const body = (await res.json()) as JsonRpcResponse;
    // Not collected into ["a"] — the raw async generator object serializes to {}.
    expect("result" in body && body.result).not.toEqual(["a"]);
  });
});

describe("createJsonRpcHttpHandler: streaming degrades to a collected array", () => {
  it("an AsyncIterable handler's yields collect into the result array", async () => {
    const tree = api_({
      watch: op(async function* (_: unknown) {
        yield "a";
        yield "b";
      }),
    });
    const handler = createJsonRpcHttpHandler(tree);
    const res = await post(handler, { jsonrpc: "2.0", method: "watch", params: {}, id: 1 });
    const body = (await res.json()) as JsonRpcResponse;
    expect("result" in body && body.result).toEqual(["a", "b"]);
  });
});

// ============================================================================
// WebSocket transport
// ============================================================================

class FakeSocket implements JsonRpcSocket {
  sent: unknown[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
}

describe("createJsonRpcWebSocketHandlers: single calls", () => {
  it("sends a success Response back over the socket", async () => {
    const tree = api_({ add: op((input: { a: number; b: number }) => input.a + input.b) });
    const { message } = createJsonRpcWebSocketHandlers(tree);
    const ws = new FakeSocket();
    await message(
      ws,
      JSON.stringify({ jsonrpc: "2.0", method: "add", params: { a: 2, b: 2 }, id: 1 }),
    );
    expect(ws.sent).toEqual([{ jsonrpc: "2.0", result: 4, id: 1 }]);
  });

  it("accepts a binary (Uint8Array) message, decoding it as UTF-8 JSON", async () => {
    const tree = api_({ add: op((input: { a: number; b: number }) => input.a + input.b) });
    const { message } = createJsonRpcWebSocketHandlers(tree);
    const ws = new FakeSocket();
    const bytes = new TextEncoder().encode(
      JSON.stringify({ jsonrpc: "2.0", method: "add", params: { a: 5, b: 5 }, id: 1 }),
    );
    await message(ws, bytes);
    expect(ws.sent).toEqual([{ jsonrpc: "2.0", result: 10, id: 1 }]);
  });
});

describe("createJsonRpcWebSocketHandlers: streaming via Notifications", () => {
  it("each yield becomes a Notification, followed by a Response carrying the return value", async () => {
    const tree = api_({
      watch: op(async function* (_: unknown) {
        yield "a";
        yield "b";
        return "done";
      }),
    });
    const { message } = createJsonRpcWebSocketHandlers(tree);
    const ws = new FakeSocket();
    await message(ws, JSON.stringify({ jsonrpc: "2.0", method: "watch", params: {}, id: 7 }));

    const notifications = ws.sent.filter((m): m is JsonRpcNotification => !("id" in (m as object)));
    const responses = ws.sent.filter((m): m is JsonRpcResponse => "id" in (m as object));

    expect(notifications).toHaveLength(2);
    expect(notifications.map((n) => (n.params as { value: unknown }).value)).toEqual(["a", "b"]);
    expect(
      notifications.every((n) => (n.params as { subscription: unknown }).subscription === 7),
    ).toBe(true);

    expect(responses).toHaveLength(1);
    expect("result" in responses[0]! && responses[0]!.result).toBe("done");
  });

  it("progress yields become type: 'progress' Notifications", async () => {
    const tree = api_({
      watch: op(async function* (_: unknown) {
        yield { kind: "progress" as const, progress: 1, total: 2 };
        yield { kind: "chunk" as const, data: "x" };
      }),
    });
    const { message } = createJsonRpcWebSocketHandlers(tree);
    const ws = new FakeSocket();
    await message(ws, JSON.stringify({ jsonrpc: "2.0", method: "watch", params: {}, id: 1 }));

    const notifications = ws.sent.filter((m): m is JsonRpcNotification => !("id" in (m as object)));
    const types = notifications.map((n) => (n.params as { type: string }).type);
    expect(types).toEqual(["progress", "chunk"]);
  });

  it("malformed JSON -> a PARSE_ERROR Response sent back", async () => {
    const tree = api_({ ping: op((_: unknown) => "pong") });
    const { message } = createJsonRpcWebSocketHandlers(tree);
    const ws = new FakeSocket();
    await message(ws, "{not json");
    expect(ws.sent).toEqual([
      { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null },
    ]);
  });

  it("a Notification call sends nothing back", async () => {
    const tree = api_({ ping: op((_: unknown) => "pong") });
    const { message } = createJsonRpcWebSocketHandlers(tree);
    const ws = new FakeSocket();
    await message(ws, JSON.stringify({ jsonrpc: "2.0", method: "ping", params: {} }));
    expect(ws.sent).toEqual([]);
  });

  it("a batch over the WebSocket transport sends one array message back", async () => {
    const tree = api_({ add: op((input: { a: number; b: number }) => input.a + input.b) });
    const { message } = createJsonRpcWebSocketHandlers(tree);
    const ws = new FakeSocket();
    await message(
      ws,
      JSON.stringify([
        { jsonrpc: "2.0", method: "add", params: { a: 1, b: 1 }, id: 1 },
        { jsonrpc: "2.0", method: "add", params: { a: 2, b: 2 }, id: 2 },
      ]),
    );
    expect(ws.sent).toEqual([
      [
        { jsonrpc: "2.0", result: 2, id: 1 },
        { jsonrpc: "2.0", result: 4, id: 2 },
      ],
    ]);
  });

  it("unknown method over WebSocket -> a METHOD_NOT_FOUND Response sent back", async () => {
    const tree = api_({ ping: op((_: unknown) => "pong") });
    const { message } = createJsonRpcWebSocketHandlers(tree);
    const ws = new FakeSocket();
    await message(ws, JSON.stringify({ jsonrpc: "2.0", method: "nope", params: {}, id: 1 }));
    expect(ws.sent).toEqual([
      { jsonrpc: "2.0", error: { code: -32601, message: "Method not found: nope" }, id: 1 },
    ]);
  });
});
