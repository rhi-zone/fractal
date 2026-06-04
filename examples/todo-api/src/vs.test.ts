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

// bearerAuth: a Bearer token whose value the demo verify() treats as the email.
const AUTH = { authorization: "Bearer caller@x.io" }

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

describe("(b) POST /users validated body → 201 (the gap, now closed)", () => {
  it("201 on valid, via created() through withValidation", async () => {
    const res = await hit("POST", "/users", {
      headers: AUTH,
      body: { name: "Grace", email: "grace@x.io" },
    })
    expect(res.status).toBe(201) // <- status-aware validation
    expect((await res.json()).name).toBe("Grace")
  })
  it("400 on invalid body (validation sugar preserved)", async () => {
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

describe("405 + Allow on method mismatch (criterion-2 win)", () => {
  it("DELETE on a GET path → 405 (not 404), with an Allow header", async () => {
    const res = await hit("DELETE", "/users/1", { headers: AUTH })
    expect(res.status).toBe(405)
    expect(res.headers.get("Allow")).toContain("GET")
  })
  it("genuinely unmatched path is still 404", async () => {
    const res = await hit("DELETE", "/absent", { headers: AUTH })
    expect(res.status).toBe(404)
  })
})

describe("auto-HEAD synthesized from GET", () => {
  it("HEAD /users/1 returns 200 + headers, empty body", async () => {
    const res = await hit("HEAD", "/users/1", { headers: AUTH })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/json")
    expect(await res.text()).toBe("")
  })
})

describe("CORS stdlib middleware (plain value via .use)", () => {
  it("adds Access-Control-Allow-Origin", async () => {
    const res = await hit("GET", "/users/1", { headers: AUTH })
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
  })
})
