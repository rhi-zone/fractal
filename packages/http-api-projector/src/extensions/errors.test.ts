// packages/http-api-projector/src/extensions/errors.test.ts — @rhi-zone/fractal-http-api-projector

import { describe, expect, it } from "bun:test"
import {
  errors,
  BadRequestError,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  UnprocessableEntityError,
  RateLimitError,
  InternalServerError,
} from "./errors.ts"
import { ClientError } from "../client-error.ts"
import { composeFetch } from "../extension.ts"

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

describe("errors — runtime (wrapFetch) classification", () => {
  it("passes through a successful (2xx) response unchanged", async () => {
    const base = async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    const wrapped = composeFetch(base, [errors()])
    const res = await wrapped(new Request("http://localhost/"))
    expect(res.status).toBe(200)
  })

  const cases: Array<[number, new (...args: never[]) => ClientError]> = [
    [400, BadRequestError],
    [401, AuthenticationError],
    [403, ForbiddenError],
    [404, NotFoundError],
    [409, ConflictError],
    [422, UnprocessableEntityError],
    [429, RateLimitError],
    [500, InternalServerError],
    [503, InternalServerError],
  ]

  for (const [status, klass] of cases) {
    it(`classifies a ${status} response as ${klass.name}`, async () => {
      const base = async () => jsonResponse(status, { message: "nope" })
      const wrapped = composeFetch(base, [errors()])
      const caught = await wrapped(new Request("http://localhost/")).catch((e: unknown) => e)
      expect(caught).toBeInstanceOf(klass)
      expect(caught).toBeInstanceOf(ClientError)
      expect((caught as ClientError).status).toBe(status)
      expect((caught as ClientError).body).toEqual({ message: "nope" })
    })
  }

  it("falls back to the base ClientError for an unmapped 4xx status", async () => {
    const base = async () => jsonResponse(418, { message: "teapot" })
    const wrapped = composeFetch(base, [errors()])
    const caught = await wrapped(new Request("http://localhost/")).catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(ClientError)
    expect(caught).not.toBeInstanceOf(BadRequestError)
    expect((caught as ClientError).status).toBe(418)
  })

  it("reads a text body when the response isn't JSON", async () => {
    const base = async () => new Response("plain text error", { status: 404 })
    const wrapped = composeFetch(base, [errors()])
    const caught = await wrapped(new Request("http://localhost/")).catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(NotFoundError)
    expect((caught as ClientError).body).toBe("plain text error")
  })

  describe("RateLimitError header parsing", () => {
    it("parses a numeric Retry-After (seconds) into retryAfterMs", async () => {
      const base = async () => jsonResponse(429, {}, { "Retry-After": "5" })
      const wrapped = composeFetch(base, [errors()])
      const caught = (await wrapped(new Request("http://localhost/")).catch((e: unknown) => e)) as RateLimitError
      expect(caught.retryAfterMs).toBe(5000)
    })

    it("parses X-RateLimit-Limit/Remaining as integers", async () => {
      const base = async () =>
        jsonResponse(429, {}, { "X-RateLimit-Limit": "100", "X-RateLimit-Remaining": "0" })
      const wrapped = composeFetch(base, [errors()])
      const caught = (await wrapped(new Request("http://localhost/")).catch((e: unknown) => e)) as RateLimitError
      expect(caught.limit).toBe(100)
      expect(caught.remaining).toBe(0)
    })

    it("leaves fields undefined when headers are absent", async () => {
      const base = async () => jsonResponse(429, {})
      const wrapped = composeFetch(base, [errors()])
      const caught = (await wrapped(new Request("http://localhost/")).catch((e: unknown) => e)) as RateLimitError
      expect(caught.retryAfterMs).toBeUndefined()
      expect(caught.limit).toBeUndefined()
      expect(caught.remaining).toBeUndefined()
      expect(caught.resetMs).toBeUndefined()
    })
  })
})

describe("errors — codegen", () => {
  it("wraps the inner expression with __withErrors", () => {
    const ext = errors()
    expect(ext.codegen).toBeDefined()
    expect(ext.codegen?.wrap?.("options.fetch ?? fetch")).toBe("__withErrors(options.fetch ?? fetch)")
  })

  it("emits the typed error classes and __withErrors helper source", () => {
    const ext = errors()
    const helpers = ext.codegen?.helpers ?? ""
    expect(helpers).toContain("export class NotFoundError extends ClientError")
    expect(helpers).toContain("export class RateLimitError extends ClientError")
    expect(helpers).toContain("function __withErrors(")
  })

  it("the emitted helper is valid, runnable TypeScript matching the runtime classification", async () => {
    const ext = errors()
    const helperSrc = ext.codegen?.helpers
    expect(helperSrc).toBeDefined()

    // ERRORS_CODEGEN_HELPERS extends the `ClientError` class codegen.ts's
    // RUNTIME_HELPERS always emits ahead of extension helpers (see errors.ts's
    // module doc) — reproduce that one declaration here so the helper module
    // is self-contained for this eval.
    const clientErrorSrc = `
export class ClientError extends Error {
  readonly status: number
  readonly statusText: string
  readonly body: unknown
  constructor(status: number, statusText: string, body: unknown) {
    super(\`HTTP \${status} \${statusText}\`)
    this.name = "ClientError"
    this.status = status
    this.statusText = statusText
    this.body = body
  }
}`

    const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = await mkdtemp(join(tmpdir(), "errors-codegen-"))
    const file = join(dir, "helper.ts")
    await writeFile(file, `${clientErrorSrc}\n${helperSrc}\nexport { __withErrors }\n`)
    const mod = (await import(file)) as {
      __withErrors: (inner: typeof fetch) => typeof fetch
      NotFoundError: new (...args: unknown[]) => Error & { status: number }
      RateLimitError: new (...args: unknown[]) => Error & { status: number; retryAfterMs?: number }
    }

    const notFound = (async () => new Response("nope", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch
    const wrappedNotFound = mod.__withErrors(notFound)
    const caughtNotFound = await wrappedNotFound("http://localhost/").catch((e: unknown) => e)
    expect(caughtNotFound).toBeInstanceOf(mod.NotFoundError)
    expect((caughtNotFound as { status: number }).status).toBe(404)

    const rateLimited = (async () =>
      new Response("{}", {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "Content-Type": "application/json", "Retry-After": "2" },
      })) as unknown as typeof fetch
    const wrappedRateLimited = mod.__withErrors(rateLimited)
    const caughtRateLimited = await wrappedRateLimited("http://localhost/").catch((e: unknown) => e)
    expect(caughtRateLimited).toBeInstanceOf(mod.RateLimitError)
    expect((caughtRateLimited as { retryAfterMs?: number }).retryAfterMs).toBe(2000)

    await rm(dir, { recursive: true, force: true })
  })
})
