// examples/todo-api/src/app.test.ts
//
// In-process tests: toHandler(app)(new Request(...)) — no socket needed.
// Covers auth 200/403, validation 200/400, SSE chunks, raw query.

import { describe, it, expect } from "bun:test"
import { handle } from "./app.ts"

const BASE = "http://localhost"

async function hit(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers }
  const init: RequestInit = { method, headers }
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json"
    init.body = JSON.stringify(opts.body)
  }
  return handle(new Request(`${BASE}${path}`, init))
}

describe("auth middleware (typed context)", () => {
  it("200 with x-user; handler reads ctx.vars.user (no cast)", async () => {
    const res = await hit("GET", "/admin/me", { headers: { "x-user": "alice@example.com" } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ user: { id: "u-1", email: "alice@example.com" } })
  })

  it("403 without x-user", async () => {
    const res = await hit("GET", "/admin/me")
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("Forbidden")
  })

  it("admin/stats reads typed user email", async () => {
    const res = await hit("GET", "/admin/stats", { headers: { "x-user": "bob@x.io" } })
    expect(res.status).toBe(200)
    expect((await res.json()).requestedBy).toBe("bob@x.io")
  })
})

describe("withValidation (library fn → node)", () => {
  it("200 on valid create", async () => {
    const res = await hit("POST", "/todos", { body: { title: "buy milk" } })
    expect(res.status).toBe(200)
    const todo = await res.json()
    expect(todo.title).toBe("buy milk")
    expect(todo.done).toBe(false)
  })

  it("400 on invalid create (missing title)", async () => {
    const res = await hit("POST", "/todos", { body: {} })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Validation failed")
  })

  it("400 on wrong-typed body", async () => {
    const res = await hit("POST", "/todos/done", { body: { id: "1", done: "yes" } })
    expect(res.status).toBe(400)
  })

  it("toggle done after create", async () => {
    const created = await (await hit("POST", "/todos", { body: { title: "task" } })).json()
    const res = await hit("POST", "/todos/done", { body: { id: created.id, done: true } })
    expect(res.status).toBe(200)
    expect((await res.json()).done).toBe(true)
  })
})

describe("SSE endpoint", () => {
  it("returns text/event-stream with chunks", async () => {
    const res = await hit("GET", "/events")
    expect(res.headers.get("content-type")).toBe("text/event-stream")
    const body = await res.text()
    expect(body).toContain("event: connected")
    expect(body).toContain("event: status")
    expect(body).toContain("event: done")
  })
})

describe("raw query", () => {
  it("reads ctx.query directly", async () => {
    const res = await hit("GET", "/search?q=fractal&limit=10")
    expect(await res.json()).toEqual({ q: "fractal", limit: "10", raw: true })
  })
})

describe("binary endpoint", () => {
  it("returns image bytes", async () => {
    const res = await hit("GET", "/favicon")
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(4)
  })
})

describe("Result→Response rendering (user-side error policy)", () => {
  it("plain value → 200 application/json (count)", async () => {
    const res = await hit("GET", "/count")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/json")
    expect(typeof (await res.json()).total).toBe("number")
  })

  it("Outcome ok → 200 with the value rendered as JSON", async () => {
    const created = await (await hit("POST", "/todos", { body: { title: "ship" } })).json()
    const res = await hit("POST", `/todos/${created.id}/mark-done`)
    expect(res.status).toBe(200)
    expect((await res.json()).done).toBe(true)
  })

  it("Outcome error TODO_NOT_FOUND → 404 (user policy)", async () => {
    const res = await hit("POST", "/todos/does-not-exist/mark-done")
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("TODO_NOT_FOUND")
  })

  it("Outcome error ALREADY_DONE → 409 (user policy)", async () => {
    const created = await (await hit("POST", "/todos", { body: { title: "twice" } })).json()
    await hit("POST", `/todos/${created.id}/mark-done`)
    const res = await hit("POST", `/todos/${created.id}/mark-done`)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("ALREADY_DONE")
  })
})

describe("404", () => {
  it("unmatched route", async () => {
    const res = await hit("GET", "/missing")
    expect(res.status).toBe(404)
  })
})
