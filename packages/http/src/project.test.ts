// packages/http/src/project.test.ts — route-table builder tests

import { describe, expect, it } from "bun:test"
import { node, op, param, service } from "@rhi-zone/fractal-core/node"
import {
  buildRoutes,
  makeRouter,
  matchRoute,
  parsePath,
  verbFromTags,
} from "./project.ts"

// ============================================================================
// 1. Path derivation from tree walk
// ============================================================================

describe("buildRoutes — path from tree walk", () => {
  it("produces /invoices/{invoiceId}/checkout from a param() node", () => {
    const createCheckoutSession = (_: { invoiceId: string }) => ({
      url: "https://pay.stripe.com/…",
    })
    const api = node({
      children: {
        invoices: node({
          children: {
            invoiceId: param(
              "invoiceId",
              node({
                children: {
                  checkout: op(createCheckoutSession, {
                    http: { verb: "POST", segment: "checkout" },
                  }),
                },
              }),
            ),
          },
        }),
      },
    })
    const routes = buildRoutes(api)
    expect(routes).toHaveLength(1)
    expect(routes[0]!.path).toBe("/invoices/{invoiceId}/checkout")
    expect(routes[0]!.verb).toBe("POST")
  })

  it("uses the static child key as the segment", () => {
    const api = node({
      children: {
        users: node({
          children: {
            list: op((_: unknown) => [], { tags: { readOnly: true } }),
          },
        }),
      },
    })
    const routes = buildRoutes(api)
    // static child key "users" → /users; leaf key "list" → /list; inferSegment("list") = "list"
    expect(routes[0]!.path).toBe("/users/list")
  })

  it("uses meta.http.segment to rename a child node segment", () => {
    const api = node({
      children: {
        progressNode: node({
          meta: { http: { segment: "progress" } },
          children: {
            awardProgress: op((_: unknown) => ({}), {
              http: { segment: "award" },
            }),
          },
        }),
      },
    })
    const routes = buildRoutes(api)
    expect(routes[0]!.path).toBe("/progress/award")
  })

  it("uses meta.http.legacyPath as full-path override [DEBT]", () => {
    const api = node({
      children: {
        legacyEndpoint: op((_: unknown) => ({}), {
          http: { legacyPath: "/v1/old/legacy-path", verb: "GET" },
        }),
      },
    })
    const routes = buildRoutes(api)
    expect(routes[0]!.path).toBe("/v1/old/legacy-path")
    expect(routes[0]!.verb).toBe("GET")
  })

  it("collects leaves from multiple children", () => {
    const api = node({
      children: {
        users: node({
          children: {
            list: op((_: unknown) => [], { tags: { readOnly: true } }),
          },
        }),
        orders: node({
          children: {
            list: op((_: unknown) => [], { tags: { readOnly: true } }),
          },
        }),
      },
    })
    const routes = buildRoutes(api)
    const paths = routes.map((r) => r.path).sort()
    expect(paths).toEqual(["/orders/list", "/users/list"])
  })

  it("service() surface produces routes identically to node()", () => {
    class Svc {
      listItems(_: unknown) {
        return []
      }
    }
    const n = service(new Svc(), {
      meta: { listItems: { tags: { readOnly: true } } },
    })
    const routes = buildRoutes(n)
    expect(routes[0]!.verb).toBe("GET")
    // inferSegment("listItems") = "items"
    expect(routes[0]!.path).toBe("/items")
  })

  it("node-level readOnly:true makes leaf project to GET via inheritance", () => {
    const api = node({
      children: {
        catalog: node({
          meta: { tags: { readOnly: true } },
          children: {
            list: op((_: unknown) => []),  // no own tags
          },
        }),
      },
    })
    const routes = buildRoutes(api)
    expect(routes[0]!.verb).toBe("GET")
  })

  it("leaf-level tag overrides node-level tag inheritance", () => {
    const api = node({
      children: {
        items: node({
          meta: { tags: { readOnly: true } },
          children: {
            // leaf explicitly opts out of readOnly
            delete: op((_: unknown) => ({}), {
              tags: { readOnly: false, idempotent: true, destructive: true },
            }),
          },
        }),
      },
    })
    const routes = buildRoutes(api)
    expect(routes[0]!.verb).toBe("DELETE")
  })
})

// ============================================================================
// 1b. Route carries leaf meta (including tags)
// ============================================================================

describe("buildRoutes — route carries leaf meta", () => {
  it("includes meta on the route so consumers can read tags without fn-identity correlation", () => {
    const api = node({
      children: {
        listItems: op((_: unknown) => [], { tags: { readOnly: true } }),
      },
    })
    const routes = buildRoutes(api)
    expect(routes).toHaveLength(1)
    const route = routes[0]!
    expect((route.meta.tags as { readOnly?: boolean } | undefined)?.readOnly).toBe(true)
  })
})

// ============================================================================
// 2. Verb from three-valued tag lattice
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

  it("meta.http.verb override wins over all tags", () => {
    expect(verbFromTags({ tags: { readOnly: true }, http: { verb: "POST" } })).toBe(
      "POST",
    )
  })

  it("meta.http.verb override is uppercased", () => {
    expect(verbFromTags({ http: { verb: "delete" } })).toBe("DELETE")
  })

  it("readOnly = true implies idempotent (lattice: safe ⇒ idempotent)", () => {
    // readOnly = true always → GET regardless of other tags
    expect(verbFromTags({ tags: { readOnly: true, idempotent: false } })).toBe("GET")
  })
})

// ============================================================================
// 3. parsePath and matchRoute helpers
// ============================================================================

describe("parsePath", () => {
  it("parses literal segments", () => {
    const parts = parsePath("/users/list")
    expect(parts).toEqual([
      { kind: "literal", value: "users" },
      { kind: "literal", value: "list" },
    ])
  })

  it("parses param segments", () => {
    const parts = parsePath("/invoices/{invoiceId}/checkout")
    expect(parts).toEqual([
      { kind: "literal", value: "invoices" },
      { kind: "param", name: "invoiceId" },
      { kind: "literal", value: "checkout" },
    ])
  })
})

describe("matchRoute", () => {
  it("matches a literal path", () => {
    const pattern = parsePath("/users/list")
    expect(matchRoute(pattern, ["users", "list"])).toEqual({})
  })

  it("extracts param values", () => {
    const pattern = parsePath("/invoices/{invoiceId}/checkout")
    expect(
      matchRoute(pattern, ["invoices", "inv-123", "checkout"]),
    ).toEqual({ invoiceId: "inv-123" })
  })

  it("returns null on length mismatch", () => {
    const pattern = parsePath("/users/list")
    expect(matchRoute(pattern, ["users"])).toBeNull()
  })

  it("returns null on literal mismatch", () => {
    const pattern = parsePath("/users/list")
    expect(matchRoute(pattern, ["users", "other"])).toBeNull()
  })
})

// ============================================================================
// 4. makeRouter — core dispatch (no HTTP-correctness layer)
// ============================================================================

describe("makeRouter — core router (no auto-method layer)", () => {
  const getUser = (_: unknown) => ({ id: 1, name: "Alice" })
  const api = node({
    children: {
      getUser: op(getUser, { tags: { readOnly: true }, http: { segment: "user" } }),
    },
  })
  const routes = buildRoutes(api)
  const router = makeRouter(routes)

  it("dispatches an exact GET match → 200", async () => {
    const res = await router(new Request("http://localhost/user"))
    expect(res.status).toBe(200)
    const body = await res.json() as unknown
    expect(body).toEqual({ id: 1, name: "Alice" })
  })

  it("returns 404 for missing path", async () => {
    const res = await router(new Request("http://localhost/nonexistent"))
    expect(res.status).toBe(404)
  })

  it("returns 404 for wrong method (no 405 + Allow without the layer)", async () => {
    const res = await router(
      new Request("http://localhost/user", { method: "POST" }),
    )
    expect(res.status).toBe(404)
    // Core does NOT add an Allow header — that's the auto-method layer's job
    expect(res.headers.get("Allow")).toBeNull()
  })

  it("returns 404 for HEAD (no HEAD-from-GET without the layer)", async () => {
    const res = await router(
      new Request("http://localhost/user", { method: "HEAD" }),
    )
    expect(res.status).toBe(404)
  })

  it("returns 404 for OPTIONS (no auto-OPTIONS without the layer)", async () => {
    const res = await router(
      new Request("http://localhost/user", { method: "OPTIONS" }),
    )
    expect(res.status).toBe(404)
  })
})

// ============================================================================
// 5. Attribute-dispatch (meta.http.dispatch === "method")
// ============================================================================

describe("buildRoutes — attribute-dispatch (method)", () => {
  it("method-dispatched node: leaf children share parent path, distinct verbs", () => {
    const api = node({
      children: {
        books: node({
          children: {
            bookId: param(
              "bookId",
              node({
                meta: { http: { dispatch: "method" } },
                children: {
                  read: op((_: { bookId: string }) => ({}), { tags: { readOnly: true } }),
                  replace: op((_: { bookId: string }) => ({}), { tags: { idempotent: true } }),
                  remove: op((_: { bookId: string }) => ({}), { tags: { idempotent: true, destructive: true } }),
                },
              }),
            ),
          },
        }),
      },
    })
    const routes = buildRoutes(api)
    const byIdRoutes = routes.filter((r) => r.path === "/books/{bookId}")
    // All three leaves resolve to the SAME path
    expect(byIdRoutes).toHaveLength(3)
    const verbs = new Set(byIdRoutes.map((r) => r.verb))
    expect(verbs).toEqual(new Set(["GET", "PUT", "DELETE"]))
  })

  it("method-dispatched: collision (two leaves → same verb) throws at build time", () => {
    const api = node({
      children: {
        items: node({
          meta: { http: { dispatch: "method" } },
          children: {
            readA: op((_: unknown) => ({}), { tags: { readOnly: true } }),
            readB: op((_: unknown) => ({}), { tags: { readOnly: true } }),
          },
        }),
      },
    })
    expect(() => buildRoutes(api)).toThrow(/collision/)
  })

  it("method-dispatched: branch child under dispatch node still gets a segment", () => {
    const api = node({
      children: {
        resource: node({
          meta: { http: { dispatch: "method" } },
          children: {
            read: op((_: unknown) => ({}), { tags: { readOnly: true } }),
            actions: node({
              children: {
                trigger: op((_: unknown) => ({})),
              },
            }),
          },
        }),
      },
    })
    const routes = buildRoutes(api)
    // Leaf 'read' → GET /resource (no added segment)
    expect(routes.find((r) => r.path === "/resource" && r.verb === "GET")).toBeDefined()
    // Branch 'actions' / leaf 'trigger' → POST /resource/actions/trigger
    expect(routes.find((r) => r.path === "/resource/actions/trigger")).toBeDefined()
  })

  it("default (no dispatch marker) = segment-dispatch unchanged", () => {
    const api = node({
      children: {
        items: node({
          children: {
            read: op((_: unknown) => ({}), { tags: { readOnly: true } }),
            remove: op((_: unknown) => ({}), { tags: { idempotent: true, destructive: true } }),
          },
        }),
      },
    })
    const routes = buildRoutes(api)
    // Each leaf gets its own segment path — default behavior unchanged
    expect(routes.find((r) => r.path === "/items/read")?.verb).toBe("GET")
    expect(routes.find((r) => r.path === "/items/remove")?.verb).toBe("DELETE")
  })
})
