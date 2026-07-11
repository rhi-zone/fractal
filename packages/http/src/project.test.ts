// packages/http/src/project.test.ts — direct tree-walk dispatch tests

import { describe, expect, it } from "bun:test"
import { node, op, service } from "@rhi-zone/fractal-core/node"
import { candidatesForUrl, makeRouter, verbFromTags } from "./project.ts"

// ============================================================================
// 1. Path/verb derivation from tree walk (via candidatesForUrl)
// ============================================================================

describe("candidatesForUrl — path from tree walk", () => {
  it("resolves /invoices/{invoiceId}/checkout from a fallback node", () => {
    const createCheckoutSession = (_: { invoiceId: string }) => ({
      url: "https://pay.stripe.com/…",
    })
    const api = node({
      children: {
        invoices: node({
          fallback: {
            name: "invoiceId",
            subtree: node({
              children: {
                checkout: op(createCheckoutSession, {
                  http: { directives: [{ kind: "verb", value: "POST" }, { kind: "segment", value: "checkout" }] },
                }),
              },
            }),
          },
        }),
      },
    })
    const candidates = candidatesForUrl(api, "http://localhost/invoices/inv-42/checkout")
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.verb).toBe("POST")
    expect(candidates[0]!.slugs).toEqual({ invoiceId: "inv-42" })
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
    // static child key "users" → /users; leaf key "list" → /list; inferSegment("list") = "list"
    expect(candidatesForUrl(api, "http://localhost/users/list")).toHaveLength(1)
    expect(candidatesForUrl(api, "http://localhost/users/other")).toHaveLength(0)
  })

  it("uses meta.http segment directive to rename a child node segment", () => {
    const api = node({
      children: {
        progressNode: node({
          meta: { http: { directives: [{ kind: "segment", value: "progress" }] } },
          children: {
            awardProgress: op((_: unknown) => ({}), {
              http: { directives: [{ kind: "segment", value: "award" }] },
            }),
          },
        }),
      },
    })
    expect(candidatesForUrl(api, "http://localhost/progress/award")).toHaveLength(1)
  })

  it("uses meta.http legacyPath directive as full-path override [DEBT]", () => {
    const api = node({
      children: {
        legacyEndpoint: op((_: unknown) => ({}), {
          http: { directives: [{ kind: "legacyPath", value: "/v1/old/legacy-path" }, { kind: "verb", value: "GET" }] },
        }),
      },
    })
    const candidates = candidatesForUrl(api, "http://localhost/v1/old/legacy-path")
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.verb).toBe("GET")
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
    expect(candidatesForUrl(api, "http://localhost/users/list")).toHaveLength(1)
    expect(candidatesForUrl(api, "http://localhost/orders/list")).toHaveLength(1)
  })

  it("service() surface resolves identically to node()", () => {
    class Svc {
      listItems(_: unknown) {
        return []
      }
    }
    const n = service(new Svc(), {
      meta: { listItems: { tags: { readOnly: true } } },
    })
    // inferSegment("listItems") = "items"
    const candidates = candidatesForUrl(n, "http://localhost/items")
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.verb).toBe("GET")
  })

  it("leaf tags (own meta only — no ancestor inheritance) drive the verb", () => {
    const api = node({
      children: {
        items: node({
          children: {
            list: op((_: unknown) => [], { tags: { readOnly: true } }),
          },
        }),
      },
    })
    const candidates = candidatesForUrl(api, "http://localhost/items/list")
    expect(candidates[0]!.verb).toBe("GET")
  })

  it("a node-level tag does NOT flow to a leaf with no own tags (inheritance removed)", () => {
    const api = node({
      children: {
        catalog: node({
          meta: { tags: { readOnly: true } },
          children: {
            list: op((_: unknown) => []), // no own tags — does NOT inherit
          },
        }),
      },
    })
    const candidates = candidatesForUrl(api, "http://localhost/catalog/list")
    expect(candidates[0]!.verb).toBe("POST") // conservative default, not GET
  })
})

// ============================================================================
// 1b. Candidate carries leaf meta (including tags)
// ============================================================================

describe("candidatesForUrl — candidate carries leaf meta", () => {
  it("includes meta on the candidate so consumers can read tags without fn-identity correlation", () => {
    const api = node({
      children: {
        listItems: op((_: unknown) => [], { tags: { readOnly: true } }),
      },
    })
    // inferSegment("listItems") = "items"
    const candidates = candidatesForUrl(api, "http://localhost/items")
    expect(candidates).toHaveLength(1)
    expect((candidates[0]!.meta.tags as { readOnly?: boolean } | undefined)?.readOnly).toBe(true)
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

  it("meta.http verb directive wins over all tags", () => {
    expect(
      verbFromTags({ tags: { readOnly: true }, http: { directives: [{ kind: "verb", value: "POST" }] } }),
    ).toBe("POST")
  })

  it("meta.http verb directive is uppercased", () => {
    expect(verbFromTags({ http: { directives: [{ kind: "verb", value: "delete" }] } })).toBe("DELETE")
  })

  it("readOnly = true implies idempotent (lattice: safe ⇒ idempotent)", () => {
    // readOnly = true always → GET regardless of other tags
    expect(verbFromTags({ tags: { readOnly: true, idempotent: false } })).toBe("GET")
  })
})

// ============================================================================
// 4. makeRouter — core dispatch (no auto-method layer)
// ============================================================================

describe("makeRouter — core router (no auto-method layer)", () => {
  const getUser = (_: unknown) => ({ id: 1, name: "Alice" })
  const api = node({
    children: {
      getUser: op(getUser, { tags: { readOnly: true }, http: { directives: [{ kind: "segment", value: "user" }] } }),
    },
  })
  const router = makeRouter(api)

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
// 5. Attribute-dispatch (meta.http.dispatch = {kind:"method"})
// ============================================================================

describe("dispatch — attribute-dispatch (method)", () => {
  it("method-dispatched node: leaf children share parent path, distinct verbs", () => {
    const api = node({
      children: {
        books: node({
          fallback: {
            name: "bookId",
            subtree: node({
              meta: { http: { dispatch: { kind: "method" } } },
              children: {
                read: op((_: { bookId: string }) => ({}), { tags: { readOnly: true } }),
                replace: op((_: { bookId: string }) => ({}), { tags: { idempotent: true } }),
                remove: op((_: { bookId: string }) => ({}), { tags: { idempotent: true, destructive: true } }),
              },
            }),
          },
        }),
      },
    })
    const candidates = candidatesForUrl(api, "http://localhost/books/book-1")
    // All three leaves resolve to the SAME path
    expect(candidates).toHaveLength(3)
    const verbs = new Set(candidates.map((r) => r.verb))
    expect(verbs).toEqual(new Set(["GET", "PUT", "DELETE"]))
  })

  it("method-dispatched: branch child under dispatch node still gets a segment", () => {
    const api = node({
      children: {
        resource: node({
          meta: { http: { dispatch: { kind: "method" } } },
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
    // Leaf 'read' → GET /resource (no added segment)
    const atResource = candidatesForUrl(api, "http://localhost/resource")
    expect(atResource.find((c) => c.verb === "GET")).toBeDefined()
    // Branch 'actions' / leaf 'trigger' → POST /resource/actions/trigger
    const atTrigger = candidatesForUrl(api, "http://localhost/resource/actions/trigger")
    expect(atTrigger).toHaveLength(1)
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
    expect(candidatesForUrl(api, "http://localhost/items/read")[0]?.verb).toBe("GET")
    expect(candidatesForUrl(api, "http://localhost/items/remove")[0]?.verb).toBe("DELETE")
  })
})

// ============================================================================
// 6. Arbitrary-attribute dispatch (header / query / contentType)
// ============================================================================

describe("dispatch — arbitrary-attribute dispatch (non-method)", () => {
  // ── Header dispatch ────────────────────────────────────────────────────────

  it("header-dispatch: children share parent path; conditions carry header check", () => {
    const api = node({
      children: {
        version: node({
          meta: { http: { dispatch: { kind: "header", name: "X-Api-Version" } } },
          children: {
            v1: op((_: unknown) => ({ v: 1 }), { tags: { readOnly: true } }),
            v2: op((_: unknown) => ({ v: 2 }), { tags: { readOnly: true } }),
          },
        }),
      },
    })
    const candidates = candidatesForUrl(api, "http://localhost/version")
    // Both children resolve to the same path /version — no per-child segment
    expect(candidates).toHaveLength(2)
    const c1 = candidates.find((c) => c.conditions.some((cond) => cond.kind === "header" && cond.value === "v1"))
    const c2 = candidates.find((c) => c.conditions.some((cond) => cond.kind === "header" && cond.value === "v2"))
    expect(c1).toBeDefined()
    expect(c2).toBeDefined()
  })

  it("header-dispatch: makeRouter dispatches by header value", async () => {
    const api = node({
      children: {
        version: node({
          meta: { http: { dispatch: { kind: "header", name: "X-Api-Version" } } },
          children: {
            v1: op((_: unknown) => ({ edition: "classic" }), { tags: { readOnly: true } }),
            v2: op((_: unknown) => ({ edition: "enhanced" }), { tags: { readOnly: true } }),
          },
        }),
      },
    })
    const router = makeRouter(api)

    const resV1 = await router(new Request("http://localhost/version", {
      headers: { "X-Api-Version": "v1" },
    }))
    expect(resV1.status).toBe(200)
    const bodyV1 = await resV1.json() as { edition: string }
    expect(bodyV1.edition).toBe("classic")

    const resV2 = await router(new Request("http://localhost/version", {
      headers: { "X-Api-Version": "v2" },
    }))
    expect(resV2.status).toBe(200)
    const bodyV2 = await resV2.json() as { edition: string }
    expect(bodyV2.edition).toBe("enhanced")
  })

  it("header-dispatch: no matching header value → 404 (not 405)", async () => {
    const api = node({
      children: {
        version: node({
          meta: { http: { dispatch: { kind: "header", name: "X-Api-Version" } } },
          children: {
            v1: op((_: unknown) => ({ v: 1 }), { tags: { readOnly: true } }),
          },
        }),
      },
    })
    const router = makeRouter(api)

    // Wrong header value → 404 (attribute miss, not method miss)
    const res = await router(new Request("http://localhost/version", {
      headers: { "X-Api-Version": "v99" },
    }))
    expect(res.status).toBe(404)
  })

  // ── `when` directive (key ≠ value) ─────────────────────────────────────────

  it("when directive: child key≠value; `when` sets the match value", async () => {
    const api = node({
      children: {
        endpoint: node({
          meta: { http: { dispatch: { kind: "header", name: "X-Api-Version" } } },
          children: {
            // key is "aliasChild" but matches when header value = "v2"
            aliasChild: op((_: unknown) => ({ matched: "aliasChild" }), {
              tags: { readOnly: true },
              http: { directives: [{ kind: "when", value: "v2" }] },
            }),
          },
        }),
      },
    })
    const router = makeRouter(api)

    const res = await router(new Request("http://localhost/endpoint", {
      headers: { "X-Api-Version": "v2" },
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as { matched: string }
    expect(body.matched).toBe("aliasChild")

    // The key "aliasChild" does NOT match
    const resWrong = await router(new Request("http://localhost/endpoint", {
      headers: { "X-Api-Version": "aliasChild" },
    }))
    expect(resWrong.status).toBe(404)
  })

  // ── Query dispatch ─────────────────────────────────────────────────────────

  it("query-dispatch: dispatches by query param value", async () => {
    const api = node({
      children: {
        resource: node({
          meta: { http: { dispatch: { kind: "query", name: "mode" } } },
          children: {
            fast: op((_: unknown) => ({ mode: "fast" }), { tags: { readOnly: true } }),
            slow: op((_: unknown) => ({ mode: "slow" }), { tags: { readOnly: true } }),
          },
        }),
      },
    })
    const router = makeRouter(api)

    const res = await router(new Request("http://localhost/resource?mode=fast"))
    expect(res.status).toBe(200)
    const body = await res.json() as { mode: string }
    expect(body.mode).toBe("fast")

    const resSlow = await router(new Request("http://localhost/resource?mode=slow"))
    expect(resSlow.status).toBe(200)
    const bodySlow = await resSlow.json() as { mode: string }
    expect(bodySlow.mode).toBe("slow")
  })

  // ── Method dispatch still works unchanged ──────────────────────────────────

  it("method-dispatch still produces correct verb routes (unchanged behavior)", () => {
    const api = node({
      children: {
        resource: node({
          meta: { http: { dispatch: { kind: "method" } } },
          children: {
            read: op((_: unknown) => ({}), { tags: { readOnly: true } }),
            remove: op((_: unknown) => ({}), { tags: { idempotent: true, destructive: true } }),
          },
        }),
      },
    })
    const candidates = candidatesForUrl(api, "http://localhost/resource")
    expect(candidates.find((c) => c.verb === "GET")).toBeDefined()
    expect(candidates.find((c) => c.verb === "DELETE")).toBeDefined()
  })

  // ── Multi-attribute nesting (header then method) ──────────────────────────
  //
  // A header-dispatch node whose branch children are method-dispatch nodes.
  // The outer header condition (X-Api-Version) is inherited by all leaves
  // inside each branch, stacked with the inner method condition.

  it("header-then-method nesting: conditions stack (header + method)", async () => {
    const api = node({
      children: {
        items: node({
          meta: { http: { dispatch: { kind: "header", name: "X-Api-Version" } } },
          children: {
            v1: node({
              meta: { http: { dispatch: { kind: "method" } } },
              children: {
                read: op((_: unknown) => ({ version: "v1", method: "GET" }), { tags: { readOnly: true } }),
                write: op((_: unknown) => ({ version: "v1", method: "POST" })),
              },
            }),
            v2: node({
              meta: { http: { dispatch: { kind: "method" } } },
              children: {
                read: op((_: unknown) => ({ version: "v2", method: "GET" }), { tags: { readOnly: true } }),
              },
            }),
          },
        }),
      },
    })
    const router = makeRouter(api)

    const resV1Get = await router(new Request("http://localhost/items", {
      method: "GET",
      headers: { "X-Api-Version": "v1" },
    }))
    expect(resV1Get.status).toBe(200)
    const bV1Get = await resV1Get.json() as { version: string; method: string }
    expect(bV1Get.version).toBe("v1")
    expect(bV1Get.method).toBe("GET")

    const resV1Post = await router(new Request("http://localhost/items", {
      method: "POST",
      headers: { "X-Api-Version": "v1" },
    }))
    expect(resV1Post.status).toBe(200)
    const bV1Post = await resV1Post.json() as { version: string; method: string }
    expect(bV1Post.version).toBe("v1")
    expect(bV1Post.method).toBe("POST")

    const resV2Get = await router(new Request("http://localhost/items", {
      method: "GET",
      headers: { "X-Api-Version": "v2" },
    }))
    expect(resV2Get.status).toBe(200)
    const bV2Get = await resV2Get.json() as { version: string; method: string }
    expect(bV2Get.version).toBe("v2")
    expect(bV2Get.method).toBe("GET")

    const resBad = await router(new Request("http://localhost/items", {
      method: "GET",
      headers: { "X-Api-Version": "v99" },
    }))
    expect(resBad.status).toBe(404)
  })
})

// ============================================================================
// 7. Library-api version node — end-to-end round-trip
// ============================================================================

describe("library-api version node — header-dispatch round-trip", () => {
  it("GET /version with X-Api-Version: v1 returns v1 payload", async () => {
    const { api } = await import("../../../examples/library-api/src/tree.ts")
    const { createFetch } = await import("./preset.ts")
    const fetch = createFetch(api)

    const res = await fetch(new Request("http://localhost/version", {
      headers: { "X-Api-Version": "v1" },
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as { version: string; message: string }
    expect(body.version).toBe("v1")
    expect(body.message).toContain("classic")
  })

  it("GET /version with X-Api-Version: v2 returns v2 payload (when directive: key=v2Alias, value=v2)", async () => {
    const { api } = await import("../../../examples/library-api/src/tree.ts")
    const { createFetch } = await import("./preset.ts")
    const fetch = createFetch(api)

    const res = await fetch(new Request("http://localhost/version", {
      headers: { "X-Api-Version": "v2" },
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as { version: string; features: string[] }
    expect(body.version).toBe("v2")
    expect(body.features).toContain("pagination")
  })

  it("GET /version with no X-Api-Version header → 404", async () => {
    const { api } = await import("../../../examples/library-api/src/tree.ts")
    const { createFetch } = await import("./preset.ts")
    const fetch = createFetch(api)

    const res = await fetch(new Request("http://localhost/version"))
    expect(res.status).toBe(404)
  })

  it("method-dispatch still produces 405+Allow for wrong method at /books/{bookId}", async () => {
    const { api } = await import("../../../examples/library-api/src/tree.ts")
    const { createFetch } = await import("./preset.ts")
    const fetch = createFetch(api)

    const res = await fetch(new Request("http://localhost/books/book-1", { method: "PATCH" }))
    expect(res.status).toBe(405)
    const allow = res.headers.get("Allow") ?? ""
    expect(allow).toContain("GET")
    expect(allow).toContain("PUT")
    expect(allow).toContain("DELETE")
  })
})
