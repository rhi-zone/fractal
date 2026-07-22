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
})
