// packages/http/src/layers.test.ts — composable layer tests

import { describe, expect, it } from "bun:test"
import { node, op } from "@rhi-zone/fractal-core/node"
import { buildRoutes, makeRouter } from "./project.ts"
import { autoMethodLayer, corsLayer } from "./layers.ts"

// ============================================================================
// autoMethodLayer — droppability proof + HTTP-correctness behaviors
// ============================================================================

describe("autoMethodLayer — proves droppable", () => {
  const api = node({
    ops: {
      getItem: op((_: unknown) => ({ id: 42 }), {
        tags: { readOnly: true },
        http: { segment: "item" },
      }),
    },
  })
  const routes = buildRoutes(api)
  const coreRouter = makeRouter(routes)

  // ── Without the layer (core only) ─────────────────────────────────────────

  it("[core] HEAD on a GET route → 404 (no HEAD-from-GET in core)", async () => {
    const res = await coreRouter(
      new Request("http://localhost/item", { method: "HEAD" }),
    )
    expect(res.status).toBe(404)
  })

  it("[core] OPTIONS on a known path → 404 (no auto-OPTIONS in core)", async () => {
    const res = await coreRouter(
      new Request("http://localhost/item", { method: "OPTIONS" }),
    )
    expect(res.status).toBe(404)
  })

  it("[core] wrong method on a known path → 404, no Allow header", async () => {
    const res = await coreRouter(
      new Request("http://localhost/item", { method: "DELETE" }),
    )
    expect(res.status).toBe(404)
    expect(res.headers.get("Allow")).toBeNull()
  })

  // ── With the layer ─────────────────────────────────────────────────────────

  const handler = autoMethodLayer(coreRouter, routes)

  it("[layer] HEAD → derives from GET, body stripped, status 200", async () => {
    const res = await handler(
      new Request("http://localhost/item", { method: "HEAD" }),
    )
    expect(res.status).toBe(200)
    // HEAD must have no body
    expect(res.body).toBeNull()
  })

  it("[layer] OPTIONS → 204 + Allow header contains GET and OPTIONS", async () => {
    const res = await handler(
      new Request("http://localhost/item", { method: "OPTIONS" }),
    )
    expect(res.status).toBe(204)
    const allow = res.headers.get("Allow")
    expect(allow).not.toBeNull()
    expect(allow).toContain("GET")
    expect(allow).toContain("OPTIONS")
  })

  it("[layer] OPTIONS Allow header includes HEAD (auto-derived from GET)", async () => {
    const res = await handler(
      new Request("http://localhost/item", { method: "OPTIONS" }),
    )
    const allow = res.headers.get("Allow")
    expect(allow).toContain("HEAD")
  })

  it("[layer] wrong method → 405 + Allow header", async () => {
    const res = await handler(
      new Request("http://localhost/item", { method: "DELETE" }),
    )
    expect(res.status).toBe(405)
    const allow = res.headers.get("Allow")
    expect(allow).not.toBeNull()
    expect(allow).toContain("GET")
  })

  it("[layer] missing path → 404 (delegates to inner)", async () => {
    const res = await handler(new Request("http://localhost/nonexistent"))
    expect(res.status).toBe(404)
  })

  it("[layer] correct verb still dispatched to inner handler", async () => {
    const res = await handler(new Request("http://localhost/item"))
    expect(res.status).toBe(200)
    const body = await res.json() as unknown
    expect(body).toEqual({ id: 42 })
  })
})

describe("autoMethodLayer — multi-verb routes", () => {
  const api = node({
    ops: {
      getItem: op((_: unknown) => ({ id: 1 }), {
        tags: { readOnly: true },
        http: { segment: "item" },
      }),
      updateItem: op((_: unknown) => ({ updated: true }), {
        tags: { idempotent: true },
        http: { segment: "item" },
      }),
    },
  })
  const routes = buildRoutes(api)
  const handler = autoMethodLayer(makeRouter(routes), routes)

  it("OPTIONS lists all registered verbs for the path", async () => {
    const res = await handler(
      new Request("http://localhost/item", { method: "OPTIONS" }),
    )
    expect(res.status).toBe(204)
    const allow = res.headers.get("Allow") ?? ""
    expect(allow).toContain("GET")
    expect(allow).toContain("PUT")
    expect(allow).toContain("OPTIONS")
  })

  it("wrong method returns 405 with all registered verbs in Allow", async () => {
    const res = await handler(
      new Request("http://localhost/item", { method: "POST" }),
    )
    expect(res.status).toBe(405)
    const allow = res.headers.get("Allow") ?? ""
    expect(allow).toContain("GET")
    expect(allow).toContain("PUT")
  })
})

// ============================================================================
// corsLayer
// ============================================================================

describe("corsLayer", () => {
  const innerFetch = async (_: Request): Promise<Response> =>
    new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    })

  it("adds Access-Control-Allow-Origin: * to responses by default", async () => {
    const handler = corsLayer()(innerFetch)
    const res = await handler(new Request("http://localhost/test"))
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
  })

  it("reflects specific origin when allowlisted", async () => {
    const handler = corsLayer({ origin: "https://app.example.com" })(innerFetch)
    const res = await handler(
      new Request("http://localhost/test", {
        headers: { Origin: "https://app.example.com" },
      }),
    )
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.com",
    )
  })

  it("omits CORS header for disallowed origin", async () => {
    const handler = corsLayer({ origin: "https://app.example.com" })(innerFetch)
    const res = await handler(
      new Request("http://localhost/test", {
        headers: { Origin: "https://evil.example.com" },
      }),
    )
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })

  it("handles CORS preflight (OPTIONS + Access-Control-Request-Method)", async () => {
    const handler = corsLayer({ origin: "https://app.example.com" })(innerFetch)
    const res = await handler(
      new Request("http://localhost/test", {
        method: "OPTIONS",
        headers: {
          Origin: "https://app.example.com",
          "Access-Control-Request-Method": "POST",
        },
      }),
    )
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.com",
    )
    expect(res.headers.get("Access-Control-Allow-Methods")).not.toBeNull()
  })

  it("passes non-CORS OPTIONS through to inner handler", async () => {
    const handler = corsLayer()(innerFetch)
    const res = await handler(
      new Request("http://localhost/test", { method: "OPTIONS" }),
    )
    // No Access-Control-Request-Method → not a preflight → passes through
    const body = await res.json() as unknown
    expect(body).toEqual({ ok: true })
  })
})
