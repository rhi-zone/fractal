// examples/todo-api/src/app.test.ts
//
// In-process tests: handle(new Request(...)) — no socket needed. Covers the
// handler-model tree: list/create/validation, typed-param routes, 404/405,
// SSE, binary.

import { describe, it, expect } from "bun:test";
import { handle } from "./app.ts";

const BASE = "http://localhost";

async function hit(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return handle(new Request(`${BASE}${path}`, init));
}

describe("validated create (POST /todos)", () => {
  it("201 on valid create", async () => {
    const res = await hit("POST", "/todos", { body: { title: "buy milk" } });
    expect(res.status).toBe(201);
    const todo = await res.json();
    expect(todo.title).toBe("buy milk");
    expect(todo.done).toBe(false);
  });

  it("400 on invalid create (missing title)", async () => {
    const res = await hit("POST", "/todos", { body: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("VALIDATION");
  });
});

describe("list + typed param routes", () => {
  it("GET /todos lists created todos", async () => {
    await hit("POST", "/todos", { body: { title: "task" } });
    const res = await hit("GET", "/todos");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("GET /todos/{id} returns the item", async () => {
    const created = await (await hit("POST", "/todos", { body: { title: "find me" } })).json();
    const res = await hit("GET", `/todos/${created.id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe("find me");
  });

  it("GET /todos/{unknown} -> 404", async () => {
    const res = await hit("GET", "/todos/does-not-exist");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("TODO_NOT_FOUND");
  });

  it("POST /todos/{id}/done sets the flag (typed param + body)", async () => {
    const created = await (await hit("POST", "/todos", { body: { title: "toggle" } })).json();
    const res = await hit("POST", `/todos/${created.id}/done`, { body: { done: true } });
    expect(res.status).toBe(200);
    expect((await res.json()).done).toBe(true);
  });

  it("POST /todos/{id}/done with bad body -> 400", async () => {
    const created = await (await hit("POST", "/todos", { body: { title: "x" } })).json();
    const res = await hit("POST", `/todos/${created.id}/done`, { body: { done: "yes" } });
    expect(res.status).toBe(400);
  });
});

describe("http correctness", () => {
  it("405 on a known path with the wrong verb", async () => {
    const res = await hit("DELETE", "/todos");
    expect(res.status).toBe(405);
    const allow = res.headers.get("Allow") ?? "";
    expect(allow.includes("GET") && allow.includes("POST")).toBe(true);
  });

  it("404 on an unmatched route", async () => {
    expect((await hit("GET", "/missing")).status).toBe(404);
  });

  it("GET /health -> ok", async () => {
    const res = await hit("GET", "/health");
    expect(await res.text()).toBe("ok");
  });
});

describe("authenticated route (GET /me via withAuth)", () => {
  it("401 without an Authorization header (withAuth short-circuits)", async () => {
    const res = await hit("GET", "/me");
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("UNAUTHORIZED");
  });

  it("200 + the injected user when authenticated (ctx.user read server-side)", async () => {
    const res = await hit("GET", "/me", { headers: { authorization: "Bearer ada" } });
    expect(res.status).toBe(200);
    const user = await res.json();
    expect(user).toEqual({ id: "ada", name: "ada" });
  });

  it("auth runs BEFORE routing: an unauthenticated wrong-verb request 401s", async () => {
    // `withAuth` wraps the whole /me subtree, so `authenticate` runs ahead of the
    // methods table — an unauthenticated DELETE short-circuits to 401 (not 405).
    const res = await hit("DELETE", "/me");
    expect(res.status).toBe(401);
  });
});

describe("observing middleware (cors wrapper on the root)", () => {
  it("adds CORS headers to a normal response", async () => {
    const res = await hit("GET", "/health");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("answers OPTIONS preflight with 204", async () => {
    const res = await hit("OPTIONS", "/todos");
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });
});

describe("SSE + binary endpoints", () => {
  it("GET /events -> text/event-stream with chunks", async () => {
    const res = await hit("GET", "/events");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const body = await res.text();
    expect(body).toContain("event: connected");
    expect(body).toContain("event: done");
  });

  it("GET /favicon -> image bytes", async () => {
    const res = await hit("GET", "/favicon");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(4);
  });
});
