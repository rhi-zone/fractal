// packages/http/src/middleware.test.ts — the composable middleware stdlib.
// These prove each export is an ORDINARY HttpMiddleware composed via .use/.mount,
// indistinguishable from user middleware.
import { describe, expect, it } from "bun:test"
import { httpRouter, json, toHandler, type NoVars } from "./index.ts"
import { bearerAuth, cors, etag, logger } from "./middleware.ts"

const BASE = "http://localhost"

describe("cors — plain Middleware via .use", () => {
  // fractal middleware is PER-ROUTE (it wraps registered handlers, not the
  // whole request). To make OPTIONS preflight reachable by the cors middleware,
  // an OPTIONS route is registered — same `use` chain, no special mechanism.
  const h = toHandler(
    httpRouter<NoVars>()
      .use(cors({ origin: "*", credentials: true, maxAge: 600 }))
      .get("/x", async () => json({ ok: true }))
      .options("/x", async () => new Response(null)),
  )

  it("adds Access-Control-Allow-Origin to responses", async () => {
    const res = await h(new Request(`${BASE}/x`))
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true")
    expect(res.headers.get("Access-Control-Max-Age")).toBe("600")
    expect(await res.json()).toEqual({ ok: true })
  })

  it("short-circuits OPTIONS preflight with 204 (cors mw owns the response)", async () => {
    const res = await h(new Request(`${BASE}/x`, { method: "OPTIONS" }))
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET")
  })
})

describe("bearerAuth — sets a typed context var (no cast)", () => {
  interface Principal { sub: string }
  const h = toHandler(
    httpRouter<NoVars>()
      .use(bearerAuth<Principal>({ verify: (t) => (t === "good" ? { sub: "alice" } : null) }))
      // ctx.vars.auth is typed Principal here — read with NO cast.
      .get("/me", async (ctx) => json({ sub: ctx.vars.auth.sub })),
  )

  it("401 without a Bearer token", async () => {
    const res = await h(new Request(`${BASE}/me`))
    expect(res.status).toBe(401)
  })
  it("401 on a bad token", async () => {
    const res = await h(new Request(`${BASE}/me`, { headers: { authorization: "Bearer nope" } }))
    expect(res.status).toBe(401)
  })
  it("200 + typed principal on a good token", async () => {
    const res = await h(new Request(`${BASE}/me`, { headers: { authorization: "Bearer good" } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sub: "alice" })
  })
})

describe("logger — plain Middleware, observes status", () => {
  it("logs method/path/status via the sink", async () => {
    const lines: string[] = []
    const h = toHandler(
      httpRouter<NoVars>().use(logger((l) => lines.push(l))).get("/p", async () => json({})),
    )
    await h(new Request(`${BASE}/p`))
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain("GET /p 200")
  })
})

describe("etag — weak ETag + 304 on If-None-Match", () => {
  const h = toHandler(
    httpRouter<NoVars>().use(etag()).get("/r", async () => json({ v: 1 })),
  )

  it("adds a weak ETag", async () => {
    const res = await h(new Request(`${BASE}/r`))
    const tag = res.headers.get("ETag")
    expect(tag).toMatch(/^W\/"/)
  })

  it("returns 304 when If-None-Match matches", async () => {
    const first = await h(new Request(`${BASE}/r`))
    const tag = first.headers.get("ETag") ?? ""
    const res = await h(new Request(`${BASE}/r`, { headers: { "if-none-match": tag } }))
    expect(res.status).toBe(304)
    expect(await res.text()).toBe("")
  })
})
