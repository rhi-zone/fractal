// packages/http/src/preset.test.ts — OOTB preset end-to-end tests

import { AsyncLocalStorage } from "node:async_hooks"
import { describe, expect, it } from "bun:test"
import { api as api_, op, service } from "@rhi-zone/fractal-core/node"
import { createFetch } from "./preset.ts"
import { compiledCharRouter, mapCharRouter, radixRouter } from "./compile.ts"
import type { HttpRoute, ValidatorMap } from "./route.ts"

// ============================================================================
// Mixed API fixture
// ============================================================================

class UserService {
  listUsers(_: unknown) {
    return [{ id: 1, name: "Alice" }]
  }
  createUser(input: { name: string }) {
    return { id: 2, name: input.name }
  }
}

const usersNode = service(new UserService(), {
  meta: {
    // `moveTo` with a plain relative segment doubles as a path/segment
    // rename (see project.ts's HttpDirective docs) — the base position
    // `applyMoveTo` resolves relative to already excludes the node's own
    // key, so a bare token just replaces it.
    listUsers: {
      tags: { readOnly: true },
      http: { directives: [{ kind: "method", value: "GET" }, { kind: "moveTo", path: "../list" }] },
    },
    createUser: { http: { directives: [{ kind: "moveTo", path: "../create" }] } },
  },
})

const invoicesNode = api_({}, { fallback: {
    name: "invoiceId",
    subtree: api_({
        // No `moveTo`/`method` directive needed: naiveTransform already puts
        // this leaf at its own key ("checkout") with the default POST method.
        checkout: op(
          (input: { invoiceId: string; currency?: string }) => ({
            url: `https://pay.example.com/${input.invoiceId}`,
            currency: input.currency ?? "usd",
          }),
        ),
      }),
  } })

const api = api_({
    users: usersNode,
    invoices: invoicesNode,
  })

const fetch = createFetch(api)

// ============================================================================
// 1. Basic dispatch
// ============================================================================

describe("OOTB preset — basic dispatch", () => {
  it("GET /users/list → 200 JSON list", async () => {
    const res = await fetch(new Request("http://localhost/users/list"))
    expect(res.status).toBe(200)
    const body = await res.json() as unknown
    expect(body).toEqual([{ id: 1, name: "Alice" }])
  })

  it("POST /users/create → 200 with created user", async () => {
    const res = await fetch(
      new Request("http://localhost/users/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Bob" }),
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json() as unknown
    expect(body).toEqual({ id: 2, name: "Bob" })
  })

  it("GET /nonexistent → 404", async () => {
    const res = await fetch(new Request("http://localhost/nonexistent"))
    expect(res.status).toBe(404)
  })
})

// ============================================================================
// 2. Slug threads into handler input provenance-blind
// ============================================================================

describe("OOTB preset — slug threading (provenance-blind)", () => {
  it("POST /invoices/{invoiceId}/checkout — invoiceId from path segment merges into input", async () => {
    const res = await fetch(
      new Request("http://localhost/invoices/inv-42/checkout", {
        method: "POST",
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string; currency: string }
    // invoiceId slug ("inv-42") is in the URL produced by the handler — proves
    // it arrived in input without the handler knowing it came from the path
    expect(body.url).toContain("inv-42")
  })

  it("path slug and body fields both arrive in input at the same level", async () => {
    let capturedInput: Record<string, unknown> = {}
    const spyNode = api_({
        items: api_({}, { fallback: {
            name: "itemId",
            subtree: api_({
                update: op(
                  (input: Record<string, unknown>) => {
                    capturedInput = input
                    return { ok: true }
                  },
                  { tags: { idempotent: true }, http: { directives: [{ kind: "method", value: "PUT" }] } },
                ),
              }),
          } }),
      })
    const f = createFetch(spyNode)
    await f(
      new Request("http://localhost/items/item-99/update", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New Title" }),
      }),
    )
    // Both itemId (path) and title (body) are present at the same level
    expect(capturedInput).toMatchObject({
      itemId: "item-99",
      title: "New Title",
    })
  })
})

// ============================================================================
// 3. Auto-method behaviors from preset
// ============================================================================

describe("OOTB preset — auto-method layer included", () => {
  it("HEAD /users/list → 200, no body", async () => {
    const res = await fetch(
      new Request("http://localhost/users/list", { method: "HEAD" }),
    )
    expect(res.status).toBe(200)
    expect(res.body).toBeNull()
  })

  it("OPTIONS /users/list → 204 + Allow header", async () => {
    const res = await fetch(
      new Request("http://localhost/users/list", { method: "OPTIONS" }),
    )
    expect(res.status).toBe(204)
    const allow = res.headers.get("Allow")
    expect(allow).not.toBeNull()
    expect(allow).toContain("GET")
    expect(allow).toContain("OPTIONS")
  })

  it("wrong method on known path → 405 + Allow", async () => {
    const res = await fetch(
      new Request("http://localhost/users/list", { method: "DELETE" }),
    )
    expect(res.status).toBe(405)
    expect(res.headers.get("Allow")).toContain("GET")
  })
})

// ============================================================================
// 4. CORS opt-in
// ============================================================================

describe("OOTB preset — CORS opt-in", () => {
  const fetchWithCors = createFetch(api, { cors: true })

  it("response includes Access-Control-Allow-Origin when cors: true", async () => {
    const res = await fetchWithCors(new Request("http://localhost/users/list"))
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
  })

  it("default preset (no cors option) does NOT include CORS headers", async () => {
    const res = await fetch(new Request("http://localhost/users/list"))
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })
})

// ============================================================================
// 5. directives toggle
// ============================================================================

describe("OOTB preset — directives: false", () => {
  it("skips method/moveTo/response directives — naiveTransform baseline (POST at own key)", async () => {
    const f = createFetch(api, { directives: false })

    // The `moveTo`-placed "users/list" and "users/create" paths are never
    // created; the naive-transform baseline uses the node's OWN key
    // ("listUsers"/"createUser") and always POST.
    const moved = await f(new Request("http://localhost/users/list"))
    expect(moved.status).toBe(404)

    const naive = await f(
      new Request("http://localhost/users/listUsers", { method: "POST" }),
    )
    expect(naive.status).toBe(200)
  })
})

// ============================================================================
// 6. validators
// ============================================================================

describe("OOTB preset — validators", () => {
  it("applies a validator keyed by outer map key at the matching route path", async () => {
    const echoNode = api_({
      widgets: op((input: Record<string, unknown>) => input, {
        http: { directives: [{ kind: "method", value: "GET" }] },
      }),
    })

    const validators: ValidatorMap = {
      gen: {
        widgets: (bag) => ({ kind: "ok", value: { ...bag, validated: true } }),
      },
    }

    const f = createFetch(echoNode, { validators })
    const res = await f(new Request("http://localhost/widgets"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ validated: true })
  })

  it("a failing validator short-circuits with 400", async () => {
    const echoNode = api_({
      widgets: op((input: Record<string, unknown>) => input, {
        http: { directives: [{ kind: "method", value: "GET" }] },
      }),
    })

    const validators: ValidatorMap = {
      gen: {
        widgets: () => ({ kind: "err", error: "nope" }),
      },
    }

    const f = createFetch(echoNode, { validators })
    const res = await f(new Request("http://localhost/widgets"))
    expect(res.status).toBe(400)
  })
})

// ============================================================================
// 7. fusePipeline / skipEmptyInput toggles
// ============================================================================

describe("OOTB preset — fusePipeline / skipEmptyInput default on, toggleable", () => {
  it("still dispatches correctly with defaults (both on)", async () => {
    const res = await fetch(new Request("http://localhost/users/list"))
    expect(res.status).toBe(200)
  })

  it("still dispatches correctly with both explicitly off", async () => {
    const f = createFetch(api, { fusePipeline: false, skipEmptyInput: false })
    const res = await f(new Request("http://localhost/users/list"))
    expect(res.status).toBe(200)
  })
})

// ============================================================================
// 8. custom rewriters — applied after built-ins, before router compilation
// ============================================================================

describe("OOTB preset — custom rewriters", () => {
  it("a user-supplied HttpRoute => HttpRoute pass runs and its effect is observable", async () => {
    let sawRoute: HttpRoute | undefined
    const markerRewriter = (route: HttpRoute): HttpRoute => {
      sawRoute = route
      return route
    }
    const f = createFetch(api, { rewriters: [markerRewriter] })
    await f(new Request("http://localhost/users/list"))
    expect(sawRoute).toBeDefined()
    // The rewriter saw the fully-projected tree — directives already applied
    // (moveTo placed "list" as a child of "users").
    expect(sawRoute?.children?.users?.children?.list).toBeDefined()
  })
})

// ============================================================================
// 9. custom router
// ============================================================================

describe("OOTB preset — custom router selection", () => {
  it("radixRouter compiles and dispatches identically to the default", async () => {
    const f = createFetch(api, { router: radixRouter })
    const res = await f(new Request("http://localhost/users/list"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ id: 1, name: "Alice" }])
  })

  it("compiledCharRouter compiles and dispatches identically to the default", async () => {
    const f = createFetch(api, { router: compiledCharRouter })
    const res = await f(new Request("http://localhost/users/list"))
    expect(res.status).toBe(200)
  })

  it("mapCharRouter compiles and dispatches identically to the default", async () => {
    const f = createFetch(api, { router: mapCharRouter })
    const res = await f(new Request("http://localhost/users/list"))
    expect(res.status).toBe(200)
  })
})

// ============================================================================
// 10. ALS
// ============================================================================

describe("OOTB preset — als", () => {
  it("handler-invoking requests run inside the AsyncLocalStorage context", async () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>()
    let observedInsideHandler: string | undefined

    const alsNode = api_({
      whoami: op((_: unknown) => {
        observedInsideHandler = storage.getStore()?.requestId
        return { ok: true }
      }, { http: { directives: [{ kind: "method", value: "GET" }] } }),
    })

    const f = createFetch(alsNode, {
      als: { storage, init: () => ({ requestId: "req-123" }) },
    })

    await f(new Request("http://localhost/whoami"))
    expect(observedInsideHandler).toBe("req-123")
  })

  it("HEAD-as-GET (autoMethodLayer) also runs inside the ALS context", async () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>()
    let observedInsideHandler: string | undefined

    const alsNode = api_({
      whoami: op((_: unknown) => {
        observedInsideHandler = storage.getStore()?.requestId
        return { ok: true }
      }, { http: { directives: [{ kind: "method", value: "GET" }] } }),
    })

    const f = createFetch(alsNode, {
      als: { storage, init: () => ({ requestId: "req-head" }) },
    })

    const res = await f(new Request("http://localhost/whoami", { method: "HEAD" }))
    expect(res.status).toBe(200)
    expect(observedInsideHandler).toBe("req-head")
  })
})
