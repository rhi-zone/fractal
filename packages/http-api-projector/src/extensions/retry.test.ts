// packages/http-api-projector/src/extensions/retry.test.ts — @rhi-zone/fractal-http-api-projector

import { describe, expect, it } from "bun:test"
import { retry } from "./retry.ts"
import { composeFetch } from "../extension.ts"

function makeCountingFetch(behavior: (attempt: number) => Response | Error) {
  let attempt = 0
  const calls: Request[] = []
  const fetchImpl = async (req: Request): Promise<Response> => {
    calls.push(req)
    const outcome = behavior(attempt)
    attempt++
    if (outcome instanceof Error) throw outcome
    return outcome
  }
  return { fetchImpl, calls, attempts: () => attempt }
}

describe("retry — runtime (wrapFetch)", () => {
  it("does not retry a successful (2xx) response", async () => {
    const { fetchImpl, attempts } = makeCountingFetch(() => new Response("ok", { status: 200 }))
    const wrapped = composeFetch(fetchImpl, [retry({ baseDelayMs: 1 })])
    const res = await wrapped(new Request("http://localhost/"))
    expect(res.status).toBe(200)
    expect(attempts()).toBe(1)
  })

  it("retries on a 5xx response until it succeeds", async () => {
    const { fetchImpl, attempts } = makeCountingFetch((attempt) =>
      attempt < 2 ? new Response("err", { status: 503 }) : new Response("ok", { status: 200 }),
    )
    const wrapped = composeFetch(fetchImpl, [retry({ baseDelayMs: 1, jitter: false })])
    const res = await wrapped(new Request("http://localhost/"))
    expect(res.status).toBe(200)
    expect(attempts()).toBe(3)
  })

  it("gives up after maxRetries and returns the last failing response", async () => {
    const { fetchImpl, attempts } = makeCountingFetch(() => new Response("err", { status: 503 }))
    const wrapped = composeFetch(fetchImpl, [retry({ maxRetries: 2, baseDelayMs: 1 })])
    const res = await wrapped(new Request("http://localhost/"))
    expect(res.status).toBe(503)
    expect(attempts()).toBe(3) // initial + 2 retries
  })

  it("retries on a thrown network error", async () => {
    const { fetchImpl, attempts } = makeCountingFetch((attempt) =>
      attempt < 1 ? new TypeError("network down") : new Response("ok", { status: 200 }),
    )
    const wrapped = composeFetch(fetchImpl, [retry({ baseDelayMs: 1 })])
    const res = await wrapped(new Request("http://localhost/"))
    expect(res.status).toBe(200)
    expect(attempts()).toBe(2)
  })

  it("never retries a user-initiated AbortError", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" })
    const { fetchImpl, attempts } = makeCountingFetch(() => abortErr)
    const wrapped = composeFetch(fetchImpl, [retry({ baseDelayMs: 1 })])
    await expect(wrapped(new Request("http://localhost/"))).rejects.toThrow("aborted")
    expect(attempts()).toBe(1)
  })

  it("does not retry a 4xx response (not transient)", async () => {
    const { fetchImpl, attempts } = makeCountingFetch(() => new Response("bad", { status: 404 }))
    const wrapped = composeFetch(fetchImpl, [retry({ baseDelayMs: 1 })])
    const res = await wrapped(new Request("http://localhost/"))
    expect(res.status).toBe(404)
    expect(attempts()).toBe(1)
  })

  it("honors a custom retryOn predicate", async () => {
    const { fetchImpl, attempts } = makeCountingFetch((attempt) =>
      attempt < 1 ? new Response("bad", { status: 404 }) : new Response("ok", { status: 200 }),
    )
    const wrapped = composeFetch(fetchImpl, [
      retry({ baseDelayMs: 1, retryOn: (res) => res?.status === 404 }),
    ])
    const res = await wrapped(new Request("http://localhost/"))
    expect(res.status).toBe(200)
    expect(attempts()).toBe(2)
  })

  it("re-sends the request body on each attempt (clones the Request)", async () => {
    const bodies: string[] = []
    let attempt = 0
    const fetchImpl = async (req: Request): Promise<Response> => {
      bodies.push(await req.text())
      attempt++
      return attempt < 2 ? new Response("err", { status: 503 }) : new Response("ok", { status: 200 })
    }
    const wrapped = composeFetch(fetchImpl, [retry({ baseDelayMs: 1 })])
    const req = new Request("http://localhost/", { method: "POST", body: JSON.stringify({ a: 1 }) })
    const res = await wrapped(req)
    expect(res.status).toBe(200)
    expect(bodies).toEqual(['{"a":1}', '{"a":1}'])
  })
})

describe("retry — codegen", () => {
  it("wraps the inner expression with __withRetry and baked-in options", () => {
    const ext = retry({ maxRetries: 5, baseDelayMs: 200, jitter: false })
    expect(ext.codegen).toBeDefined()
    const wrapped = ext.codegen?.wrap?.("options.fetch ?? fetch")
    expect(wrapped).toBe(
      '__withRetry(options.fetch ?? fetch, {"maxRetries":5,"baseDelayMs":200,"jitter":false})',
    )
  })

  it("emits __withRetry helper source", () => {
    const ext = retry()
    expect(ext.codegen?.helpers).toContain("function __withRetry(")
  })

  it("the emitted helper is valid, runnable TypeScript matching the runtime semantics", async () => {
    const ext = retry({ maxRetries: 2, baseDelayMs: 1, jitter: false })
    const helperSrc = ext.codegen?.helpers
    expect(helperSrc).toBeDefined()

    const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = await mkdtemp(join(tmpdir(), "retry-codegen-"))
    const file = join(dir, "helper.ts")
    await writeFile(file, `${helperSrc}\nexport { __withRetry }\n`)
    const mod = (await import(file)) as { __withRetry: (inner: typeof fetch, opts: unknown) => typeof fetch }

    let attempt = 0
    const flaky = (async () => {
      attempt++
      return attempt < 2 ? new Response("err", { status: 503 }) : new Response("ok", { status: 200 })
    }) as unknown as typeof fetch

    const wrapped = mod.__withRetry(flaky, { maxRetries: 2, baseDelayMs: 1, jitter: false })
    const res = await wrapped("http://localhost/")
    expect(res.status).toBe(200)
    expect(attempt).toBe(2)

    await rm(dir, { recursive: true, force: true })
  })
})
