// packages/http/src/adapter.test.ts — serveNode fetch-handler bridge tests

import { afterEach, describe, expect, it } from "bun:test"
import { serveNode } from "./adapter.ts"

describe("serveNode", () => {
  let server: { port: number; stop(): void } | undefined

  afterEach(() => {
    server?.stop()
    server = undefined
  })

  it("forwards a basic GET request", async () => {
    let seenUrl = ""
    let seenMethod = ""
    server = await serveNode(async (req) => {
      seenUrl = req.url
      seenMethod = req.method
      return new Response("hello", { status: 200 })
    })
    const res = await fetch(`http://localhost:${server.port}/foo?bar=1`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("hello")
    expect(seenMethod).toBe("GET")
    expect(seenUrl).toBe(`http://localhost:${server.port}/foo?bar=1`)
  })

  it("forwards a POST request with a JSON body", async () => {
    let seenBody: unknown
    server = await serveNode(async (req) => {
      seenBody = await req.json()
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })
    })
    const res = await fetch(`http://localhost:${server.port}/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Alice" }),
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true })
    expect(seenBody).toEqual({ name: "Alice" })
  })

  it("forwards custom response headers", async () => {
    server = await serveNode(async () => {
      return new Response("ok", { headers: { "x-custom-header": "value123" } })
    })
    const res = await fetch(`http://localhost:${server.port}/`)
    expect(res.headers.get("x-custom-header")).toBe("value123")
  })

  it("forwards custom status codes", async () => {
    server = await serveNode(async () => new Response("not found", { status: 404 }))
    const res = await fetch(`http://localhost:${server.port}/missing`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("not found")
  })

  it("constructs the request URL from the Host header", async () => {
    let seenUrl = ""
    server = await serveNode(async (req) => {
      seenUrl = req.url
      return new Response("ok")
    })
    const res = await fetch(`http://localhost:${server.port}/path`, {
      headers: { host: "example.com" },
    })
    expect(res.status).toBe(200)
    expect(seenUrl).toBe("http://example.com/path")
  })

  it("defaults to a random port and reports it back", async () => {
    server = await serveNode(async () => new Response("ok"))
    expect(server.port).toBeGreaterThan(0)
  })
})
