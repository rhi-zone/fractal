// packages/http-api-projector/src/extensions/logging.test.ts — @rhi-zone/fractal-http-api-projector

import { describe, expect, it } from "bun:test"
import type { LogEntry } from "./logging.ts"
import { logging } from "./logging.ts"
import { composeFetch } from "../extension.ts"

function collector(): { entries: LogEntry[]; logger: (entry: LogEntry) => void } {
  const entries: LogEntry[] = []
  return { entries, logger: (entry) => entries.push(entry) }
}

describe("logging — runtime (wrapFetch)", () => {
  it("logs nothing at level 'none'", async () => {
    const { entries, logger } = collector()
    const fetchImpl = async () => new Response("ok", { status: 200 })
    const wrapped = composeFetch(fetchImpl, [logging({ level: "none", logger })])
    await wrapped(new Request("http://localhost/"))
    expect(entries).toHaveLength(0)
  })

  it("logs a request and response line at level 'info', without headers", async () => {
    const { entries, logger } = collector()
    const fetchImpl = async () => new Response("ok", { status: 200 })
    const wrapped = composeFetch(fetchImpl, [logging({ level: "info", logger })])
    await wrapped(new Request("http://localhost/foo", { method: "POST", body: "{}" }))

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ kind: "request", method: "POST", url: "http://localhost/foo" })
    expect((entries[0] as { headers?: unknown }).headers).toBeUndefined()
    expect(entries[1]).toMatchObject({ kind: "response", status: 200 })
    expect((entries[1] as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0)
  })

  it("logs headers and body size at level 'debug'", async () => {
    const { entries, logger } = collector()
    const fetchImpl = async () => new Response("ok", { status: 200, headers: { "X-Custom": "1" } })
    const wrapped = composeFetch(fetchImpl, [logging({ level: "debug", logger })])
    const req = new Request("http://localhost/foo", {
      method: "POST",
      body: "{}",
      headers: { "Content-Length": "2", Authorization: "Bearer secret", "X-Custom": "req" },
    })
    await wrapped(req)

    const requestEntry = entries[0] as { headers?: Record<string, string>; bodySize?: number }
    expect(requestEntry.bodySize).toBe(2)
    expect(requestEntry.headers?.authorization).toBe("[REDACTED]")
    expect(requestEntry.headers?.["x-custom"]).toBe("req")

    const responseEntry = entries[1] as { headers?: Record<string, string> }
    expect(responseEntry.headers?.["x-custom"]).toBe("1")
  })

  it("redacts Cookie, Set-Cookie, and X-API-Key by default", async () => {
    const { entries, logger } = collector()
    const fetchImpl = async () => new Response("ok", { status: 200, headers: { "Set-Cookie": "a=b" } })
    const wrapped = composeFetch(fetchImpl, [logging({ level: "debug", logger })])
    const req = new Request("http://localhost/", { headers: { Cookie: "id=1", "X-API-Key": "k" } })
    await wrapped(req)

    const requestEntry = entries[0] as { headers?: Record<string, string> }
    expect(requestEntry.headers?.cookie).toBe("[REDACTED]")
    expect(requestEntry.headers?.["x-api-key"]).toBe("[REDACTED]")

    const responseEntry = entries[1] as { headers?: Record<string, string> }
    expect(responseEntry.headers?.["set-cookie"]).toBe("[REDACTED]")
  })

  it("honors a custom redactHeaders predicate", async () => {
    const { entries, logger } = collector()
    const fetchImpl = async () => new Response("ok", { status: 200 })
    const wrapped = composeFetch(fetchImpl, [
      logging({ level: "debug", logger, redactHeaders: (name) => name.toLowerCase() === "x-secret" }),
    ])
    const req = new Request("http://localhost/", { headers: { "X-Secret": "s", Authorization: "Bearer t" } })
    await wrapped(req)

    const requestEntry = entries[0] as { headers?: Record<string, string> }
    expect(requestEntry.headers?.["x-secret"]).toBe("[REDACTED]")
    expect(requestEntry.headers?.authorization).toBe("Bearer t")
  })

  it("logs only failing responses at level 'warn'", async () => {
    const { entries, logger } = collector()

    const okFetch = async () => new Response("ok", { status: 200 })
    const okWrapped = composeFetch(okFetch, [logging({ level: "warn", logger })])
    await okWrapped(new Request("http://localhost/"))
    expect(entries).toHaveLength(0)

    const errFetch = async () => new Response("err", { status: 500 })
    const errWrapped = composeFetch(errFetch, [logging({ level: "warn", logger })])
    await errWrapped(new Request("http://localhost/"))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: "response", status: 500 })
  })

  it("logs a thrown error at every level except 'none', and rethrows it", async () => {
    const { entries, logger } = collector()
    const boom = new Error("network down")
    const fetchImpl = async (): Promise<Response> => {
      throw boom
    }
    const wrapped = composeFetch(fetchImpl, [logging({ level: "warn", logger })])
    await expect(wrapped(new Request("http://localhost/"))).rejects.toThrow("network down")
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: "error", error: boom })
  })

  it("correlates the request and response entries with the same requestId", async () => {
    const { entries, logger } = collector()
    const fetchImpl = async () => new Response("ok", { status: 200 })
    const wrapped = composeFetch(fetchImpl, [logging({ level: "info", logger })])
    await wrapped(new Request("http://localhost/"))
    expect(entries).toHaveLength(2)
    const reqEntry = entries[0]
    const resEntry = entries[1]
    if (reqEntry === undefined || resEntry === undefined) throw new Error("expected two entries")
    expect(reqEntry.requestId).toBe(resEntry.requestId)
    expect(reqEntry.requestId.length).toBeGreaterThan(0)
  })

  it("defaults to level 'info' when unspecified", async () => {
    const { entries, logger } = collector()
    const fetchImpl = async () => new Response("ok", { status: 200 })
    const wrapped = composeFetch(fetchImpl, [logging({ logger })])
    await wrapped(new Request("http://localhost/"))
    expect(entries).toHaveLength(2)
  })
})

describe("logging — codegen", () => {
  it("wraps the inner expression with __withLogging and baked-in level", () => {
    const ext = logging({ level: "debug" })
    expect(ext.codegen).toBeDefined()
    expect(ext.codegen?.wrap("options.fetch ?? fetch")).toBe(
      '__withLogging(options.fetch ?? fetch, {"level":"debug"})',
    )
  })

  it("defaults to level 'info' in codegen when unspecified", () => {
    const ext = logging()
    expect(ext.codegen?.wrap("fetch")).toBe('__withLogging(fetch, {"level":"info"})')
  })

  it("emits __withLogging helper source", () => {
    expect(logging().codegen?.helpers).toContain("function __withLogging(")
  })

  it("the emitted helper is valid, runnable TypeScript matching the runtime semantics", async () => {
    const helperSrc = logging({ level: "warn" }).codegen?.helpers
    expect(helperSrc).toBeDefined()

    const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = await mkdtemp(join(tmpdir(), "logging-codegen-"))
    const file = join(dir, "helper.ts")
    await writeFile(file, `${helperSrc}\nexport { __withLogging }\n`)
    const mod = (await import(file)) as { __withLogging: (inner: typeof fetch, opts: unknown) => typeof fetch }

    const logs: unknown[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => logs.push(args)
    try {
      const okImpl = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch
      const wrapped = mod.__withLogging(okImpl, { level: "warn" })
      const res = await wrapped("http://localhost/")
      expect(res.status).toBe(200)
      expect(logs).toHaveLength(0) // 'warn' skips successful responses

      const errImpl = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch
      const wrappedErr = mod.__withLogging(errImpl, { level: "warn" })
      await wrappedErr("http://localhost/")
      expect(logs).toHaveLength(1)
    } finally {
      console.log = originalLog
      await rm(dir, { recursive: true, force: true })
    }
  })
})
