// packages/client/test/client.test.ts — @rhi-zone/fractal-client
//
// Round-trip tests for createClient against the library-api example tree.
// All tests use `fetch: createFetch(api)` for in-process dispatch — no
// network, no server process. The injected fetch goes through the full
// HTTP stack (makeRouter → handler) so verb+path correctness is exercised.
//
// The byId subtree uses attribute-dispatch (meta.http.dispatch === "method"):
//   read    → GET  /books/{bookId}
//   replace → PUT  /books/{bookId}
//   remove  → DELETE /books/{bookId}
// MCP/CLI keep the agnostic child names; only HTTP changes (path assignment).

import { beforeEach, describe, expect, it } from "bun:test"
import { api, clearStore } from "@rhi-zone/fractal-example-library-api/tree"
import { createFetch } from "@rhi-zone/fractal-http/preset"
import { buildRoutes } from "@rhi-zone/fractal-http/project"
import { createClient } from "../src/index.ts"
import { ClientError } from "../src/client-error.ts"

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
// 2. ParamNode + attribute-dispatch round-trip: create then fetch by id
// ============================================================================

describe("ParamNode round-trip", () => {
  it("add a book then fetch by id via byId(id).read()", async () => {
    const client = makeClient()
    const created = await client.books.add({
      title: "The Pragmatic Programmer",
      author: "Hunt & Thomas",
      genre: "Engineering",
    }) as { id: string; title: string; author: string; genre: string }

    expect(typeof created.id).toBe("string")

    const fetched = await client.books.byId(created.id).read() as typeof created
    expect(fetched.id).toBe(created.id)
    expect(fetched.title).toBe("The Pragmatic Programmer")
    expect(fetched.author).toBe("Hunt & Thomas")
    expect(fetched.genre).toBe("Engineering")
  })

  it("value survives the round-trip intact (all fields)", async () => {
    const client = makeClient()
    const input = { title: "Clean Code", author: "Robert Martin", genre: "Engineering" }
    const created = await client.books.add(input) as { id: string } & typeof input
    const fetched = await client.books.byId(created.id).read() as typeof created
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

    const updated = await client.books.byId(created.id).replace({
      title: "New Title",
    }) as { id: string; title: string }

    expect(updated.title).toBe("New Title")
    expect(updated.id).toBe(created.id)

    // Verify it persisted
    const fetched = await client.books.byId(created.id).read() as { title: string }
    expect(fetched.title).toBe("New Title")
  })

  it("remove op deletes the book", async () => {
    const client = makeClient()
    const created = await client.books.add({
      title: "Disposable",
      author: "Nobody",
      genre: "Misc",
    }) as { id: string }

    const result = await client.books.byId(created.id).remove() as { deleted: boolean }
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
      await client.books.byId("does-not-exist").read()
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
  it("each op fires the exact verb+path that buildRoutes emits", async () => {
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

    // Add a book so we have an id for param-node routes
    const book = await client.books.add({
      title: "Spy Target",
      author: "Test",
      genre: "Test",
    }) as { id: string }

    // Clear and replay targeted calls
    calls.length = 0

    await client.books.list()
    await client.books.byId(book.id).read()
    await client.books.byId(book.id).replace({ title: "Updated" })
    await client.catalog.search({ q: "spy" })

    // books.list → GET /books/list
    expect(calls[0]).toMatchObject({
      method: "GET",
      pathname: "/books/list",
    })
    // books.byId.read → GET /books/{bookId}  (attribute-dispatch)
    expect(calls[1]).toMatchObject({
      method: "GET",
      pathname: `/books/${book.id}`,
    })
    // books.byId.replace → PUT /books/{bookId}  (attribute-dispatch)
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
