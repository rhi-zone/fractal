// packages/http/src/decode.test.ts — stores-based input extraction tests

import { describe, expect, it } from "bun:test"
import { api, op } from "@rhi-zone/fractal-core/node"
import { makeRouter, toHttpRoutes } from "./project.ts"
import { applyMethods, applyMoveTo, composeTransforms, httpRoute } from "./route.ts"
import type { Pipeline } from "./route.ts"
import { assemble, bulkCollect, httpStores, primaryStoreForMethod } from "./decode.ts"

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
    expect(stores.path.get("bookId")).toBe("book-1")
    expect(stores.path.get("missing")).toBeUndefined()
  })

  it("query store returns query params by key", () => {
    const req = new Request("http://localhost/search?q=dune&limit=10")
    const stores = httpStores(req, {}, undefined)
    expect(stores.query.get("q")).toBe("dune")
    expect(stores.query.get("limit")).toBe("10")
    expect(stores.query.get("missing")).toBeUndefined()
  })

  it("header store returns headers by key (case-insensitive)", () => {
    const req = new Request("http://localhost/", {
      headers: { "X-Api-Key": "secret-123", "Content-Type": "application/json" },
    })
    const stores = httpStores(req, {}, undefined)
    expect(stores.header.get("x-api-key")).toBe("secret-123")
    expect(stores.header.get("content-type")).toBe("application/json")
    expect(stores.header.get("missing")).toBeUndefined()
  })

  it("body store returns fields from parsed body object", () => {
    const req = new Request("http://localhost/")
    const stores = httpStores(req, {}, { title: "Dune", author: "Herbert" })
    expect(stores.body.get("title")).toBe("Dune")
    expect(stores.body.get("author")).toBe("Herbert")
    expect(stores.body.get("missing")).toBeUndefined()
  })

  it("body store returns undefined when body is not an object", () => {
    const req = new Request("http://localhost/")
    const stores = httpStores(req, {}, null)
    expect(stores.body.get("anything")).toBeUndefined()
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

describe("bulkCollect", () => {
  it("merges slugs + query for query-primary methods", () => {
    const params = new URLSearchParams("q=test&page=1")
    const result = bulkCollect({ bookId: "b-1" }, params, undefined, "query")
    expect(result).toEqual({ bookId: "b-1", q: "test", page: "1" })
  })

  it("merges slugs + query + body for body-primary methods", () => {
    const params = new URLSearchParams("extra=yes")
    const result = bulkCollect({ id: "x" }, params, { title: "Dune" }, "body")
    expect(result).toEqual({ id: "x", extra: "yes", title: "Dune" })
  })

  it("body fields override query fields on collision (body-primary)", () => {
    const params = new URLSearchParams("title=from-query")
    const result = bulkCollect({}, params, { title: "from-body" }, "body")
    expect(result).toEqual({ title: "from-body" })
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

describe("stores-based decode — per-param source override via pipeline.sources", () => {
  it("reads a specific param from the header store", async () => {
    let capturedInput: unknown
    const pipeline: Pipeline = {
      sources: {
        paramNames: ["title", "apiKey"],
        sourceMap: { apiKey: { store: "header", key: "x-api-key" } },
      },
    }
    const route = httpRoute({
      methods: {
        POST: {
          handler: (input: unknown) => { capturedInput = input; return {} },
          meta: {},
          pipeline,
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
    const pipeline: Pipeline = {
      sources: {
        paramNames: ["bookId", "q"],
      },
    }
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
                  pipeline,
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
    const pipeline: Pipeline = {
      sources: {
        transform: (bag) => ({ ...bag, injected: true }),
      },
    }
    const route = httpRoute({
      methods: {
        GET: {
          handler: (input: unknown) => { capturedInput = input; return {} },
          meta: {},
          pipeline,
        },
      },
      meta: {},
    })
    const router = makeRouter(route)
    await router(new Request("http://localhost/?name=Alice"))
    expect(capturedInput).toEqual({ name: "Alice", injected: true })
  })
})

describe("stores-based decode — interaction with existing pipeline", () => {
  it("inputTransforms still run after stores-based decode", async () => {
    let capturedInput: unknown
    const pipeline: Pipeline = {
      sources: {
        paramNames: ["name"],
      },
      inputTransforms: [
        (input) => ({ ...(input as Record<string, unknown>), fromTransform: true }),
      ],
    }
    const route = httpRoute({
      methods: {
        GET: {
          handler: (input: unknown) => { capturedInput = input; return {} },
          meta: {},
          pipeline,
        },
      },
      meta: {},
    })
    const router = makeRouter(route)
    await router(new Request("http://localhost/?name=Bob"))
    expect(capturedInput).toEqual({ name: "Bob", fromTransform: true })
  })

  it("custom decode function still wins over stores config", async () => {
    let capturedInput: unknown
    const pipeline: Pipeline = {
      decode: () => ({ custom: true }),
      sources: { paramNames: ["ignored"] },
    }
    const route = httpRoute({
      methods: {
        GET: {
          handler: (input: unknown) => { capturedInput = input; return {} },
          meta: {},
          pipeline,
        },
      },
      meta: {},
    })
    const router = makeRouter(route)
    await router(new Request("http://localhost/?name=Alice"))
    expect(capturedInput).toEqual({ custom: true })
  })
})
