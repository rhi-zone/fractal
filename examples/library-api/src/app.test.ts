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
import { candidatesForUrl } from "@rhi-zone/fractal-http/project"
import { http } from "@rhi-zone/fractal-http/verbs"
import { op } from "@rhi-zone/fractal-core/node"
import { resolveTags } from "@rhi-zone/fractal-core/tags"
import type { Tags } from "@rhi-zone/fractal-core/tags"
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
    const candidates = candidatesForUrl(api, "http://localhost/books/list")
    expect(candidates[0]?.verb).toBe("GET")
  })

  it("attribute-dispatch: read → GET /books/{bookId}", () => {
    const candidates = candidatesForUrl(api, "http://localhost/books/book-1")
    expect(candidates.find((c) => c.verb === "GET")).toBeDefined()
  })

  it("attribute-dispatch: replace → PUT /books/{bookId}", () => {
    const candidates = candidatesForUrl(api, "http://localhost/books/book-1")
    expect(candidates.find((c) => c.verb === "PUT")).toBeDefined()
  })

  it("attribute-dispatch: remove → DELETE /books/{bookId}", () => {
    const candidates = candidatesForUrl(api, "http://localhost/books/book-1")
    expect(candidates.find((c) => c.verb === "DELETE")).toBeDefined()
  })

  it("attribute-dispatch: 3 distinct verbs at the same /books/{bookId} path", () => {
    const candidates = candidatesForUrl(api, "http://localhost/books/book-1")
    expect(candidates).toHaveLength(3)
    const verbs = new Set(candidates.map((c) => c.verb))
    expect(verbs).toEqual(new Set(["GET", "PUT", "DELETE"]))
  })

  it("checkout branch child under method-dispatch node → segment-dispatched", () => {
    // checkout is a branch, not a leaf — its leaf 'start' gets a segment
    const candidates = candidatesForUrl(api, "http://localhost/books/book-1/checkout/start")
    expect(candidates).toHaveLength(1)
  })

  it("catalog ops each carry their own readOnly tag → GET routes", () => {
    expect(candidatesForUrl(api, "http://localhost/catalog/search")[0]?.verb).toBe("GET")
    expect(candidatesForUrl(api, "http://localhost/catalog/genres")[0]?.verb).toBe("GET")
  })

  it("fallback slug (bookId) threads into handler input provenance-blind", async () => {
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

// ============================================================================
// Verb-helper bundles: one helper → HTTP verb AND MCP hint
// ============================================================================

describe("library-api — verb-helper bundles (http.*)", () => {
  // http.put bundle: checkout/reserve op authored with http.put
  it("http.put on reserve: HTTP route is PUT /books/{bookId}/checkout/reserve", () => {
    const candidates = candidatesForUrl(api, "http://localhost/books/book-1/checkout/reserve")
    expect(candidates[0]?.verb).toBe("PUT")
  })

  it("http.put on reserve: MCP tool gets idempotentHint (bundle → MCP for free)", () => {
    const tools = toTools(api)
    const t = tools.find((t) => t.name === "books_bookId_checkout_reserve")
    expect(t?.annotations?.idempotentHint).toBe(true)
  })

  // http.post bundle: checkout/start op authored with http.post
  it("http.post on start: HTTP route is POST /books/{bookId}/checkout/start", () => {
    const candidates = candidatesForUrl(api, "http://localhost/books/book-1/checkout/start")
    expect(candidates[0]?.verb).toBe("POST")
  })

  it("http.post on start: MCP tool has no idempotentHint (plain mutation)", () => {
    const tools = toTools(api)
    const t = tools.find((t) => t.name === "books_bookId_checkout_start")
    // post bundles no idempotent tag — hint should be absent or false
    expect(t?.annotations?.idempotentHint).toBeFalsy()
  })

  // mergeMeta-not-spread proof: op(fn, http.put, { tags: { destructive: false } })
  // keeps idempotent:true from bundle AND applies destructive:false from extra
  it("op(fn, http.put, extra-tags) deep-merges: bundle's idempotent preserved + extra applied", () => {
    const n = op((_: unknown) => {}, http.put, { tags: { destructive: false } })
    const nodeTags = (n.meta.tags ?? {}) as Tags
    const resolved = resolveTags(nodeTags)
    // idempotent:true from http.put bundle is NOT clobbered by the extra contribution
    expect(resolved.idempotent).toBe(true)
    // destructive:false from extra contribution is applied
    expect(resolved.destructive).toBe(false)
    // verb directive from bundle is preserved
    const httpMeta = n.meta.http as { directives: readonly { kind: string; value?: string }[] }
    expect(httpMeta.directives.find((d) => d.kind === "verb")?.value).toBe("PUT")
  })

  // end-to-end: verb-helper-authored reserve op dispatches correctly
  it("PUT /books/{bookId}/checkout/reserve dispatches via verb-helper route", async () => {
    const fetch = createFetch(api)
    const res = await fetch(
      new Request("http://localhost/books/book-1/checkout/reserve", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patronId: "patron-99" }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { reservationId: string; patronId: string }
    expect(body.reservationId).toBe("res-book-1-patron-99")
    expect(body.patronId).toBe("patron-99")
  })
})
