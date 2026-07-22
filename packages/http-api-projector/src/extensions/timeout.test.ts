// packages/http-api-projector/src/extensions/timeout.test.ts — @rhi-zone/fractal-http-api-projector

import { describe, expect, it } from "bun:test"
import { timeout } from "./timeout.ts"
import { composeFetch } from "../extension.ts"

function makeHangingFetch(): (req: Request) => Promise<Response> {
  return (req: Request) =>
    new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => resolve(new Response("ok")), 5000)
      req.signal.addEventListener("abort", () => {
        clearTimeout(t)
        reject(req.signal.reason)
      })
    })
}

describe("timeout — runtime (wrapFetch)", () => {
  it("aborts a hanging request after `ms` and throws a timeout-specific error", async () => {
    const wrapped = composeFetch(makeHangingFetch(), [timeout({ ms: 20 })])
    await expect(wrapped(new Request("http://localhost/"))).rejects.toThrow(/timed out/i)
  })

  it("resolves normally when the request completes before the timeout", async () => {
    const fast = async () => new Response("ok", { status: 200 })
    const wrapped = composeFetch(fast, [timeout({ ms: 1000 })])
    const res = await wrapped(new Request("http://localhost/"))
    expect(res.status).toBe(200)
  })

  it("combines with a signal already on the request (either aborts it)", async () => {
    const controller = new AbortController()
    const wrapped = composeFetch(makeHangingFetch(), [timeout({ ms: 1000 })])
    const req = new Request("http://localhost/", { signal: controller.signal })
    const pending = wrapped(req)
    queueMicrotask(() => controller.abort(Object.assign(new Error("user abort"), { name: "AbortError" })))
    await expect(pending).rejects.toThrow()
  })
})

describe("timeout — codegen", () => {
  it("wraps the inner expression with __withTimeout and baked-in ms", () => {
    const ext = timeout({ ms: 3000 })
    expect(ext.codegen?.wrap("options.fetch ?? fetch")).toBe(
      '__withTimeout(options.fetch ?? fetch, {"ms":3000})',
    )
  })

  it("emits __withTimeout helper source", () => {
    expect(timeout({ ms: 1 }).codegen?.helpers).toContain("function __withTimeout(")
  })

  it("the emitted helper is valid, runnable TypeScript matching the runtime semantics", async () => {
    const helperSrc = timeout({ ms: 20 }).codegen?.helpers
    expect(helperSrc).toBeDefined()

    const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = await mkdtemp(join(tmpdir(), "timeout-codegen-"))
    const file = join(dir, "helper.ts")
    await writeFile(file, `${helperSrc}\nexport { __withTimeout }\n`)
    const mod = (await import(file)) as { __withTimeout: (inner: typeof fetch, opts: unknown) => typeof fetch }

    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(new Response("ok")), 5000)
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t)
          reject(init.signal?.reason)
        })
      })) as typeof fetch

    const wrapped = mod.__withTimeout(hanging, { ms: 20 })
    await expect(wrapped("http://localhost/")).rejects.toThrow(/timed out/i)

    await rm(dir, { recursive: true, force: true })
  })
})
