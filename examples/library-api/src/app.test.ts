// examples/library-api/src/app.test.ts
//
// End-to-end tests for the library-api on the new fractal model.
// Exercises the whole stack: HTTP (createFetch) + MCP (toTools) + codegen
// (extractToolSchemas). Each assertion proves a specific new-model invariant.
//
// The byId subtree uses attribute-dispatch (meta.http.dispatch === "method"):
//   read    → GET  /books/{bookId}
//   replace → PUT  /books/{bookId}
//   remove  → DELETE /books/{bookId}
// CLI/MCP name these by their agnostic child keys (read, replace, remove).

import { beforeEach, describe, expect, it } from "bun:test"
import { api, clearStore } from "./tree.ts"
import { createFetch } from "@rhi-zone/fractal-http/preset"
import { buildRoutes } from "@rhi-zone/fractal-http/project"
import { toTools } from "@rhi-zone/fractal-mcp"
import { extractToolSchemas } from "@rhi-zone/fractal-codegen"

// Codegen reads the tree source directly
const treePath = new URL("./tree.ts", import.meta.url).pathname

const fetch = createFetch(api)

function jsonReq(method: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method,
    ...(body !== undefined
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  })
}

// ============================================================================
// HTTP projection
// ============================================================================

describe("library-api — HTTP routes", () => {
  beforeEach(() => {
    clearStore()
  })

  it("readOnly op (books list) → GET route", () => {
    const routes = buildRoutes(api)
    const r = routes.find((r) => r.path === "/books/list")
    expect(r?.verb).toBe("GET")
  })

  it("attribute-dispatch: read → GET /books/{bookId}", () => {
    const routes = buildRoutes(api)
    const r = routes.find((r) => r.path === "/books/{bookId}" && r.verb === "GET")
    expect(r).toBeDefined()
  })

  it("attribute-dispatch: replace → PUT /books/{bookId}", () => {
    const routes = buildRoutes(api)
    const r = routes.find((r) => r.path === "/books/{bookId}" && r.verb === "PUT")
    expect(r).toBeDefined()
  })

  it("attribute-dispatch: remove → DELETE /books/{bookId}", () => {
    const routes = buildRoutes(api)
    const r = routes.find((r) => r.path === "/books/{bookId}" && r.verb === "DELETE")
    expect(r).toBeDefined()
  })

  it("attribute-dispatch: 3 distinct verbs at the same /books/{bookId} path", () => {
    const routes = buildRoutes(api)
    const byIdRoutes = routes.filter((r) => r.path === "/books/{bookId}")
    expect(byIdRoutes).toHaveLength(3)
    const verbs = new Set(byIdRoutes.map((r) => r.verb))
    expect(verbs).toEqual(new Set(["GET", "PUT", "DELETE"]))
  })

  it("checkout branch child under method-dispatch node → segment-dispatched", () => {
    const routes = buildRoutes(api)
    // checkout is a branch, not a leaf — its leaf 'start' gets a segment
    const r = routes.find((r) => r.path === "/books/{bookId}/checkout/start")
    expect(r).toBeDefined()
  })

  it("catalog ops inherit readOnly from node level → GET routes", () => {
    const routes = buildRoutes(api)
    expect(routes.find((r) => r.path === "/catalog/search")?.verb).toBe("GET")
    expect(routes.find((r) => r.path === "/catalog/genres")?.verb).toBe("GET")
  })

  it("param slug (bookId) threads into handler input provenance-blind", async () => {
    // Add a book; capture its generated ID
    const addRes = await fetch(
      jsonReq("POST", "http://localhost/books/add", {
        title: "The Pragmatic Programmer",
        author: "Hunt & Thomas",
        genre: "Engineering",
      }),
    )
    expect(addRes.status).toBe(200)
    const book = (await addRes.json()) as { id: string }

    // GET /books/{id} — attribute-dispatch REST read
    const readRes = await fetch(
      new Request(`http://localhost/books/${book.id}`),
    )
    expect(readRes.status).toBe(200)
    const details = (await readRes.json()) as { id: string; title: string }
    expect(details.id).toBe(book.id)
    expect(details.title).toBe("The Pragmatic Programmer")
  })

  it("DELETE /books/{id} → deletes the book", async () => {
    const addRes = await fetch(
      jsonReq("POST", "http://localhost/books/add", {
        title: "Clean Code",
        author: "Robert Martin",
        genre: "Engineering",
      }),
    )
    const { id } = (await addRes.json()) as { id: string }

    const delRes = await fetch(
      new Request(`http://localhost/books/${id}`, { method: "DELETE" }),
    )
    expect(delRes.status).toBe(200)
    const body = (await delRes.json()) as { deleted: boolean }
    expect(body.deleted).toBe(true)
  })

  it("auto-method: OPTIONS → 204 + Allow header", async () => {
    const res = await fetch(
      new Request("http://localhost/books/list", { method: "OPTIONS" }),
    )
    expect(res.status).toBe(204)
    const allow = res.headers.get("Allow")
    expect(allow).toContain("GET")
    expect(allow).toContain("OPTIONS")
  })

  it("auto-method: HEAD from GET → 200, no body", async () => {
    const res = await fetch(
      new Request("http://localhost/catalog/search", { method: "HEAD" }),
    )
    expect(res.status).toBe(200)
    expect(res.body).toBeNull()
  })

  it("auto-method: wrong method → 405 + Allow", async () => {
    const res = await fetch(
      new Request("http://localhost/catalog/search", { method: "DELETE" }),
    )
    expect(res.status).toBe(405)
    expect(res.headers.get("Allow")).toContain("GET")
  })
})

// ============================================================================
// MCP projection
// ============================================================================

describe("library-api — MCP tools", () => {
  it("readOnly op (books_list) → readOnlyHint: true", () => {
    const tools = toTools(api)
    const t = tools.find((t) => t.name === "books_list")
    expect(t?.annotations?.readOnlyHint).toBe(true)
  })

  it("destructive op (books_bookId_remove) → destructiveHint: true", () => {
    const tools = toTools(api)
    const t = tools.find((t) => t.name === "books_bookId_remove")
    expect(t?.annotations?.destructiveHint).toBe(true)
  })

  it("idempotent op (books_bookId_replace) → idempotentHint: true", () => {
    const tools = toTools(api)
    const t = tools.find((t) => t.name === "books_bookId_replace")
    expect(t?.annotations?.idempotentHint).toBe(true)
  })

  it("readOnly op (books_bookId_read) → readOnlyHint: true", () => {
    const tools = toTools(api)
    const t = tools.find((t) => t.name === "books_bookId_read")
    expect(t?.annotations?.readOnlyHint).toBe(true)
  })

  it("node-level readOnly inheritance: catalog_search → readOnlyHint: true", () => {
    const tools = toTools(api)
    // search op has no meta.tags of its own; readOnly comes from catalog node
    const t = tools.find((t) => t.name === "catalog_search")
    expect(t?.annotations?.readOnlyHint).toBe(true)
  })

  it("node-level readOnly inheritance: catalog_genres → readOnlyHint: true", () => {
    const tools = toTools(api)
    // genres op has no meta.tags of its own; readOnly comes from catalog node
    const t = tools.find((t) => t.name === "catalog_genres")
    expect(t?.annotations?.readOnlyHint).toBe(true)
  })

  it("catalog_search has real codegen-derived inputSchema (not placeholder)", () => {
    const schemas = extractToolSchemas(treePath)
    const tools = toTools(api, { schemas })
    const t = tools.find((t) => t.name === "catalog_search")
    // Real schema has properties.q; the placeholder { type: "object" } does not
    expect(t?.inputSchema).toMatchObject({
      type: "object",
      properties: { q: { type: "string" } },
    })
  })

  it("catalog_genres has real codegen-derived inputSchema (not placeholder)", () => {
    const schemas = extractToolSchemas(treePath)
    const tools = toTools(api, { schemas })
    const t = tools.find((t) => t.name === "catalog_genres")
    // Real schema has properties.prefix
    expect(t?.inputSchema).toMatchObject({
      type: "object",
      properties: { prefix: { type: "string" } },
    })
  })
})
