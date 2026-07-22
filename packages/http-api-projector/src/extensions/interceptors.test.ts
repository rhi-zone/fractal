// packages/http-api-projector/src/extensions/interceptors.test.ts — @rhi-zone/fractal-http-api-projector

import { describe, expect, it } from "bun:test"
import { interceptors } from "./interceptors.ts"
import { composeFetch } from "../extension.ts"

describe("interceptors", () => {
  it("onRequest can inject a header before the request is sent", async () => {
    const seen: { auth: string | null } = { auth: null }
    const base = async (req: Request): Promise<Response> => {
      seen.auth = req.headers.get("Authorization")
      return new Response("ok")
    }
    const wrapped = composeFetch(base, [
      interceptors({
        onRequest: (req) => new Request(req, { headers: { ...req.headers, Authorization: "Bearer tok" } }),
      }),
    ])
    await wrapped(new Request("http://localhost/"))
    expect(seen.auth).toBe("Bearer tok")
  })

  it("onResponse can transform the response before it's handed back", async () => {
    const base = async () => new Response("ok", { status: 200 })
    const wrapped = composeFetch(base, [
      interceptors({
        onResponse: (res) => new Response(res.body, { status: 200, headers: { "x-seen": "yes" } }),
      }),
    ])
    const res = await wrapped(new Request("http://localhost/"))
    expect(res.headers.get("x-seen")).toBe("yes")
  })

  it("onError observes a thrown error but the error still propagates", async () => {
    const boom = new Error("boom")
    const base = async (): Promise<Response> => {
      throw boom
    }
    let observed: unknown
    const wrapped = composeFetch(base, [
      interceptors({ onError: (err) => { observed = err } }),
    ])
    await expect(wrapped(new Request("http://localhost/"))).rejects.toThrow("boom")
    expect(observed).toBe(boom)
  })

  it("with no options configured, behaves as a pass-through", async () => {
    const base = async () => new Response("ok", { status: 200 })
    const wrapped = composeFetch(base, [interceptors()])
    const res = await wrapped(new Request("http://localhost/"))
    expect(res.status).toBe(200)
  })

  it("has no codegen hook (runtime-only, see module doc)", () => {
    expect(interceptors().codegen).toBeUndefined()
  })
})
