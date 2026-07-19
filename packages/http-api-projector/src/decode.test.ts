// packages/http-api-projector/src/decode.test.ts — stores-based input extraction tests

import { describe, expect, it } from "bun:test"
import { api, op } from "@rhi-zone/fractal-api-tree/node"
import { makeRouter, toHttpRoutes } from "./project.ts"
import { applyMethods, applyMoveTo, composeTransforms, httpRoute } from "./route.ts"
import { assemble, httpStores, primaryStoreForMethod } from "./decode.ts"

// ============================================================================
// Unit tests — stores, assembler, conventions
// ============================================================================

describe("primaryStoreForMethod", () => {
  it("GET → query", () => expect(primaryStoreForMethod("GET")).toBe("query"))
  it("HEAD → query", () => expect(primaryStoreForMethod("HEAD")).toBe("query"))
  it("DELETE → query", () => expect(primaryStoreForMethod("DELETE")).toBe("query"))
  it("POST → body", () => expect(primaryStoreForMethod("POST")).toBe("body"))
  it("PUT → body", () => expect(primaryStoreForMethod("PUT")).toBe("body"))
  it("PATCH → body", () => expect(primaryStoreForMethod("PATCH")).toBe("body"))
})

describe("httpStores", () => {
  it("path store returns slug values by key", () => {
    const req = new Request("http://localhost/books/book-1")
    const stores = httpStores(req, { bookId: "book-1" }, undefined)
    expect(stores.path!.bookId).toBe("book-1")
    expect(stores.path!.missing).toBeUndefined()
  })

  it("query store returns query params by key", () => {
    const req = new Request("http://localhost/search?q=dune&limit=10")
    const stores = httpStores(req, {}, undefined)
    expect(stores.query!.q).toBe("dune")
    expect(stores.query!.limit).toBe("10")
    // URLSearchParams.get() returns null (not undefined) for a missing key,
    // and the shared mapLikeHandler proxy is a thin pass-through to .get() —
    // it doesn't coerce null to undefined.
    expect(stores.query!.missing).toBeNull()
  })

  it("query store is a lazily-constructed, memoized Proxy", () => {
    const req = new Request("http://localhost/search?q=dune")
    const stores = httpStores(req, {}, undefined)
    const first = stores.query
    const second = stores.query
    expect(first).toBe(second)
  })

  it("header store returns headers by key (case-insensitive)", () => {
    const req = new Request("http://localhost/", {
      headers: { "X-Api-Key": "secret-123", "Content-Type": "application/json" },
    })
    const stores = httpStores(req, {}, undefined)
    expect(stores.header!["x-api-key"]).toBe("secret-123")
    expect(stores.header!["content-type"]).toBe("application/json")
    // Headers.get() returns null (not undefined) for a missing key, same
    // pass-through reasoning as the query store above.
    expect(stores.header!.missing).toBeNull()
  })

  it("body store returns fields from parsed body object", () => {
    const req = new Request("http://localhost/")
    const stores = httpStores(req, {}, { title: "Dune", author: "Herbert" })
    expect(stores.body!.title).toBe("Dune")
    expect(stores.body!.author).toBe("Herbert")
    expect(stores.body!.missing).toBeUndefined()
  })

  it("body store returns undefined when body is not an object", () => {
    const req = new Request("http://localhost/")
    const stores = httpStores(req, {}, null)
    expect(stores.body!.anything).toBeUndefined()
  })
})

describe("assemble", () => {
  it("reads path params from the path store", () => {
    const req = new Request("http://localhost/books/book-1?q=test")
    const stores = httpStores(req, { bookId: "book-1" }, undefined)
    const result = assemble(stores, ["bookId", "q"], {}, "query", ["bookId"])
    expect(result).toEqual({ bookId: "book-1", q: "test" })
  })

  it("reads non-path params from the primary store", () => {
    const req = new Request("http://localhost/search?q=dune&page=2")
    const stores = httpStores(req, {}, undefined)
    const result = assemble(stores, ["q", "page"], {}, "query", [])
    expect(result).toEqual({ q: "dune", page: "2" })
  })

  it("respects per-param source overrides", () => {
    const req = new Request("http://localhost/items", {
      headers: { "x-api-key": "my-key" },
    })
    const stores = httpStores(req, {}, { title: "hello" })
    const result = assemble(
      stores,
      ["title", "apiKey"],
      { apiKey: { store: "header", key: "x-api-key" } },
      "body",
      [],
    )
    expect(result).toEqual({ title: "hello", apiKey: "my-key" })
  })

  it("source override defaults key to param name when key is omitted", () => {
    const req = new Request("http://localhost/", {
      headers: { "x-request-id": "abc" },
    })
    const stores = httpStores(req, {}, undefined)
    const result = assemble(
      stores,
      ["x-request-id"],
      { "x-request-id": { store: "header" } },
      "query",
      [],
    )
    expect(result).toEqual({ "x-request-id": "abc" })
  })
})

// ============================================================================
// Integration tests — through the router pipeline
// ============================================================================

describe("stores-based decode — default behavior through the router", () => {
  it("GET request reads params from query string (backward compat)", async () => {
    let capturedInput: unknown
    const route = httpRoute({
      methods: {
        GET: {
          handler: (input: unknown) => { capturedInput = input; return {} },
          meta: {},
        },
      },
      meta: {},
    })
    const router = makeRouter(route)
    await router(new Request("http://localhost/?q=dune&limit=5"))
    expect(capturedInput).toEqual({ q: "dune", limit: "5" })
  })

  it("POST request reads params from JSON body (backward compat)", async () => {
    let capturedInput: unknown
    const route = httpRoute({
      methods: {
        POST: {
          handler: (input: unknown) => { capturedInput = input; return {} },
          meta: {},
        },
      },
      meta: {},
    })
    const router = makeRouter(route)
    await router(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Dune", author: "Herbert" }),
    }))
    expect(capturedInput).toEqual({ title: "Dune", author: "Herbert" })
  })

  it("path slugs merge into input for all methods", async () => {
    let capturedInput: unknown
    const route = httpRoute({
      children: {
        items: httpRoute({
          fallback: {
            name: "itemId",
            subtree: httpRoute({
              methods: {
                GET: {
                  handler: (input: unknown) => { capturedInput = input; return {} },
                  meta: {},
                },
              },
              meta: {},
            }),
          },
          meta: {},
        }),
      },
      meta: {},
    })
    const router = makeRouter(route)
    await router(new Request("http://localhost/items/item-42?extra=yes"))
    expect(capturedInput).toEqual({ itemId: "item-42", extra: "yes" })
  })
})

describe("stores-based decode — per-param source override via sources", () => {
  it("reads a specific param from the header store", async () => {
    let capturedInput: unknown
    const route = httpRoute({
      methods: {
        POST: {
          handler: (input: unknown) => { capturedInput = input; return {} },
          meta: {},
          sources: {
            paramNames: ["title", "apiKey"],
            sourceMap: { apiKey: { store: "header", key: "x-api-key" } },
          },
        },
      },
      meta: {},
    })
    const router = makeRouter(route)
    await router(new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "secret-123",
      },
      body: JSON.stringify({ title: "Dune" }),
    }))
    expect(capturedInput).toEqual({ title: "Dune", apiKey: "secret-123" })
  })

  it("path params identified by slug names, rest from primary store", async () => {
    let capturedInput: unknown
    const route = httpRoute({
      children: {
        books: httpRoute({
          fallback: {
            name: "bookId",
            subtree: httpRoute({
              methods: {
                GET: {
                  handler: (input: unknown) => { capturedInput = input; return {} },
                  meta: {},
                  sources: { paramNames: ["bookId", "q"] },
                },
              },
              meta: {},
            }),
          },
          meta: {},
        }),
      },
      meta: {},
    })
    const router = makeRouter(route)
    await router(new Request("http://localhost/books/book-7?q=chapters"))
    expect(capturedInput).toEqual({ bookId: "book-7", q: "chapters" })
  })
})

describe("stores-based decode — optional transform", () => {
  it("runs the transform after assembly, before the handler", async () => {
    let capturedInput: unknown
    const route = httpRoute({
      methods: {
        GET: {
          handler: (input: unknown) => { capturedInput = input; return {} },
          meta: {},
          sources: { transform: (bag) => ({ ...bag, injected: true }) },
        },
      },
      meta: {},
    })
    const router = makeRouter(route)
    await router(new Request("http://localhost/?name=Alice"))
    expect(capturedInput).toEqual({ name: "Alice", injected: true })
  })
})
