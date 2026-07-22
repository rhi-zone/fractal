// packages/http-api-projector/src/client.test.ts — @rhi-zone/fractal-http-api-projector
//
// Round-trip tests for createClient against the library-api example tree.
// All tests use `fetch: createFetch(api)` for in-process dispatch — no
// network, no server process. The injected fetch goes through the full
// HTTP stack (makeRouter → handler) so verb+path correctness is exercised.
//
// The bookId fallback subtree uses attribute-dispatch (meta.http.dispatch = {kind:"method"}):
//   read    → GET  /books/{bookId}
//   replace → PUT  /books/{bookId}
//   remove  → DELETE /books/{bookId}
// MCP/CLI keep the agnostic child names; only HTTP changes (path assignment).

import { beforeEach, describe, expect, expectTypeOf, it } from "bun:test"
import { api, clearStore, type Book } from "../../../examples/library-api/src/tree.ts"
import { httpProjection } from "./dx.ts"
import { createFetch } from "./preset.ts"
import { createClient, createClientFromRoute } from "./client.ts"
import { ClientError } from "./client-error.ts"
import type { CallOptions } from "./client.ts"

// In-process fetch handler — the server-side stack for round-trip tests
const serverFetch = createFetch(api)

function makeClient() {
  return createClient(api, { baseUrl: "http://localhost", fetch: serverFetch })
}

beforeEach(() => {
  clearStore()
})

// ============================================================================
// 1. ReadOnly op round-trip
// ============================================================================

describe("readOnly op round-trip", () => {
  it("catalog search returns empty list when store is empty", async () => {
    const client = makeClient()
    const result = await client.catalog.search({ q: "anything" }) as unknown[]
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })

  it("books list returns all added books", async () => {
    const client = makeClient()
    // Add two books via client
    await client.books.add({ title: "Refactoring", author: "Fowler", genre: "Engineering" })
    await client.books.add({ title: "SICP", author: "Abelson", genre: "CS" })
    const books = await client.books.list() as Array<{ title: string }>
    expect(books).toHaveLength(2)
    const titles = books.map((b) => b.title)
    expect(titles).toContain("Refactoring")
    expect(titles).toContain("SICP")
  })
})

// ============================================================================
// 2. fallback + attribute-dispatch round-trip: create then fetch by id
// ============================================================================

describe("fallback round-trip", () => {
  it("add a book then fetch by id via bookId(id).read()", async () => {
    const client = makeClient()
    const created = await client.books.add({
      title: "The Pragmatic Programmer",
      author: "Hunt & Thomas",
      genre: "Engineering",
    }) as { id: string; title: string; author: string; genre: string }

    expect(typeof created.id).toBe("string")

    const fetched = await client.books.bookId(created.id).read() as typeof created
    expect(fetched.id).toBe(created.id)
    expect(fetched.title).toBe("The Pragmatic Programmer")
    expect(fetched.author).toBe("Hunt & Thomas")
    expect(fetched.genre).toBe("Engineering")
  })

  it("value survives the round-trip intact (all fields)", async () => {
    const client = makeClient()
    const input = { title: "Clean Code", author: "Robert Martin", genre: "Engineering" }
    const created = await client.books.add(input) as { id: string } & typeof input
    const fetched = await client.books.bookId(created.id).read() as typeof created
    expect(fetched).toMatchObject(input)
  })
})

// ============================================================================
// 3. Mutating ops work through the client
// ============================================================================

describe("mutating ops", () => {
  it("replace op changes book fields and returns updated value", async () => {
    const client = makeClient()
    const created = await client.books.add({
      title: "Original Title",
      author: "Author",
      genre: "Fiction",
    }) as { id: string; title: string }

    const updated = await client.books.bookId(created.id).replace({
      title: "New Title",
    }) as { id: string; title: string }

    expect(updated.title).toBe("New Title")
    expect(updated.id).toBe(created.id)

    // Verify it persisted
    const fetched = await client.books.bookId(created.id).read() as { title: string }
    expect(fetched.title).toBe("New Title")
  })

  it("remove op deletes the book", async () => {
    const client = makeClient()
    const created = await client.books.add({
      title: "Disposable",
      author: "Nobody",
      genre: "Misc",
    }) as { id: string }

    const result = await client.books.bookId(created.id).remove() as { deleted: boolean }
    expect(result.deleted).toBe(true)

    // The book should no longer be in the list
    const books = await client.books.list() as Array<{ id: string }>
    expect(books.find((b) => b.id === created.id)).toBeUndefined()
  })
})

// ============================================================================
// 4. ClientError on non-2xx
// ============================================================================

describe("ClientError", () => {
  it("throws ClientError with status when fetching non-existent book", async () => {
    const client = makeClient()
    let caught: unknown
    try {
      await client.books.bookId("does-not-exist").read()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ClientError)
    expect((caught as ClientError).status).toBe(500)
  })
})

// ============================================================================
// 5. Verb-correctness spy: confirm method+path match the server's route table
// ============================================================================

describe("verb-correctness spy", () => {
  it("each op fires the exact verb+path the server tree-walk dispatch expects", async () => {
    type CallRecord = { method: string; pathname: string }
    const calls: CallRecord[] = []

    // Spy wraps the real server fetch, recording method+pathname before dispatch
    const spyFetch = async (req: Request): Promise<Response> => {
      calls.push({
        method: req.method,
        pathname: new URL(req.url).pathname,
      })
      return serverFetch(req)
    }

    const client = createClient(api, { baseUrl: "http://localhost", fetch: spyFetch })

    // Add a book so we have an id for fallback routes
    const book = await client.books.add({
      title: "Spy Target",
      author: "Test",
      genre: "Test",
    }) as { id: string }

    // Clear and replay targeted calls
    calls.length = 0

    await client.books.list()
    await client.books.bookId(book.id).read()
    await client.books.bookId(book.id).replace({ title: "Updated" })
    await client.catalog.search({ q: "spy" })

    // books.list → GET /books/list
    expect(calls[0]).toMatchObject({
      method: "GET",
      pathname: "/books/list",
    })
    // books.bookId.read → GET /books/{bookId}  (attribute-dispatch)
    expect(calls[1]).toMatchObject({
      method: "GET",
      pathname: `/books/${book.id}`,
    })
    // books.bookId.replace → PUT /books/{bookId}  (attribute-dispatch)
    expect(calls[2]).toMatchObject({
      method: "PUT",
      pathname: `/books/${book.id}`,
    })
    // catalog.search → GET /catalog/search
    expect(calls[3]).toMatchObject({
      method: "GET",
      pathname: "/catalog/search",
    })
  })
})

// ============================================================================
// 6. createClientFromRoute — core entry point, no Node available
//
// Same path/verb correctness as createClient, but co-located operations
// (read/replace/remove, all placed onto the same fallback position by
// applyMoveTo) degrade to their lowercased HTTP verb as the client member
// name, since a bare HttpRoute has no memory of the authored Node child key.
// ============================================================================

describe("createClientFromRoute", () => {
  it("plain (non-co-located) ops keep working identically to createClient", async () => {
    const route = httpProjection(api)
    const client = createClientFromRoute(route, { baseUrl: "http://localhost", fetch: createFetch(api) })

    await client.books.add({ title: "Route Test", author: "Someone", genre: "Test" })
    const books = await client.books.list() as Array<{ title: string }>
    expect(books.map((b) => b.title)).toContain("Route Test")
  })

  it("co-located methods degrade to lowercased verb names (.get/.put/.delete)", async () => {
    const route = httpProjection(api)
    const serverFetch = createFetch(api)
    const client = createClientFromRoute(route, { baseUrl: "http://localhost", fetch: serverFetch })

    const created = await client.books.add({
      title: "Verb Named",
      author: "Someone",
      genre: "Test",
    }) as { id: string }

    const sub = client.books.bookId(created.id) as Record<string, unknown>
    expect(typeof sub.get).toBe("function")
    expect(typeof sub.put).toBe("function")
    expect(typeof sub.delete).toBe("function")
    expect(sub.read).toBeUndefined()

    const fetched = await (sub.get as () => Promise<{ title: string }>)()
    expect(fetched.title).toBe("Verb Named")
  })
})

// ============================================================================
// 7. timeout / AbortSignal support
//
// `slowFetch` mimics real WHATWG `fetch`'s abort contract: it never settles
// on its own, and rejects with `req.signal.reason` the moment the request's
// signal aborts — exactly what the platform `fetch` does, so these tests
// exercise the same `describeAbort` path a real network timeout would hit.
// ============================================================================

function makeSlowFetch(): (req: Request) => Promise<Response> {
  return (req: Request) =>
    new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => resolve(new Response("ok")), 5000)
      req.signal.addEventListener("abort", () => {
        clearTimeout(t)
        reject(req.signal.reason)
      })
    })
}

describe("timeout / AbortSignal support", () => {
  it("a client-level timeout aborts a hanging request and throws a timeout-specific error", async () => {
    const client = createClient(api, { baseUrl: "http://localhost", fetch: makeSlowFetch(), timeout: 20 })
    await expect(client.books.list()).rejects.toThrow(/timed out/i)
  })

  it("a per-call timeout override aborts a hanging request", async () => {
    const client = createClient(api, { baseUrl: "http://localhost", fetch: makeSlowFetch() })
    await expect(client.books.list(undefined, { timeout: 20 })).rejects.toThrow(/timed out/i)
  })

  it("a user AbortSignal cancels the request and throws a cancellation-specific error", async () => {
    const controller = new AbortController()
    const client = createClient(api, {
      baseUrl: "http://localhost",
      fetch: makeSlowFetch(),
      signal: controller.signal,
    })
    const pending = client.books.list()
    queueMicrotask(() => controller.abort())
    await expect(pending).rejects.toThrow(/aborted/i)
  })

  it("a per-call AbortSignal override cancels the request", async () => {
    const controller = new AbortController()
    const client = createClient(api, { baseUrl: "http://localhost", fetch: makeSlowFetch() })
    const pending = client.books.list(undefined, { signal: controller.signal })
    queueMicrotask(() => controller.abort())
    await expect(pending).rejects.toThrow(/aborted/i)
  })

  it("no timeout/signal set: existing behavior is unchanged", async () => {
    const client = makeClient()
    const result = (await client.catalog.search({ q: "anything" })) as unknown[]
    expect(Array.isArray(result)).toBe(true)
  })
})

// ============================================================================
// 8. createClient's return type — TypedClient<N, CallOptions>
//
// `createClient` used to return `AnyClient` (`Record<string, any>`); it now
// returns `TypedClient<typeof api, CallOptions>` (packages/api-tree/src/typed-client.ts),
// computed structurally from the library-api tree's own type. These are
// type-only checks — `expectTypeOf` never runs the assertions, the type
// checker evaluates them. Mirrors direct.test.ts's "DirectApi type safety"
// block for the in-process analogue.
// ============================================================================

describe("createClient — TypedClient return type", () => {
  it("a plain (non-fallback, no-input) leaf's input arg is optional; CallOptions is the second arg", () => {
    const client = makeClient()
    expectTypeOf(client.books.list).toEqualTypeOf<
      (input?: undefined, opts?: CallOptions) => Promise<Book[]>
    >()
  })

  it("a leaf with a real input type keeps it, plus the CallOptions second arg", () => {
    const client = makeClient()
    expectTypeOf(client.catalog.search).toEqualTypeOf<
      (input: { q?: string }, opts?: CallOptions) => Promise<Book[]>
    >()
  })

  it("a fallback-gated leaf subtracts the captured slug (bookId) from its input", () => {
    const client = makeClient()
    expectTypeOf(client.books.bookId).toEqualTypeOf<
      (slugValue: string) => ReturnType<typeof client.books.bookId>
    >()
    const sub = client.books.bookId("some-id")
    // bookId is slug-subtracted — read takes no input beyond CallOptions
    expectTypeOf(sub.read).toEqualTypeOf<
      (input?: undefined, opts?: CallOptions) => Promise<Book>
    >()
    // replace keeps its other (non-slug) optional fields
    expectTypeOf(sub.replace).toEqualTypeOf<
      (
        input: { title?: string; author?: string; genre?: string },
        opts?: CallOptions,
      ) => Promise<Book>
    >()
  })
})
