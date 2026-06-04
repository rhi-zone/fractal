// packages/http/src/index.test.ts — @rhi-zone/fractal-http
import { describe, expect, it } from "bun:test"
import {
  binary,
  created,
  err,
  httpRouter,
  json,
  ok,
  render,
  respond,
  sse,
  text,
  toHandler,
  withValidation,
  type ErrorPolicy,
  type HttpMiddleware,
  type NoVars,
  type Outcome,
  type PathParams,
  type Renderer,
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

describe("render — the general Result→Response mechanism", () => {
  // A throwaway domain error + user-side policy, defined HERE (not framework).
  type E = { code: "NOPE" } | { code: "CONFLICT" }
  const policy: ErrorPolicy<E> = (e) =>
    e.code === "NOPE" ? { status: 404 } : { status: 409, body: { conflict: true } }

  it("Response passes through unchanged", () => {
    const r = text("hi", 201)
    expect(render(r, policy)).toBe(r)
  })

  it("plain value → 200 JSON via default renderer", async () => {
    const res = render({ a: 1 }, policy)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/json")
    expect(await res.json()).toEqual({ a: 1 })
  })

  it("Outcome ok → 200 with value as JSON", async () => {
    const res = render(ok({ x: 2 }), policy)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ x: 2 })
  })

  it("Outcome error → status from user policy; body defaults to the error", async () => {
    const res = render(err<E>({ code: "NOPE" }), policy)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ code: "NOPE" })
  })

  it("Outcome error → policy may supply an explicit body", async () => {
    const res = render(err<E>({ code: "CONFLICT" }), policy)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ conflict: true })
  })

  it("renderer is swappable (non-JSON default)", async () => {
    const textRenderer: Renderer = (v) => text(String(v), 200)
    const res = render("plain", policy, textRenderer)
    expect(res.headers.get("content-type")).toBe("text/plain")
    expect(await res.text()).toBe("plain")
  })
})

describe("respond — wraps a handler; policy Err links to the Outcome", () => {
  type E = { code: "MISSING"; id: string }
  const policy: ErrorPolicy<E> = (e) => ({ status: 404, body: { error: e.code, id: e.id } })

  const find = async (id: string): Promise<Outcome<{ id: string }, E>> =>
    id === "1" ? ok({ id }) : err({ code: "MISSING", id })

  const r = httpRouter<NoVars>()
    .route("GET", "/item/:id", respond((ctx) => find(ctx.params["id"] ?? ""), policy))
  const h = toHandler(r)

  it("ok → 200", async () => {
    const res = await h(new Request(`${BASE}/item/1`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "1" })
  })

  it("error → 404 via user policy", async () => {
    const res = await h(new Request(`${BASE}/item/9`))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "MISSING", id: "9" })
  })
})

describe("404", () => {
  it("unmatched route", async () => {
    const res = await hit("GET", "/nope")
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// 405 + Allow on method-mismatch; auto-HEAD from GET
// ---------------------------------------------------------------------------

describe("hello-world — the smallest working app", () => {
  it("one router + one verb + toHandler", async () => {
    // The whole app, no validators / policies / mounts needed.
    const handle = toHandler(httpRouter<NoVars>().get("/", async () => text("hi")))
    const res = await handle(new Request(`${BASE}/`))
    expect(await res.text()).toBe("hi")
  })
})

describe("405 + Allow on method mismatch (a clean win over Hono/Elysia)", () => {
  const r = httpRouter<NoVars>()
    .get("/things/:id", async (ctx) => json({ id: ctx.params.id }))
    .post("/things", async () => json({ ok: true }))
    .put("/things/:id", async () => json({ ok: true }))
  const h = toHandler(r)

  it("405 not 404 when path matches but method doesn't", async () => {
    const res = await h(new Request(`${BASE}/things/1`, { method: "DELETE" }))
    expect(res.status).toBe(405)
  })
  it("Allow header lists the registered methods (incl. synthesized HEAD)", async () => {
    const res = await h(new Request(`${BASE}/things/1`, { method: "DELETE" }))
    const allow = (res.headers.get("Allow") ?? "").split(", ").sort()
    expect(allow).toEqual(["GET", "HEAD", "PUT"])
  })
  it("genuinely unmatched path is still 404", async () => {
    const res = await h(new Request(`${BASE}/absent`, { method: "DELETE" }))
    expect(res.status).toBe(404)
  })
})

describe("auto-HEAD synthesized from GET", () => {
  const r = httpRouter<NoVars>()
    .get("/page", async () => json({ hello: "world" }))
  const h = toHandler(r)

  it("HEAD runs the GET handler, returns its status + headers, empty body", async () => {
    const res = await h(new Request(`${BASE}/page`, { method: "HEAD" }))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/json")
    expect(await res.text()).toBe("")
  })

  it("explicit HEAD route takes precedence over synthesis", async () => {
    const r2 = httpRouter<NoVars>()
      .get("/p", async () => json({ from: "get" }))
      .head("/p", async () => new Response(null, { status: 204, headers: { "X-Head": "explicit" } }))
    const res = await toHandler(r2)(new Request(`${BASE}/p`, { method: "HEAD" }))
    expect(res.status).toBe(204)
    expect(res.headers.get("X-Head")).toBe("explicit")
  })
})

// ---------------------------------------------------------------------------
// Typed path params — verb sugar narrows ctx.params from the pattern string
// ---------------------------------------------------------------------------

describe("typed path params (type-level + runtime)", () => {
  it("ctx.params.id is typed string for /users/:id (no ?? '' noise)", async () => {
    const r = httpRouter<NoVars>().get("/users/:id", async (ctx) => {
      // Type-level probe: ctx.params is { readonly id: string }. If params were
      // Record<string,string> under noUncheckedIndexedAccess this would be
      // string|undefined and the assignment below would error.
      const id: string = ctx.params.id
      return json({ id })
    })
    const res = await toHandler(r)(new Request(`${BASE}/users/42`))
    expect(await res.json()).toEqual({ id: "42" })
  })

  it("multiple params accumulate", async () => {
    const r = httpRouter<NoVars>().get("/u/:uid/books/:bid", async (ctx) => {
      const uid: string = ctx.params.uid
      const bid: string = ctx.params.bid
      return json({ uid, bid })
    })
    const res = await toHandler(r)(new Request(`${BASE}/u/7/books/9`))
    expect(await res.json()).toEqual({ uid: "7", bid: "9" })
  })
})

// A pure type-level assertion (no runtime) — fails to compile if params typing
// regresses. Exercised by tsgo, not the test runner.
type _AssertEq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const _paramsProbe: _AssertEq<PathParams<"/users/:id">, { readonly id: string }> = true
const _multiProbe: _AssertEq<
  PathParams<"/u/:uid/books/:bid">,
  { readonly uid: string; readonly bid: string }
> = true
const _noParamProbe: _AssertEq<PathParams<"/static">, Record<never, never>> = true
void _paramsProbe
void _multiProbe
void _noParamProbe

// ---------------------------------------------------------------------------
// Status-aware withValidation — 201 (and other statuses) now expressible
// ---------------------------------------------------------------------------

describe("withValidation is status-aware (201 create)", () => {
  const r = httpRouter<NoVars>().routeNode(
    "POST",
    "/users",
    withValidation(
      async (args: { name: string }) => created({ id: "u-9", name: args.name }),
      schema({ name: "string" }),
    ),
  )
  const h = toHandler(r)

  it("201 + body when fn returns created(value)", async () => {
    const res = await h(new Request(`${BASE}/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Grace" }),
    }))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: "u-9", name: "Grace" })
  })

  it("400 on invalid body still wins (validation sugar preserved)", async () => {
    const res = await h(new Request(`${BASE}/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }))
    expect(res.status).toBe(400)
  })

  it("a plain return still renders 200 (back-compat)", async () => {
    const r2 = httpRouter<NoVars>().routeNode(
      "POST",
      "/p",
      withValidation(async (a: { name: string }) => ({ ok: a.name }), schema({ name: "string" })),
    )
    const res = await toHandler(r2)(new Request(`${BASE}/p`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    }))
    expect(res.status).toBe(200)
  })
})
