// packages/http-api-projector/src/extensions/idempotency.test.ts — @rhi-zone/fractal-http-api-projector

import { describe, expect, it } from "bun:test"
import { idempotencyKey } from "./idempotency.ts"
import { composeFetch } from "../extension.ts"

function makeRecordingFetch() {
  const requests: Request[] = []
  const fetchImpl = async (req: Request): Promise<Response> => {
    requests.push(req)
    return new Response("ok", { status: 200 })
  }
  return { fetchImpl, requests }
}

describe("idempotencyKey — runtime (wrapFetch)", () => {
  it("attaches an Idempotency-Key header to a POST request", async () => {
    const { fetchImpl, requests } = makeRecordingFetch()
    const wrapped = composeFetch(fetchImpl, [idempotencyKey()])
    await wrapped(new Request("http://localhost/books", { method: "POST", body: "{}" }))
    expect(requests[0]!.headers.has("Idempotency-Key")).toBe(true)
  })

  it("attaches a header to PUT/PATCH/DELETE too", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const { fetchImpl, requests } = makeRecordingFetch()
      const wrapped = composeFetch(fetchImpl, [idempotencyKey()])
      await wrapped(new Request("http://localhost/books/1", { method }))
      expect(requests[0]!.headers.has("Idempotency-Key")).toBe(true)
    }
  })

  it("does not attach a header to GET/HEAD requests", async () => {
    for (const method of ["GET", "HEAD"]) {
      const { fetchImpl, requests } = makeRecordingFetch()
      const wrapped = composeFetch(fetchImpl, [idempotencyKey()])
      await wrapped(new Request("http://localhost/books", { method }))
      expect(requests[0]!.headers.has("Idempotency-Key")).toBe(false)
    }
  })

  it("generates a different key per request by default", async () => {
    const { fetchImpl, requests } = makeRecordingFetch()
    const wrapped = composeFetch(fetchImpl, [idempotencyKey()])
    await wrapped(new Request("http://localhost/books", { method: "POST", body: "{}" }))
    await wrapped(new Request("http://localhost/books", { method: "POST", body: "{}" }))
    const [first, second] = requests
    expect(first!.headers.get("Idempotency-Key")).not.toBe(second!.headers.get("Idempotency-Key"))
  })

  it("respects a caller-supplied key already on the request", async () => {
    const { fetchImpl, requests } = makeRecordingFetch()
    const wrapped = composeFetch(fetchImpl, [idempotencyKey()])
    await wrapped(
      new Request("http://localhost/books", {
        method: "POST",
        body: "{}",
        headers: { "Idempotency-Key": "caller-chosen" },
      }),
    )
    expect(requests[0]!.headers.get("Idempotency-Key")).toBe("caller-chosen")
  })

  it("honors a custom generateKey", async () => {
    const { fetchImpl, requests } = makeRecordingFetch()
    const wrapped = composeFetch(fetchImpl, [idempotencyKey({ generateKey: () => "fixed-key" })])
    await wrapped(new Request("http://localhost/books", { method: "POST", body: "{}" }))
    expect(requests[0]!.headers.get("Idempotency-Key")).toBe("fixed-key")
  })

  it("honors a custom header name", async () => {
    const { fetchImpl, requests } = makeRecordingFetch()
    const wrapped = composeFetch(fetchImpl, [idempotencyKey({ header: "X-Idempotency-Key" })])
    await wrapped(new Request("http://localhost/books", { method: "POST", body: "{}" }))
    expect(requests[0]!.headers.has("X-Idempotency-Key")).toBe(true)
    expect(requests[0]!.headers.has("Idempotency-Key")).toBe(false)
  })

  it("honors a custom methods list", async () => {
    const { fetchImpl, requests } = makeRecordingFetch()
    const wrapped = composeFetch(fetchImpl, [idempotencyKey({ methods: ["POST"] })])
    await wrapped(new Request("http://localhost/books/1", { method: "PUT" }))
    expect(requests[0]!.headers.has("Idempotency-Key")).toBe(false)
  })

  it("preserves the same key across retry() re-attempts when listed outside it", async () => {
    let attempt = 0
    const seenKeys: (string | null)[] = []
    const fetchImpl = async (req: Request): Promise<Response> => {
      seenKeys.push(req.headers.get("Idempotency-Key"))
      attempt++
      return attempt < 2 ? new Response("err", { status: 503 }) : new Response("ok", { status: 200 })
    }
    const { retry } = await import("./retry.ts")
    const wrapped = composeFetch(fetchImpl, [idempotencyKey(), retry({ baseDelayMs: 1 })])
    await wrapped(new Request("http://localhost/books", { method: "POST", body: "{}" }))
    expect(seenKeys.length).toBe(2)
    expect(seenKeys[0]).toBe(seenKeys[1])
    expect(seenKeys[0]).not.toBeNull()
  })
})

describe("idempotencyKey — codegen", () => {
  it("wraps the inner expression with __withIdempotencyKey and baked-in options", () => {
    const ext = idempotencyKey({ header: "Idempotency-Key", methods: ["POST"] })
    expect(ext.codegen).toBeDefined()
    const wrapped = ext.codegen?.wrap?.("options.fetch ?? fetch")
    expect(wrapped).toBe(
      '__withIdempotencyKey(options.fetch ?? fetch, {"header":"Idempotency-Key","methods":["POST"]})',
    )
  })

  it("emits __withIdempotencyKey helper source", () => {
    const ext = idempotencyKey()
    expect(ext.codegen?.helpers).toContain("function __withIdempotencyKey(")
  })

  it("the emitted helper is valid, runnable TypeScript matching the runtime semantics", async () => {
    const ext = idempotencyKey()
    const helperSrc = ext.codegen?.helpers
    expect(helperSrc).toBeDefined()

    const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = await mkdtemp(join(tmpdir(), "idempotency-codegen-"))
    const file = join(dir, "helper.ts")
    await writeFile(file, `${helperSrc}\nexport { __withIdempotencyKey }\n`)
    const mod = (await import(file)) as {
      __withIdempotencyKey: (inner: typeof fetch, opts: unknown) => typeof fetch
    }

    const seen: (string | null)[] = []
    const inner = (async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("Idempotency-Key"))
      return new Response("ok", { status: 200 })
    }) as unknown as typeof fetch

    const wrapped = mod.__withIdempotencyKey(inner, {
      header: "Idempotency-Key",
      methods: ["POST", "PUT", "PATCH", "DELETE"],
    })
    await wrapped("http://localhost/books", { method: "POST" })
    await wrapped("http://localhost/books", { method: "GET" })
    expect(seen[0]).not.toBeNull()
    expect(seen[1]).toBeNull()

    await rm(dir, { recursive: true, force: true })
  })
})
