// examples/library-api/src/client.test.ts
//
// End-to-end proof that the codegen'd standalone client (src/client.generated.ts,
// produced by scripts/generate-client.ts from tree.ts) actually works against a
// real live HTTP server — not just createFetch's in-process Request/Response
// round-trip that app.test.ts exercises, but a real Bun.serve listener reached
// over a real `fetch()` with an absolute baseUrl. Regenerate the client with
// `bun run codegen:client` before running this test if tree.ts's shape changed.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { serveBun } from "@rhi-zone/fractal-http-api-projector/adapter"
import { createFetch } from "@rhi-zone/fractal-http-api-projector/preset"
import { api, clearStore } from "./tree.ts"
import { createClient } from "./client.generated.ts"
import type { Client } from "./client.generated.ts"

let server: { port: number; stop(closeActiveConnections?: boolean): void }
let client: Client

beforeAll(() => {
  const fetchHandler = createFetch(api)
  server = serveBun(fetchHandler, { port: 0 })
  client = createClient(`http://localhost:${server.port}`)
})

afterAll(() => {
  server.stop()
})

beforeEach(() => {
  clearStore()
})

describe("library-api — generated client, live server", () => {
  it("add → list round-trip", async () => {
    const added = await client.books.add({
      title: "The Pragmatic Programmer",
      author: "Hunt & Thomas",
      genre: "Engineering",
    })
    expect(added.title).toBe("The Pragmatic Programmer")
    expect(added.id).toMatch(/^book-/)

    const listed = await client.books.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(added.id)
  })

  it("bookId(...).read() fetches a single book by ID, without bookId in the input type", async () => {
    const added = await client.books.add({
      title: "Clean Code",
      author: "Robert Martin",
      genre: "Engineering",
    })

    const read = await client.books.bookId(added.id).read()
    expect(read.id).toBe(added.id)
    expect(read.title).toBe("Clean Code")
  })

  it("bookId(...).replace() updates fields idempotently", async () => {
    const added = await client.books.add({
      title: "Domain-Driven Design",
      author: "Eric Evans",
      genre: "Software",
    })

    const replaced = await client.books.bookId(added.id).replace({ genre: "Architecture" })
    expect(replaced.id).toBe(added.id)
    expect(replaced.title).toBe("Domain-Driven Design")
    expect(replaced.genre).toBe("Architecture")
  })

  it("catalog.search filters by query, with a typed GET input", async () => {
    await client.books.add({ title: "The Hobbit", author: "J.R.R. Tolkien", genre: "Fantasy" })
    await client.books.add({ title: "Dune", author: "Frank Herbert", genre: "Sci-Fi" })

    const results = await client.catalog.search({ q: "hobbit" })
    expect(results).toHaveLength(1)
    expect(results[0]?.title).toBe("The Hobbit")

    const all = await client.catalog.search({})
    expect(all).toHaveLength(2)
  })

  it("bookId(...).remove() deletes the book", async () => {
    const added = await client.books.add({
      title: "Refactoring",
      author: "Martin Fowler",
      genre: "Engineering",
    })

    const removed = await client.books.bookId(added.id).remove()
    expect(removed.deleted).toBe(true)

    const listed = await client.books.list()
    expect(listed).toHaveLength(0)
  })

  it("bookId(...).checkout.start()/reserve() dispatch through the fallback + branch subtree", async () => {
    const added = await client.books.add({
      title: "Effective Java",
      author: "Joshua Bloch",
      genre: "Engineering",
    })

    const started = await client.books.bookId(added.id).checkout.start()
    expect(started.sessionId).toBe(`checkout-${added.id}`)

    const reserved = await client.books.bookId(added.id).checkout.reserve({ patronId: "patron-1" })
    expect(reserved.reservationId).toBe(`res-${added.id}-patron-1`)
    expect(reserved.patronId).toBe("patron-1")
  })
})
