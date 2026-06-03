// packages/http/src/index.test.ts — @rhi-zone/fractal-http
import { describe, expect, it } from "bun:test"
import {
  binary,
  httpRouter,
  json,
  sse,
  toHandler,
  withValidation,
  type HttpMiddleware,
  type NoVars,
  type StandardSchema,
  type WithVars,
} from "./index.ts"
import type { HttpCtx } from "./index.ts"

const BASE = "http://localhost"

// tiny object-schema fixture (no valibot dep)
function schema<const F extends Record<string, "string" | "number">>(
  fields: F,
): StandardSchema<unknown, { [K in keyof F]: F[K] extends "string" ? string : number }> {
  type Out = { [K in keyof F]: F[K] extends "string" ? string : number }
  return {
    "~standard": {
      version: 1,
      validate(value: unknown) {
        if (typeof value !== "object" || value === null) {
          return { issues: [{ message: "expected object" }] }
        }
        const obj = value as Record<string, unknown>
        const out: Record<string, unknown> = {}
        for (const [k, t] of Object.entries(fields)) {
          if (typeof obj[k] !== t) return { issues: [{ message: `field ${k} must be ${t}` }] }
          out[k] = obj[k]
        }
        return { value: out as Out }
      },
    },
  }
}

interface AuthVars extends Record<string, unknown> {
  user: { id: string; email: string }
}

const auth: HttpMiddleware<NoVars, AuthVars> = async (ctx, next) => {
  const u = ctx.headers.get("x-user")
  if (u === null) return json({ error: "Forbidden" }, 403)
  const enriched: WithVars<HttpCtx, NoVars & AuthVars> = {
    ...ctx,
    vars: { user: { id: "u-1", email: u } },
  }
  return next(enriched)
}

// admin sub-router — handlers read ctx.vars.user with NO cast
const admin = httpRouter<NoVars & AuthVars>()
  .route("GET", "/me", async (ctx) => json({ user: ctx.vars.user }))

const createUser = async (args: { name: string; email: string }) => ({ id: "u-1", name: args.name })

const app = httpRouter<NoVars>()
  .route("GET", "/search", async (ctx) => json({ q: ctx.query.get("q"), raw: true }))
  .routeNode("POST", "/users", withValidation(createUser, schema({ name: "string", email: "string" })))
  .route("GET", "/events", async () =>
    sse((emit) => {
      emit("connected", { ok: true })
      emit("done", { n: 2 })
    }),
  )
  .route("GET", "/blob", async () => binary(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png"))
  .mount("/admin", auth, admin)

const handle = toHandler(app)

async function hit(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers }
  const init: RequestInit = { method, headers }
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json"
    init.body = JSON.stringify(opts.body)
  }
  const res = await handle(new Request(`${BASE}${path}`, init))
  return res
}

describe("auth middleware — typed context, 200 / 403", () => {
  it("200 with header; handler reads ctx.vars.user", async () => {
    const res = await hit("GET", "/admin/me", { headers: { "x-user": "alice@example.com" } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ user: { id: "u-1", email: "alice@example.com" } })
  })
  it("403 without header", async () => {
    const res = await hit("GET", "/admin/me")
    expect(res.status).toBe(403)
  })
})

describe("withValidation — 200 / 400", () => {
  it("200 on valid body", async () => {
    const res = await hit("POST", "/users", { body: { name: "Alice", email: "a@b.c" } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "u-1", name: "Alice" })
  })
  it("400 on invalid body", async () => {
    const res = await hit("POST", "/users", { body: { name: "Alice" } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Validation failed")
  })
})

describe("SSE — text/event-stream chunks", () => {
  it("streams events", async () => {
    const res = await hit("GET", "/events")
    expect(res.headers.get("content-type")).toBe("text/event-stream")
    const body = await res.text()
    expect(body).toContain("event: connected")
    expect(body).toContain("event: done")
  })
})

describe("binary — ordinary Response body", () => {
  it("returns bytes", async () => {
    const res = await hit("GET", "/blob")
    expect(res.headers.get("content-type")).toBe("image/png")
    const buf = new Uint8Array(await res.arrayBuffer())
    expect(buf.length).toBe(4)
    expect(buf[0]).toBe(0x89)
  })
})

describe("raw query", () => {
  it("reads ctx.query directly", async () => {
    const res = await hit("GET", "/search?q=fractal&limit=10")
    expect(await res.json()).toEqual({ q: "fractal", raw: true })
  })
})

describe("404", () => {
  it("unmatched route", async () => {
    const res = await hit("GET", "/nope")
    expect(res.status).toBe(404)
  })
})
