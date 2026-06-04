// examples/todo-api/src/vs.test.ts
// In-process verification of the three vs-Hono/Elysia endpoints.

import { describe, it, expect } from "bun:test"
import { handle } from "./vs.ts"

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

const AUTH = { "x-user": "caller@x.io" }

describe("(a) GET /users/:id behind auth", () => {
  it("401 without auth", async () => {
    const res = await hit("GET", "/users/1")
    expect(res.status).toBe(401)
  })
  it("200 + user with auth", async () => {
    const res = await hit("GET", "/users/1", { headers: AUTH })
    expect(res.status).toBe(200)
    expect((await res.json()).name).toBe("Ada")
  })
  it("404 for unknown id", async () => {
    const res = await hit("GET", "/users/999", { headers: AUTH })
    expect(res.status).toBe(404)
  })
})

describe("(b) POST /users validated body", () => {
  it("200 on valid (NOTE: withValidation cannot emit 201 today)", async () => {
    const res = await hit("POST", "/users", {
      headers: AUTH,
      body: { name: "Grace", email: "grace@x.io" },
    })
    expect(res.status).toBe(200) // <- the 201 gap, recorded honestly
    expect((await res.json()).name).toBe("Grace")
  })
  it("400 on invalid body", async () => {
    const res = await hit("POST", "/users", { headers: AUTH, body: { name: "x" } })
    expect(res.status).toBe(400)
  })
})

describe("(c) POST /users/:id/deactivate → Outcome policy", () => {
  it("200 on first deactivate", async () => {
    const c = await (await hit("POST", "/users", {
      headers: AUTH,
      body: { name: "T", email: "t@x.io" },
    })).json()
    const res = await hit("POST", `/users/${c.id}/deactivate`, { headers: AUTH })
    expect(res.status).toBe(200)
    expect((await res.json()).active).toBe(false)
  })
  it("409 ALREADY_INACTIVE on second", async () => {
    const c = await (await hit("POST", "/users", {
      headers: AUTH,
      body: { name: "U", email: "u@x.io" },
    })).json()
    await hit("POST", `/users/${c.id}/deactivate`, { headers: AUTH })
    const res = await hit("POST", `/users/${c.id}/deactivate`, { headers: AUTH })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("ALREADY_INACTIVE")
  })
  it("404 USER_NOT_FOUND for unknown id", async () => {
    const res = await hit("POST", "/users/nope/deactivate", { headers: AUTH })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("USER_NOT_FOUND")
  })
})

describe("405 probe: method mismatch on a matched path", () => {
  it("CURRENT fractal behavior: falls through to 404 (not 405)", async () => {
    const res = await hit("DELETE", "/users/1", { headers: AUTH })
    expect(res.status).toBe(404) // documents the criterion-2 gap
  })
})
