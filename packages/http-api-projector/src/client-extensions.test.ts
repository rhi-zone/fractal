// packages/http-api-projector/src/client-extensions.test.ts — @rhi-zone/fractal-http-api-projector
//
// Integration: `ClientOptions.extensions` wired end-to-end through
// `createClient`/`createClientFromRoute` against the library-api example
// tree, using `createFetch(api)` (in-process dispatch, no network) wrapped
// in a flaky adapter to prove `retry()` actually recovers a real round-trip,
// not just a mocked fetch (see extensions/retry.test.ts for the unit-level
// coverage of the retry policy itself).

import { beforeEach, describe, expect, it } from "bun:test"
import { api, clearStore } from "../../../examples/library-api/src/tree.ts"
import { createClient } from "./client.ts"
import { createFetch } from "./preset.ts"
import { retry } from "./extensions/retry.ts"
import { errors, InternalServerError, NotFoundError, RateLimitError } from "./extensions/errors.ts"

beforeEach(() => {
  clearStore()
})

/** Wraps a real fetch, failing with 503 the first `failCount` times per call site. */
function makeFlakyFetch(inner: (req: Request) => Promise<Response>, failCount: number) {
  let remaining = failCount
  return async (req: Request): Promise<Response> => {
    if (remaining > 0) {
      remaining--
      return new Response("Service Unavailable", { status: 503 })
    }
    return inner(req)
  }
}

describe("createClient — extensions integration", () => {
  it("retry() recovers a call that fails twice with 503 before succeeding", async () => {
    const serverFetch = createFetch(api)
    const flaky = makeFlakyFetch(serverFetch, 2)
    const client = createClient(api, {
      baseUrl: "http://localhost",
      fetch: flaky,
      extensions: [retry({ maxRetries: 3, baseDelayMs: 1 })],
    })

    const books = (await client.books.list()) as unknown[]
    expect(Array.isArray(books)).toBe(true)
  })

  it("without retry(), the same flaky fetch surfaces the 503 as a ClientError", async () => {
    const serverFetch = createFetch(api)
    const flaky = makeFlakyFetch(serverFetch, 2)
    const client = createClient(api, { baseUrl: "http://localhost", fetch: flaky })

    await expect(client.books.list()).rejects.toMatchObject({ status: 503 })
  })

  it("retry() gives up and still throws once maxRetries is exceeded", async () => {
    const serverFetch = createFetch(api)
    const flaky = makeFlakyFetch(serverFetch, 10)
    const client = createClient(api, {
      baseUrl: "http://localhost",
      fetch: flaky,
      extensions: [retry({ maxRetries: 2, baseDelayMs: 1 })],
    })

    await expect(client.books.list()).rejects.toMatchObject({ status: 503 })
  })

  it("multiple extensions compose: retry retries the whole (timeout-wrapped) inner call", async () => {
    const serverFetch = createFetch(api)
    const flaky = makeFlakyFetch(serverFetch, 1)
    const client = createClient(api, {
      baseUrl: "http://localhost",
      fetch: flaky,
      extensions: [retry({ maxRetries: 2, baseDelayMs: 1 }), retry({ maxRetries: 0, baseDelayMs: 1 })],
    })

    const books = (await client.books.list()) as unknown[]
    expect(Array.isArray(books)).toBe(true)
  })

  it("errors() classifies a 404 response as NotFoundError instead of generic ClientError", async () => {
    const notFound = async () =>
      new Response(JSON.stringify({ message: "no such book" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    const client = createClient(api, { baseUrl: "http://localhost", fetch: notFound, extensions: [errors()] })

    const caught = await client.books.bookId("does-not-exist").read().catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(NotFoundError)
    expect((caught as NotFoundError).status).toBe(404)
    expect((caught as NotFoundError).body).toEqual({ message: "no such book" })
  })

  it("errors() classifies a 429 response as RateLimitError with parsed Retry-After", async () => {
    const rateLimited = async () =>
      new Response(JSON.stringify({}), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "3" },
      })
    const client = createClient(api, { baseUrl: "http://localhost", fetch: rateLimited, extensions: [errors()] })

    const caught = await client.books.list().catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(RateLimitError)
    expect((caught as RateLimitError).retryAfterMs).toBe(3000)
  })

  it("composes with retry(): retry() (outer) retries 5xx, errors() (inner) classifies the final failure", async () => {
    const serverFetch = createFetch(api)
    const flaky = makeFlakyFetch(serverFetch, 10)
    const client = createClient(api, {
      baseUrl: "http://localhost",
      fetch: flaky,
      extensions: [retry({ maxRetries: 2, baseDelayMs: 1 }), errors()],
    })

    const caught = await client.books.list().catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(InternalServerError)
  })
})
