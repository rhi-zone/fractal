// packages/http-api-projector/src/route.test.ts — HttpRoute tree transform + rewriter tests
//
// Covers the pipeline described in docs/design/routing-and-transforms.md:
//   Node --naiveTransform--> HttpRoute --rewriters--> HttpRoute --makeRouter--> Fetch

import { describe, expect, it } from "bun:test"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { wrapValidators } from "@rhi-zone/fractal-api-tree/build"
import type { GeneratedEntry } from "@rhi-zone/fractal-api-tree/build"
import {
  applyMethods,
  applyMoveTo,
  applyResponse,
  composeTransforms,
  httpRoute,
  isHttpRoute,
  makeRouterFromRoute,
  naiveTransform,
} from "./route.ts"
import type { HttpHandlerMiddleware, HttpRoute } from "./route.ts"
import { makeRouter, toHttpRoutes } from "./project.ts"

// ============================================================================
// naiveTransform — basic tree → HttpRoute conversion
// ============================================================================

describe("naiveTransform", () => {
  it("turns a leaf into a single POST method entry", () => {
    const getUser = (_: unknown) => ({ id: 1 })
    const api = op(getUser)
    const route = naiveTransform(api)
    expect(isHttpRoute(route)).toBe(true)
    expect(Object.keys(route.methods ?? {})).toEqual(["POST"])
    expect(route.methods?.POST?.handler).toBe(getUser)
  })

  it("turns each child into a path-segment child, recursively", () => {
    const list = (_: unknown) => []
    const create = (_: unknown) => ({})
    const api = api_({
        users: api_({
            list: op(list),
            create: op(create),
          }),
      })
    // Widened to the erased HttpRoute here — this assertion is exercising the
    // branch-node shape generically (no methods key at all, at any depth),
    // not the type-preservation naiveTransform now offers for leaves.
    const route: HttpRoute = naiveTransform(api)
    expect(route.methods).toBeUndefined()
    expect(route.children?.users).toBeDefined()
    expect(route.children?.users?.children?.list?.methods?.POST?.handler).toBe(list)
    expect(route.children?.users?.children?.create?.methods?.POST?.handler).toBe(create)
  })

  it("copies meta through unchanged", () => {
    const api = op((_: unknown) => ({}), { tags: { readOnly: true } })
    const route = naiveTransform(api)
    expect(route.methods?.POST?.meta).toEqual({ tags: { readOnly: true } })
  })

  it("carries fallback subtrees through", () => {
    const api = api_({}, { fallback: { name: "bookId", subtree: op((_: { bookId: string }) => ({})) } })
    const route = naiveTransform(api)
    expect(route.fallback?.name).toBe("bookId")
    expect(route.fallback?.subtree.methods?.POST).toBeDefined()
  })
})

// ============================================================================
// applyMethods — directive changes method from POST to GET
// ============================================================================

describe("applyMethods", () => {
  it("renames POST to the directive's method", () => {
    const api = op((_: unknown) => ({}), { http: { directives: [{ kind: "method", value: "GET" }] } })
    const route = applyMethods(naiveTransform(api))
    expect(Object.keys(route.methods ?? {})).toEqual(["GET"])
    expect(route.methods?.GET).toBeDefined()
    expect(route.methods?.POST).toBeUndefined()
  })

  it("uppercases the method value", () => {
    const api = op((_: unknown) => ({}), { http: { directives: [{ kind: "method", value: "delete" }] } })
    const route = applyMethods(naiveTransform(api))
    expect(Object.keys(route.methods ?? {})).toEqual(["DELETE"])
  })

  it("leaves POST unchanged when no method directive is present", () => {
    const api = op((_: unknown) => ({}))
    const route = applyMethods(naiveTransform(api))
    expect(Object.keys(route.methods ?? {})).toEqual(["POST"])
  })

  it("recurses into children and fallback", () => {
    const api = api_({
        items: op((_: unknown) => ({}), { http: { directives: [{ kind: "method", value: "GET" }] } }),
      }, { fallback: {
        name: "id",
        subtree: op((_: unknown) => ({}), { http: { directives: [{ kind: "method", value: "PUT" }] } }),
      } })
    const route = applyMethods(naiveTransform(api))
    expect(Object.keys(route.children?.items?.methods ?? {})).toEqual(["GET"])
    expect(Object.keys(route.fallback?.subtree.methods ?? {})).toEqual(["PUT"])
  })
})

// ============================================================================
// applyMoveTo — node moves under wildcard segment (motivating example)
// ============================================================================

describe("applyMoveTo", () => {
  it("moves a node up then down under a new wildcard segment (../*)", () => {
    const getBook = (_: unknown) => ({})
    const api = api_({
        users: api_({
            list: op((_: unknown) => []),
            get: op(getBook, { http: { directives: [{ kind: "moveTo", path: "../*" }] } }),
          }),
      })
    const route = applyMoveTo(naiveTransform(api))
    // "get" no longer sits at users/get
    expect(route.children?.users?.children?.get).toBeUndefined()
    // "list" untouched
    expect(route.children?.users?.children?.list).toBeDefined()
    // "get" now lives at users/* (fallback)
    expect(route.children?.users?.fallback?.subtree.methods?.POST?.handler).toBe(getBook)
  })

  it("merges multiple placed nodes converging on the same wildcard target", () => {
    const read = (_: unknown) => ({ op: "read" })
    const replace = (_: unknown) => ({ op: "replace" })
    const remove = (_: unknown) => ({ op: "remove" })
    const api = api_({
        books: api_({
            list: op((_: unknown) => []),
            create: op((_: unknown) => ({})),
            get: op(read, {
              http: { directives: [{ kind: "moveTo", path: "../*" }, { kind: "method", value: "GET" }] },
            }),
            update: op(replace, {
              http: { directives: [{ kind: "moveTo", path: "../*" }, { kind: "method", value: "PUT" }] },
            }),
            del: op(remove, {
              http: { directives: [{ kind: "moveTo", path: "../*" }, { kind: "method", value: "DELETE" }] },
            }),
          }),
      })
    const transform = composeTransforms(applyMethods, applyMoveTo)
    const route = transform(naiveTransform(api))

    expect(route.children?.books?.children?.list?.methods?.POST).toBeDefined()
    expect(route.children?.books?.children?.create?.methods?.POST).toBeDefined()
    expect(route.children?.books?.children?.get).toBeUndefined()
    expect(route.children?.books?.children?.update).toBeUndefined()
    expect(route.children?.books?.children?.del).toBeUndefined()

    const wildcard = route.children?.books?.fallback
    expect(wildcard).toBeDefined()
    expect(wildcard?.subtree.methods?.GET?.handler).toBe(read)
    expect(wildcard?.subtree.methods?.PUT?.handler).toBe(replace)
    expect(wildcard?.subtree.methods?.DELETE?.handler).toBe(remove)
  })

  it("`.` is identity — node stays at its current position", () => {
    const handler = (_: unknown) => ({})
    const api = api_({ item: op(handler, { http: { directives: [{ kind: "moveTo", path: "." }] } }) })
    const route = applyMoveTo(naiveTransform(api))
    expect(route.children?.item?.methods?.POST?.handler).toBe(handler)
  })

  it("`../..` moves a node up two levels (to the root)", () => {
    // itemPath = [admin, ping]; base (self) = [admin, ping];
    // "../.." pops twice → [] (root) — merges directly into root.
    const handler = (_: unknown) => ({})
    const api = api_({
        admin: api_({
            ping: op(handler, { http: { directives: [{ kind: "moveTo", path: "../.." }] } }),
          }),
      })
    const route = applyMoveTo(naiveTransform(api))
    expect(route.children?.admin?.children?.ping).toBeUndefined()
    expect(route.methods?.POST?.handler).toBe(handler)
  })

  it("`../../../admin` moves a deeply nested node under a new named segment", () => {
    const handler = (_: unknown) => ({})
    const api = api_({
        a: api_({
            b: api_({
                leaf: op(handler, { http: { directives: [{ kind: "moveTo", path: "../../../admin" }] } }),
              }),
          }),
      })
    const route = applyMoveTo(naiveTransform(api))
    expect(route.children?.a?.children?.b?.children?.leaf).toBeUndefined()
    expect(route.children?.admin?.methods?.POST?.handler).toBe(handler)
  })

  it("mkdir-p: a multi-segment moveTo target creates every missing intermediate node", () => {
    const handler = (_: unknown) => ({})
    const api = api_({
        leaf: op(handler, { http: { directives: [{ kind: "moveTo", path: "../api/v2/users" }] } }),
      })
    const route = applyMoveTo(naiveTransform(api))
    expect(route.children?.leaf).toBeUndefined()
    expect(route.children?.api?.children?.v2?.children?.users?.methods?.POST?.handler).toBe(handler)
  })

  it("throws when two placements converge on the same path AND method", () => {
    const api = api_({
        first: op((_: unknown) => ({ from: "first" }), {
          http: { directives: [{ kind: "moveTo", path: "../*" }, { kind: "method", value: "GET" }] },
        }),
        second: op((_: unknown) => ({ from: "second" }), {
          http: { directives: [{ kind: "moveTo", path: "../*" }, { kind: "method", value: "GET" }] },
        }),
      })
    const transform = composeTransforms(applyMethods, applyMoveTo)
    expect(() => transform(naiveTransform(api))).toThrow(/conflict/i)
  })

  it("does NOT throw when two placements converge on the same path with DIFFERENT methods", () => {
    const api = api_({
        first: op((_: unknown) => ({ from: "first" }), {
          http: { directives: [{ kind: "moveTo", path: "../*" }, { kind: "method", value: "GET" }] },
        }),
        second: op((_: unknown) => ({ from: "second" }), {
          http: { directives: [{ kind: "moveTo", path: "../*" }, { kind: "method", value: "PUT" }] },
        }),
      })
    const transform = composeTransforms(applyMethods, applyMoveTo)
    expect(() => transform(naiveTransform(api))).not.toThrow()
  })
})

// ============================================================================
// applyResponse — handler wrapping produces correct status code
// ============================================================================

describe("applyResponse", () => {
  it("wraps the handler so the router produces the directive's status", async () => {
    const api = op((_: unknown) => ({ created: true }), {
      http: { directives: [{ kind: "response", status: 201 }] },
    })
    const route = applyResponse(naiveTransform(api))
    const router = makeRouter(route)
    const res = await router(new Request("http://localhost/", { method: "POST" }))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { created: boolean }
    expect(body.created).toBe(true)
  })

  it("applies response headers from the directive", async () => {
    const api = op((_: unknown) => ({ ok: true }), {
      http: { directives: [{ kind: "response", headers: { "X-Custom": "yes" } }] },
    })
    const route = applyResponse(naiveTransform(api))
    const router = makeRouter(route)
    const res = await router(new Request("http://localhost/", { method: "POST" }))
    expect(res.headers.get("X-Custom")).toBe("yes")
  })

  it("leaves the handler untouched when there is no response directive", async () => {
    const api = op((_: unknown) => ({ ok: true }))
    const route = applyResponse(naiveTransform(api))
    const router = makeRouter(route)
    const res = await router(new Request("http://localhost/", { method: "POST" }))
    expect(res.status).toBe(200)
  })
})

// ============================================================================
// composeTransforms — multiple rewriters compose correctly
// ============================================================================

describe("composeTransforms", () => {
  it("applies rewriters left-to-right", () => {
    const handler = (_: unknown) => ({})
    const api = op(handler, { http: { directives: [{ kind: "method", value: "GET" }] } })
    const pipeline = composeTransforms(applyMethods, applyResponse, applyMoveTo)
    const route = pipeline(naiveTransform(api))
    expect(Object.keys(route.methods ?? {})).toEqual(["GET"])
  })

  it("identity when given no transforms", () => {
    const api = op((_: unknown) => ({}))
    const route = naiveTransform(api)
    const pipeline = composeTransforms()
    expect(pipeline(route)).toEqual(route)
  })
})

// ============================================================================
// Full pipeline: Node with directives → naiveTransform → rewriters → router
// ============================================================================

describe("full pipeline — Node → toHttpRoutes → rewriters → makeRouter", () => {
  it("dispatches a REST-style resource built from a plain Node tree", async () => {
    const store = new Map<string, { id: string; title: string }>()
    store.set("book-1", { id: "book-1", title: "Dune" })

    const api = api_({
        books: api_({
            list: op((_: unknown) => [...store.values()], {
              http: { directives: [{ kind: "method", value: "GET" }] },
            }),
            create: op((input: { title: string }) => {
              const book = { id: "book-2", title: input.title }
              store.set(book.id, book)
              return book
            }, { http: { directives: [{ kind: "method", value: "POST" }, { kind: "response", status: 201 }] } }),
            get: op(
              (input: { bookId: string }) => store.get(input.bookId),
              {
                http: {
                  directives: [
                    { kind: "moveTo", path: "../*" },
                    { kind: "method", value: "GET" },
                  ],
                },
              },
            ),
            remove: op(
              (input: { bookId: string }) => ({ deleted: store.delete(input.bookId) }),
              {
                http: {
                  directives: [
                    { kind: "moveTo", path: "../*" },
                    { kind: "method", value: "DELETE" },
                  ],
                },
              },
            ),
          }, { fallback: { name: "bookId", subtree: api_({}) } }),
      })

    const routes = toHttpRoutes(api)
    const pipeline = composeTransforms(applyMethods, applyMoveTo, applyResponse)
    const router = makeRouter(pipeline(routes))

    // "list" and "create" carry no `moveTo` directive, so they stay at their
    // naiveTransform positions: /books/list and /books/create.
    const listRes = await router(new Request("http://localhost/books/list"))
    expect(listRes.status).toBe(200)
    expect(await listRes.json()).toEqual([{ id: "book-1", title: "Dune" }])

    const createRes = await router(
      new Request("http://localhost/books/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Foundation" }),
      }),
    )
    expect(createRes.status).toBe(201)

    const getRes = await router(new Request("http://localhost/books/book-1"))
    expect(getRes.status).toBe(200)
    expect(await getRes.json()).toEqual({ id: "book-1", title: "Dune" })

    const delRes = await router(
      new Request("http://localhost/books/book-1", { method: "DELETE" }),
    )
    expect(delRes.status).toBe(200)
    expect(await delRes.json()).toEqual({ deleted: true })
  })
})

// ============================================================================
// httpRoute / isHttpRoute — brand + makeRouter overload discrimination
// ============================================================================

describe("httpRoute / isHttpRoute", () => {
  it("values built via httpRoute() are recognized by isHttpRoute", () => {
    const r = httpRoute({ meta: {} })
    expect(isHttpRoute(r)).toBe(true)
  })

  it("a plain Node value is not recognized as an HttpRoute", () => {
    const n = api_({})
    expect(isHttpRoute(n)).toBe(false)
  })

  it("makeRouter dispatches an HttpRoute through the simple exact-path/method dispatcher", async () => {
    const route = httpRoute({
      methods: { GET: { handler: (_: unknown) => ({ via: "route" }), meta: {} } },
      meta: {},
    })
    const router = makeRouter(route)
    const res = await router(new Request("http://localhost/"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ via: "route" })
  })
})

// ============================================================================
// runRoute (via makeRouterFromRoute) — decode → handler → encode, no
// interceptable stages. Covers default decode/encode, per-route `sources`,
// Result unwrapping, response overrides, and error handling — everything
// the retired Pipeline abstraction used to cover, minus the multi-stage
// machinery nothing in this codebase actually used.
// ============================================================================

describe("runRoute — default decode/encode", () => {
  it("default decode: JSON body merged for POST, empty input for GET", async () => {
    let seenPost: unknown
    let seenGet: unknown
    const route = httpRoute({
      methods: {
        POST: { handler: (input: unknown) => { seenPost = input; return {} }, meta: {} },
        GET: { handler: (input: unknown) => { seenGet = input; return {} }, meta: {} },
      },
      meta: {},
    })
    const router = makeRouterFromRoute(route)
    await router(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Dune" }),
      }),
    )
    expect(seenPost).toEqual({ title: "Dune" })

    await router(new Request("http://localhost/"))
    expect(seenGet).toEqual({})
  })

  it("invalid JSON body → 400", async () => {
    const route = httpRoute({
      methods: { POST: { handler: (input: unknown) => input, meta: {} } },
      meta: {},
    })
    const router = makeRouterFromRoute(route)
    const res = await router(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json {{{",
      }),
    )
    expect(res.status).toBe(400)
  })

  it("handler throwing → 500", async () => {
    const route = httpRoute({
      methods: {
        GET: {
          handler: (_: unknown) => {
            throw new Error("boom")
          },
          meta: {},
        },
      },
      meta: {},
    })
    const router = makeRouterFromRoute(route)
    const res = await router(new Request("http://localhost/"))
    expect(res.status).toBe(500)
  })

  it("handler returning Result ok → 200 with the unwrapped value", async () => {
    const route = httpRoute({
      methods: {
        GET: { handler: (_: unknown) => ({ kind: "ok", value: { id: 1 } }), meta: {} },
      },
      meta: {},
    })
    const router = makeRouterFromRoute(route)
    const res = await router(new Request("http://localhost/"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 1 })
  })

  it("handler returning Result err → 400 with the error body", async () => {
    const route = httpRoute({
      methods: {
        GET: { handler: (_: unknown) => ({ kind: "err", error: { message: "nope" } }), meta: {} },
      },
      meta: {},
    })
    const router = makeRouterFromRoute(route)
    const res = await router(new Request("http://localhost/"))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toBe("nope")
  })

  it("response override (via applyResponse) still takes effect through runRoute", async () => {
    const api = op((_: unknown) => ({ created: true }), {
      http: { directives: [{ kind: "response", status: 201 }] },
    })
    const route = applyResponse(naiveTransform(api))
    const router = makeRouterFromRoute(route)
    const res = await router(new Request("http://localhost/", { method: "POST" }))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ created: true })
  })
})

// ============================================================================
// runRoute — ResponseOverride body passthrough (encodeOverride). A response
// directive's handler return value becomes the override's `body` verbatim
// (see `wrapResponse` in route.ts), so exercising this through
// `{ kind: "response" }` + a handler returning a non-plain-object value is
// the direct way to drive `encodeOverride` without reaching for the
// module-private `RESPONSE_OVERRIDE` brand.
// ============================================================================

describe("runRoute — ResponseOverride body passthrough", () => {
  it("binary ArrayBuffer body passes through untouched with the handler's content-type", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const api = op((_: unknown) => bytes.buffer, {
      http: {
        directives: [
          { kind: "response", headers: { "Content-Type": "application/octet-stream" } },
        ],
      },
    })
    const route = applyResponse(naiveTransform(api))
    const router = makeRouterFromRoute(route)
    const res = await router(new Request("http://localhost/", { method: "POST" }))
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream")
    const buf = await res.arrayBuffer()
    expect(new Uint8Array(buf)).toEqual(bytes)
  })

  it("string body with an explicit non-JSON content-type passes through as-is", async () => {
    const api = op((_: unknown) => "<h1>hello</h1>", {
      http: { directives: [{ kind: "response", headers: { "Content-Type": "text/html" } }] },
    })
    const route = applyResponse(naiveTransform(api))
    const router = makeRouterFromRoute(route)
    const res = await router(new Request("http://localhost/", { method: "POST" }))
    expect(res.headers.get("Content-Type")).toBe("text/html")
    expect(await res.text()).toBe("<h1>hello</h1>")
  })

  it("string body WITHOUT an explicit content-type still gets JSON.stringify'd (backwards compat)", async () => {
    const api = op((_: unknown) => "plain string", {
      http: { directives: [{ kind: "response", status: 200 }] },
    })
    const route = applyResponse(naiveTransform(api))
    const router = makeRouterFromRoute(route)
    const res = await router(new Request("http://localhost/", { method: "POST" }))
    expect(res.headers.get("Content-Type")).toBe("application/json")
    expect(await res.text()).toBe(JSON.stringify("plain string"))
  })

  it("ReadableStream body passes through for streaming", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk-1"))
        controller.close()
      },
    })
    const api = op((_: unknown) => stream, {
      http: { directives: [{ kind: "response", headers: { "Content-Type": "text/plain" } }] },
    })
    const route = applyResponse(naiveTransform(api))
    const router = makeRouterFromRoute(route)
    const res = await router(new Request("http://localhost/", { method: "POST" }))
    expect(await res.text()).toBe("chunk-1")
  })

  it("a full Response object as the override body is returned directly", async () => {
    const inner = new Response("teapot", { status: 418, headers: { "X-Kind": "teapot" } })
    const api = op((_: unknown) => inner, {
      http: { directives: [{ kind: "response", status: 200 }] },
    })
    const route = applyResponse(naiveTransform(api))
    const router = makeRouterFromRoute(route)
    const res = await router(new Request("http://localhost/", { method: "POST" }))
    expect(res.status).toBe(418)
    expect(res.headers.get("X-Kind")).toBe("teapot")
    expect(await res.text()).toBe("teapot")
  })

  it("existing plain-object JSON override behavior is unchanged", async () => {
    const api = op((_: unknown) => ({ created: true }), {
      http: { directives: [{ kind: "response", status: 201 }] },
    })
    const route = applyResponse(naiveTransform(api))
    const router = makeRouterFromRoute(route)
    const res = await router(new Request("http://localhost/", { method: "POST" }))
    expect(res.status).toBe(201)
    expect(res.headers.get("Content-Type")).toBe("application/json")
    expect(await res.json()).toEqual({ created: true })
  })
})

// ============================================================================
// runRoute — per-route `sources` (declarative decode configuration; a direct
// field on the method entry, not a Pipeline slot)
// ============================================================================

describe("runRoute — per-route sources", () => {
  it("reads a specific param from the header store via sources.sourceMap", async () => {
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
    const router = makeRouterFromRoute(route)
    await router(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "secret-123" },
        body: JSON.stringify({ title: "Dune" }),
      }),
    )
    expect(capturedInput).toEqual({ title: "Dune", apiKey: "secret-123" })
  })

  it("runs sources.transform after assembly, before the handler", async () => {
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
    const router = makeRouterFromRoute(route)
    await router(new Request("http://localhost/?name=Alice"))
    expect(capturedInput).toEqual({ name: "Alice", injected: true })
  })
})

// ============================================================================
// wrapValidators (@rhi-zone/fractal-api-tree/build) — Node-level validation,
// wired before naiveTransform runs, exercised through the real HTTP dispatch
// (makeRouterFromRoute). This is the mechanism that replaced the retired
// route-tree-level `createApplyValidation`/`pipeline.validate` slot.
// ============================================================================

describe("wrapValidators — HTTP dispatch", () => {
  /** A synthetic GeneratedEntry: requires `name` to be a non-empty string. */
  function nameEntry(): GeneratedEntry {
    return {
      parse: (value: unknown) => {
        if (typeof value !== "object" || value === null) {
          return { kind: "err", errors: [{ kind: "type", path: [], expected: "object", actual: value }] }
        }
        const v = value as Record<string, unknown>
        if (typeof v.name !== "string" || v.name.length === 0) {
          return { kind: "err", errors: [{ kind: "type", path: ["name"], expected: "non-empty string", actual: v.name }] }
        }
        return { kind: "ok", value: v }
      },
    }
  }

  it("valid input → handler is called with the parsed value", async () => {
    let capturedInput: unknown
    const tree = api_({
      greet: op((input: { name: string }) => {
        capturedInput = input
        return { greeting: `hi ${input.name}` }
      }, { http: { directives: [{ kind: "method", value: "GET" }] } }),
    })
    const wrapped = wrapValidators(tree, { greet: nameEntry() })
    const router = makeRouterFromRoute(applyMethods(naiveTransform(wrapped)))
    const res = await router(new Request("http://localhost/greet?name=Alice"))
    expect(res.status).toBe(200)
    expect(capturedInput).toEqual({ name: "Alice" })
    expect(await res.json()).toEqual({ greeting: "hi Alice" })
  })

  it("invalid input → 400 (wrapped handler returns an err Result, no throw)", async () => {
    const tree = api_({
      greet: op((input: { name: string }) => ({ greeting: `hi ${input.name}` }), {
        http: { directives: [{ kind: "method", value: "GET" }] },
      }),
    })
    const wrapped = wrapValidators(tree, { greet: nameEntry() })
    const router = makeRouterFromRoute(applyMethods(naiveTransform(wrapped)))
    const res = await router(new Request("http://localhost/greet"))
    // No `name` query param → wrapValidators' wrapped handler returns an
    // `err(validationErrors)` Result before the original handler runs;
    // runRoute's Result-unwrapping (a discriminated-union check on the
    // return value, not a catch block) maps it to 400 with the structured
    // errors as the JSON body.
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: unknown }
    expect(Array.isArray(body.error)).toBe(true)
  })

  it("leaf with no matching validator entry passes through untouched", async () => {
    const tree = api_({
      ping: op((_: unknown) => ({ pong: true }), {
        http: { directives: [{ kind: "method", value: "GET" }] },
      }),
    })
    const wrapped = wrapValidators(tree, { greet: nameEntry() })
    const router = makeRouterFromRoute(applyMethods(naiveTransform(wrapped)))
    const res = await router(new Request("http://localhost/ping"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pong: true })
  })
})

// ============================================================================
// runRoute — handler-level middleware (makeRouterFromRoute's second param).
// Distinct from the protocol-level `Fetch => Fetch` middleware in layers.ts/
// preset.ts: this wraps the handler call itself, inside `runRoute`, after
// decode and before encode/Result-unwrapping — the HTTP counterpart of
// `CliMiddleware` (cli-api-projector) and `McpMiddleware` (mcp-api-projector).
// ============================================================================

describe("runRoute — handler-level middleware", () => {
  it("with no middleware configured, the handler is called directly", async () => {
    const tree = api_({
      echo: op((input: { x: string }) => ({ got: input.x }), {
        http: { directives: [{ kind: "method", value: "GET" }] },
      }),
    })
    const router = makeRouterFromRoute(applyMethods(naiveTransform(tree)))
    const res = await router(new Request("http://localhost/echo?x=1"))
    expect(await res.json()).toEqual({ got: "1" })
  })

  it("can read from stores — the raw pre-assembly path/query stores — and can transform input before / output after", async () => {
    let seenPathBookId: unknown
    let seenQueryX: unknown
    const doubleInput: HttpHandlerMiddleware = (next) => (input, stores) => {
      seenPathBookId = stores.path?.get("bookId")
      seenQueryX = stores.query?.get("x")
      return next({ ...input, x: String(Number(input.x) * 2) }, stores)
    }
    const tree = api_({
      books: api_({}, {
        fallback: {
          name: "bookId",
          subtree: api_({
            echo: op((input: { bookId: string; x: string }) => ({ bookId: input.bookId, got: Number(input.x) }), {
              description: "an echo op",
              http: { directives: [{ kind: "method", value: "GET" }] },
            }),
          }),
        },
      }),
    })
    const router = makeRouterFromRoute(applyMethods(naiveTransform(tree)), [doubleInput])
    const res = await router(new Request("http://localhost/books/42/echo?x=5"))
    expect(await res.json()).toEqual({ bookId: "42", got: 10 })
    expect(seenPathBookId).toBe("42")
    expect(seenQueryX).toBe("5")
  })

  it("the handler does not receive stores — only the assembled input", async () => {
    // A handler declared with a single `input` parameter has no way to reach
    // `stores` — there is no second parameter to receive it. This proves the
    // base adapter is `(input, _stores) => handler(input)`, not something
    // that leaks `stores` through to the handler.
    const tree = api_({
      whatArgs: op((input: unknown) => ({ argCount: Object.keys(input as object).length }), {
        http: { directives: [{ kind: "method", value: "GET" }] },
      }),
    })
    const passStores: HttpHandlerMiddleware = (next) => (input, stores) => next(input, stores)
    const router = makeRouterFromRoute(applyMethods(naiveTransform(tree)), [passStores])
    const res = await router(new Request("http://localhost/whatArgs?x=1"))
    expect(await res.json()).toEqual({ argCount: 1 })
  })

  it("composes multiple middleware — first entry is outermost (sees the call first and last)", async () => {
    const order: string[] = []
    const outer: HttpHandlerMiddleware = (next) => async (input, stores) => {
      order.push("outer:before")
      const result = await next(input, stores)
      order.push("outer:after")
      return result
    }
    const inner: HttpHandlerMiddleware = (next) => async (input, stores) => {
      order.push("inner:before")
      const result = await next(input, stores)
      order.push("inner:after")
      return result
    }
    const tree = api_({
      echo: op((input: { x: string }) => ({ got: input.x }), {
        http: { directives: [{ kind: "method", value: "GET" }] },
      }),
    })
    const router = makeRouterFromRoute(applyMethods(naiveTransform(tree)), [outer, inner])
    await router(new Request("http://localhost/echo?x=1"))
    expect(order).toEqual(["outer:before", "inner:before", "inner:after", "outer:after"])
  })

  it("runs before Result-unwrapping — an err Result from the middleware chain still maps to 400", async () => {
    const rejecting: HttpHandlerMiddleware = () => async () => ({ kind: "err", error: "rejected by middleware" })
    const tree = api_({
      echo: op((input: { x: string }) => ({ got: input.x }), {
        http: { directives: [{ kind: "method", value: "GET" }] },
      }),
    })
    const router = makeRouterFromRoute(applyMethods(naiveTransform(tree)), [rejecting])
    const res = await router(new Request("http://localhost/echo?x=1"))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "rejected by middleware" })
  })
})
