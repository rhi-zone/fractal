// packages/http/src/project.test.ts — HttpRoute pipeline dispatch tests
//
// Covers what the retired direct tree-walk dispatcher's project.test.ts used
// to cover, ported onto the HttpRoute pipeline (naiveTransform → rewriters →
// makeRouter, see route.ts and docs/design/routing-and-transforms.md):
// path dispatch, method dispatch (via `moveTo`), fallback/wildcard, and
// 405+Allow (via autoMethodLayer). Attribute dispatch (header/query/
// contentType-based routing at the same path+method) and the `legacyPath`
// escape hatch are NOT covered here — they were retired along with the old
// dispatcher and have no equivalent in the HttpRoute pipeline yet; see
// TODO.md "Attribute dispatch is an open design question".

import { describe, expect, it } from "bun:test"
import { api, op, service } from "@rhi-zone/fractal-core/node"
import type { Node } from "@rhi-zone/fractal-core/node"
import { makeRouter, toHttpRoutes, verbFromTags } from "./project.ts"
import { applyMethods, applyMoveTo } from "./route.ts"
import { autoMethodLayer } from "./layers.ts"

function routes(tree: Node) {
  return applyMoveTo(applyMethods(toHttpRoutes(tree)))
}

// ============================================================================
// 1. Path dispatch — tree structure alone determines the address
// ============================================================================

describe("path dispatch — tree structure determines the address", () => {
  it("resolves /invoices/{invoiceId}/checkout from a fallback node", async () => {
    const createCheckoutSession = (_: { invoiceId: string }) => ({
      url: "https://pay.stripe.com/…",
    })
    const tree = api({
        invoices: api({}, { fallback: {
            name: "invoiceId",
            subtree: api({
                checkout: op(createCheckoutSession, {
                  http: { directives: [{ kind: "method", value: "POST" }] },
                }),
              }),
          } }),
      })
    const router = makeRouter(routes(tree))
    const res = await router(
      new Request("http://localhost/invoices/inv-42/checkout", { method: "POST" }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { url: string }
    expect(body.url).toContain("stripe")
  })

  it("uses the static child key as the segment", async () => {
    const tree = api({
        users: api({
            list: op((_: unknown) => [], { http: { directives: [{ kind: "method", value: "GET" }] } }),
          }),
      })
    const router = makeRouter(routes(tree))
    expect((await router(new Request("http://localhost/users/list"))).status).toBe(200)
    expect((await router(new Request("http://localhost/users/other"))).status).toBe(404)
  })

  it("uses a `moveTo` directive to rename a leaf's path segment", async () => {
    const tree = api({
        progressNode: api({
            awardProgress: op((_: unknown) => ({}), {
              http: { directives: [{ kind: "moveTo", path: "../../progress/award" }] },
            }),
          }),
      })
    const router = makeRouter(routes(tree))
    const res = await router(new Request("http://localhost/progress/award", { method: "POST" }))
    expect(res.status).toBe(200)
  })

  it("collects leaves from multiple children", async () => {
    const tree = api({
        users: api({ list: op((_: unknown) => [], { http: { directives: [{ kind: "method", value: "GET" }] } }) }),
        orders: api({ list: op((_: unknown) => [], { http: { directives: [{ kind: "method", value: "GET" }] } }) }),
      })
    const router = makeRouter(routes(tree))
    expect((await router(new Request("http://localhost/users/list"))).status).toBe(200)
    expect((await router(new Request("http://localhost/orders/list"))).status).toBe(200)
  })

  it("service() surface resolves identically to api()", async () => {
    class Svc {
      listItems(_: unknown) {
        return []
      }
    }
    const tree = service(new Svc(), {
      meta: { listItems: { http: { directives: [{ kind: "method", value: "GET" }] } } },
    })
    const router = makeRouter(routes(tree))
    const res = await router(new Request("http://localhost/listItems"))
    expect(res.status).toBe(200)
  })
})

// ============================================================================
// 2. Verb from three-valued tag lattice (verbFromTags — retained utility,
// used by verb-helper bundles, openapi, and client; NOT consulted by
// applyMethods, which reads only explicit `{kind:"method"}` directives)
// ============================================================================

describe("verbFromTags — three-valued dispatch", () => {
  it("readOnly = true → GET", () => {
    expect(verbFromTags({ tags: { readOnly: true } })).toBe("GET")
  })

  it("idempotent = true + destructive = true → DELETE", () => {
    expect(verbFromTags({ tags: { idempotent: true, destructive: true } })).toBe("DELETE")
  })

  it("idempotent = true + destructive = false → PUT", () => {
    expect(verbFromTags({ tags: { idempotent: true, destructive: false } })).toBe("PUT")
  })

  it("idempotent = true + destructive = undefined → PUT (unknown ≠ explicitly destructive)", () => {
    expect(verbFromTags({ tags: { idempotent: true } })).toBe("PUT")
  })

  it("no tags → POST (conservative default)", () => {
    expect(verbFromTags({})).toBe("POST")
  })

  it("idempotent = false → POST (explicit false)", () => {
    expect(verbFromTags({ tags: { idempotent: false } })).toBe("POST")
  })

  it("idempotent = undefined → POST (unknown is conservative)", () => {
    expect(verbFromTags({ tags: { destructive: true } })).toBe("POST")
  })

  it("meta.http verb directive wins over all tags", () => {
    expect(
      verbFromTags({ tags: { readOnly: true }, http: { directives: [{ kind: "verb", value: "POST" }] } }),
    ).toBe("POST")
  })

  it("meta.http verb directive is uppercased", () => {
    expect(verbFromTags({ http: { directives: [{ kind: "verb", value: "delete" }] } })).toBe("DELETE")
  })

  it("readOnly = true implies idempotent (lattice: safe ⇒ idempotent)", () => {
    expect(verbFromTags({ tags: { readOnly: true, idempotent: false } })).toBe("GET")
  })
})

// ============================================================================
// 3. makeRouter — core dispatch (no auto-method layer)
// ============================================================================

describe("makeRouter — core router (no auto-method layer)", () => {
  const getUser = (_: unknown) => ({ id: 1, name: "Alice" })
  const tree = api({
      getUser: op(getUser, { http: { directives: [{ kind: "method", value: "GET" }, { kind: "moveTo", path: "../user" }] } }),
    })
  const router = makeRouter(routes(tree))

  it("dispatches an exact GET match → 200", async () => {
    const res = await router(new Request("http://localhost/user"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as unknown
    expect(body).toEqual({ id: 1, name: "Alice" })
  })

  it("returns 404 for missing path", async () => {
    const res = await router(new Request("http://localhost/nonexistent"))
    expect(res.status).toBe(404)
  })

  it("returns 404 for wrong method (no 405 + Allow without the layer)", async () => {
    const res = await router(new Request("http://localhost/user", { method: "POST" }))
    expect(res.status).toBe(404)
    expect(res.headers.get("Allow")).toBeNull()
  })

  it("returns 404 for HEAD (no HEAD-from-GET without the layer)", async () => {
    const res = await router(new Request("http://localhost/user", { method: "HEAD" }))
    expect(res.status).toBe(404)
  })

  it("returns 404 for OPTIONS (no auto-OPTIONS without the layer)", async () => {
    const res = await router(new Request("http://localhost/user", { method: "OPTIONS" }))
    expect(res.status).toBe(404)
  })
})

// ============================================================================
// 4. Method dispatch via `moveTo` — several verbs converging on one path
// (the retired dispatcher's `dispatch:{kind:"method"}` marker had no
// HttpRoute-pipeline equivalent; the same co-location is expressed by moving
// each leaf onto the same target with `moveTo`, see route.ts § applyMoveTo
// and examples/library-api/src/tree.ts for a worked example)
// ============================================================================

describe("method dispatch — several leaves placed at the same path", () => {
  it("read/replace/remove converge on /books/{bookId}, distinguished by method", async () => {
    const tree = api({
        books: api({
            read: op((_: { bookId: string }) => ({ op: "read" }), {
              http: { directives: [{ kind: "method", value: "GET" }, { kind: "moveTo", path: "../*" }] },
            }),
            replace: op((_: { bookId: string }) => ({ op: "replace" }), {
              http: { directives: [{ kind: "method", value: "PUT" }, { kind: "moveTo", path: "../*" }] },
            }),
            remove: op((_: { bookId: string }) => ({ op: "remove" }), {
              http: { directives: [{ kind: "method", value: "DELETE" }, { kind: "moveTo", path: "../*" }] },
            }),
          }, { fallback: { name: "bookId", subtree: api({}) } }),
      })
    const router = makeRouter(routes(tree))

    const getRes = await router(new Request("http://localhost/books/book-1"))
    expect(getRes.status).toBe(200)
    expect(await getRes.json()).toEqual({ op: "read" })

    const putRes = await router(new Request("http://localhost/books/book-1", { method: "PUT" }))
    expect(putRes.status).toBe(200)
    expect(await putRes.json()).toEqual({ op: "replace" })

    const delRes = await router(new Request("http://localhost/books/book-1", { method: "DELETE" }))
    expect(delRes.status).toBe(200)
    expect(await delRes.json()).toEqual({ op: "remove" })
  })

  it("a branch child alongside the placed leaves still contributes its own segment", async () => {
    const tree = api({
        books: api({
            read: op((_: { bookId: string }) => ({ op: "read" }), {
              http: { directives: [{ kind: "method", value: "GET" }, { kind: "moveTo", path: "../*" }] },
            }),
          }, { fallback: {
            name: "bookId",
            subtree: api({ checkout: op((_: unknown) => ({ ok: true })) }),
          } }),
      })
    const router = makeRouter(routes(tree))

    const readRes = await router(new Request("http://localhost/books/book-1"))
    expect(readRes.status).toBe(200)

    const checkoutRes = await router(
      new Request("http://localhost/books/book-1/checkout", { method: "POST" }),
    )
    expect(checkoutRes.status).toBe(200)
  })
})

// ============================================================================
// 5. 405 + Allow — autoMethodLayer, over the HttpRoute pipeline
// ============================================================================

describe("autoMethodLayer — 405 + Allow over the HttpRoute pipeline", () => {
  it("wrong method on a known path → 405 with Allow listing the registered methods", async () => {
    const tree = api({
        books: api({
            read: op((_: { bookId: string }) => ({}), {
              http: { directives: [{ kind: "method", value: "GET" }, { kind: "moveTo", path: "../*" }] },
            }),
            replace: op((_: { bookId: string }) => ({}), {
              http: { directives: [{ kind: "method", value: "PUT" }, { kind: "moveTo", path: "../*" }] },
            }),
            remove: op((_: { bookId: string }) => ({}), {
              http: { directives: [{ kind: "method", value: "DELETE" }, { kind: "moveTo", path: "../*" }] },
            }),
          }, { fallback: { name: "bookId", subtree: api({}) } }),
      })
    const route = routes(tree)
    const handler = autoMethodLayer(makeRouter(route), route)

    const res = await handler(new Request("http://localhost/books/book-1", { method: "PATCH" }))
    expect(res.status).toBe(405)
    const allow = res.headers.get("Allow") ?? ""
    expect(allow).toContain("GET")
    expect(allow).toContain("PUT")
    expect(allow).toContain("DELETE")
  })
})
