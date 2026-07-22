// packages/http-api-projector/src/preset.test.ts — OOTB preset end-to-end tests

import { AsyncLocalStorage } from "node:async_hooks"
import { describe, expect, it } from "bun:test"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import type { GeneratedEntry } from "@rhi-zone/fractal-api-tree/build"
import { createFetch } from "./preset.ts"
import { compiledCharRouter, mapCharRouter, radixRouter } from "./compile.ts"
import type { HttpHandlerMiddleware, HttpRoute } from "./route.ts"
import type { Fetch } from "./layers.ts"

// ============================================================================
// Mixed API fixture
// ============================================================================

const usersNode = api_({
  // `moveTo` with a plain relative segment doubles as a path/segment
  // rename (see project.ts's HttpDirective docs) — the base position
  // `applyMoveTo` resolves relative to already excludes the node's own
  // key, so a bare token just replaces it.
  listUsers: op((_: unknown) => [{ id: 1, name: "Alice" }], {
    tags: { readOnly: true },
    http: { directives: [{ kind: "method", value: "GET" }, { kind: "moveTo", path: "../list" }] },
  }),
  createUser: op((input: { name: string }) => ({ id: 2, name: input.name }), {
    http: { directives: [{ kind: "moveTo", path: "../create" }] },
  }),
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
  /** A synthetic GeneratedEntry: coerces/validates via `parse()`. */
  function okEntry(): GeneratedEntry {
    return {
      parse: (value: unknown) => ({
        kind: "ok",
        value: { ...(value as Record<string, unknown>), validated: true },
      }),
    }
  }

  function rejectingEntry(): GeneratedEntry {
    return {
      parse: () => ({ kind: "err", errors: [{ kind: "type", path: [], expected: "n/a", actual: "n/a" }] }),
    }
  }

  it("wraps the tree via wrapValidators before projection — matching leaf's handler runs parse() first", async () => {
    const echoNode = api_({
      widgets: op((input: Record<string, unknown>) => input, {
        http: { directives: [{ kind: "method", value: "GET" }] },
      }),
    })

    const f = createFetch(echoNode, { validators: { widgets: okEntry() } })
    const res = await f(new Request("http://localhost/widgets"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ validated: true })
  })

  it("a rejecting generated validator's err Result surfaces as a 400 with the structured errors", async () => {
    const echoNode = api_({
      widgets: op((input: Record<string, unknown>) => input, {
        http: { directives: [{ kind: "method", value: "GET" }] },
      }),
    })

    const f = createFetch(echoNode, { validators: { widgets: rejectingEntry() } })
    const res = await f(new Request("http://localhost/widgets"))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: unknown }
    expect(body.error).toEqual([{ kind: "type", path: [], expected: "n/a", actual: "n/a" }])
  })

  it("a leaf with no matching validator entry passes through untouched", async () => {
    const echoNode = api_({
      widgets: op((input: Record<string, unknown>) => input, {
        http: { directives: [{ kind: "method", value: "GET" }] },
      }),
      other: op((_: unknown) => ({ ok: true }), {
        http: { directives: [{ kind: "method", value: "GET" }] },
      }),
    })

    const f = createFetch(echoNode, { validators: { widgets: okEntry() } })
    const res = await f(new Request("http://localhost/other"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
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

  it("supports an async init — e.g. a session-cookie DB lookup — awaited before the ALS scope is entered", async () => {
    const storage = new AsyncLocalStorage<{ userId: string }>()
    let observedInsideHandler: string | undefined

    const alsNode = api_({
      whoami: op((_: unknown) => {
        observedInsideHandler = storage.getStore()?.userId
        return { ok: true }
      }, { http: { directives: [{ kind: "method", value: "GET" }] } }),
    })

    const lookupUserFromCookie = async (req: Request): Promise<{ userId: string }> => {
      await Promise.resolve() // simulate an async DB lookup
      return { userId: req.headers.get("cookie") === "session=abc" ? "user-abc" : "anonymous" }
    }

    const f = createFetch(alsNode, {
      als: { storage, init: lookupUserFromCookie },
    })

    const res = await f(
      new Request("http://localhost/whoami", { headers: { cookie: "session=abc" } }),
    )
    expect(res.status).toBe(200)
    expect(observedInsideHandler).toBe("user-abc")
  })
})

// ============================================================================
// 11. middleware — consumer-supplied Fetch => Fetch layers
// ============================================================================

describe("OOTB preset — middleware", () => {
  /** Wraps `inner`, tagging every response with a header naming this middleware. */
  const headerMiddleware = (name: string) => (inner: Fetch): Fetch => async (req) => {
    const res = await inner(req)
    const out = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: new Headers(res.headers),
    })
    out.headers.append("X-Middleware", name)
    return out
  }

  it("no middleware = same behavior as before (no X-Middleware header)", async () => {
    const res = await fetch(new Request("http://localhost/users/list"))
    expect(res.status).toBe(200)
    expect(res.headers.get("X-Middleware")).toBeNull()
  })

  it("a single middleware wraps the router and its effect is observable on the response", async () => {
    const f = createFetch(api, { middleware: [headerMiddleware("a")] })
    const res = await f(new Request("http://localhost/users/list"))
    expect(res.status).toBe(200)
    expect(res.headers.get("X-Middleware")).toBe("a")
  })

  it("multiple middleware compose — first in array is outermost wrapper", async () => {
    const order: string[] = []
    const tracking = (name: string) => (inner: Fetch): Fetch => async (req) => {
      order.push(`${name}:enter`)
      const res = await inner(req)
      order.push(`${name}:exit`)
      return res
    }

    const f = createFetch(api, { middleware: [tracking("outer"), tracking("inner")] })
    await f(new Request("http://localhost/users/list"))

    // outer wraps inner: outer enters first, inner enters/exits fully inside
    // outer's call, then outer exits last.
    expect(order).toEqual([
      "outer:enter",
      "inner:enter",
      "inner:exit",
      "outer:exit",
    ])
  })

  it("middleware sees requests that reach the router — protocol short-circuits (OPTIONS) still handled by autoMethodLayer without invoking middleware", async () => {
    let invoked = false
    const spy = (inner: Fetch): Fetch => async (req) => {
      invoked = true
      return inner(req)
    }

    const f = createFetch(api, { middleware: [spy] })
    const res = await f(
      new Request("http://localhost/users/list", { method: "OPTIONS" }),
    )
    expect(res.status).toBe(204)
    expect(invoked).toBe(false)
  })

  it("middleware runs on the actual dispatched request, e.g. GET /users/list", async () => {
    let invoked = false
    const spy = (inner: Fetch): Fetch => async (req) => {
      invoked = true
      return inner(req)
    }

    const f = createFetch(api, { middleware: [spy] })
    const res = await f(new Request("http://localhost/users/list"))
    expect(res.status).toBe(200)
    expect(invoked).toBe(true)
  })

  it("composes with cors: response carries both middleware and CORS headers", async () => {
    const f = createFetch(api, {
      middleware: [headerMiddleware("a")],
      cors: true,
    })
    const res = await f(new Request("http://localhost/users/list"))
    expect(res.headers.get("X-Middleware")).toBe("a")
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
  })
})

// ============================================================================
// 12. handlerMiddleware — a SEPARATE option from `middleware` above. Wraps
// the handler call itself (inside runRoute), not the whole Fetch cycle.
// ============================================================================

describe("OOTB preset — handlerMiddleware", () => {
  it("no handlerMiddleware = same behavior as before", async () => {
    const res = await fetch(new Request("http://localhost/users/list"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ id: 1, name: "Alice" }])
  })

  it("wraps the handler call and can transform its output", async () => {
    const tagOutput: HttpHandlerMiddleware = (next) => async (input, stores) => {
      const result = await next(input, stores)
      return { tagged: true, result }
    }
    const f = createFetch(api, { handlerMiddleware: [tagOutput] })
    const res = await f(new Request("http://localhost/users/list"))
    expect(await res.json()).toEqual({ tagged: true, result: [{ id: 1, name: "Alice" }] })
  })

  it("is independent of protocol-level `middleware` — both apply together, at their own layer", async () => {
    const headerMiddleware = (name: string) => (inner: Fetch): Fetch => async (req) => {
      const res = await inner(req)
      const out = new Response(res.body, { status: res.status, headers: new Headers(res.headers) })
      out.headers.append("X-Middleware", name)
      return out
    }
    const tagOutput: HttpHandlerMiddleware = (next) => async (input, stores) => {
      const result = await next(input, stores)
      return { tagged: true, result }
    }
    const f = createFetch(api, {
      middleware: [headerMiddleware("protocol")],
      handlerMiddleware: [tagOutput],
    })
    const res = await f(new Request("http://localhost/users/list"))
    expect(res.headers.get("X-Middleware")).toBe("protocol")
    expect(await res.json()).toEqual({ tagged: true, result: [{ id: 1, name: "Alice" }] })
  })

  it("is threaded through custom `router` compilers (e.g. radixRouter)", async () => {
    const tagOutput: HttpHandlerMiddleware = (next) => async (input, stores) => {
      const result = await next(input, stores)
      return { tagged: true, result }
    }
    const f = createFetch(api, { router: radixRouter, handlerMiddleware: [tagOutput] })
    const res = await f(new Request("http://localhost/users/list"))
    expect(await res.json()).toEqual({ tagged: true, result: [{ id: 1, name: "Alice" }] })
  })
})

// ============================================================================
// opts.detection — opt-out of the Result/streaming structural sniffing (see
// PresetOptions.detection, route.ts's `runRoute`). Both default to `true`.
// ============================================================================

describe("OOTB preset — detection", () => {
  const resultLikeApi = api_({
    getThing: op((_: unknown) => ({ kind: "ok", value: 42 }), {
      http: { directives: [{ kind: "method", value: "GET" }] },
    }),
  })

  it("defaults (detection omitted): Result-shape output is unwrapped, matching prior behavior", async () => {
    const f = createFetch(resultLikeApi)
    const res = await f(new Request("http://localhost/getThing"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(42)
  })

  it("detection.result: false — a Result-shaped return value passes through untouched", async () => {
    const f = createFetch(resultLikeApi, { detection: { result: false } })
    const res = await f(new Request("http://localhost/getThing"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ kind: "ok", value: 42 })
  })

  async function* gen() {
    yield 1
    yield 2
  }
  const streamingApi = api_({
    getStream: op((_: unknown) => gen(), {
      http: { directives: [{ kind: "method", value: "GET" }] },
    }),
  })

  it("defaults (detection omitted): an async-iterable return value streams as SSE, matching prior behavior", async () => {
    const f = createFetch(streamingApi)
    const res = await f(new Request("http://localhost/getStream"))
    expect(res.headers.get("Content-Type")).toBe("text/event-stream")
  })

  it("detection.streaming: false — an async-iterable return value is NOT streamed; treated as a plain value", async () => {
    const f = createFetch(streamingApi, { detection: { streaming: false } })
    const res = await f(new Request("http://localhost/getStream"))
    expect(res.headers.get("Content-Type")).not.toBe("text/event-stream")
    expect(res.status).toBe(200)
  })

  it("is threaded through custom `router` compilers (e.g. radixRouter)", async () => {
    const f = createFetch(resultLikeApi, { router: radixRouter, detection: { result: false } })
    const res = await f(new Request("http://localhost/getThing"))
    expect(await res.json()).toEqual({ kind: "ok", value: 42 })
  })
})
