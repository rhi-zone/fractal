// packages/http/src/route.test.ts — HttpRoute tree transform + rewriter tests
//
// Covers the pipeline described in docs/design/routing-and-transforms.md:
//   Node --naiveTransform--> HttpRoute --rewriters--> HttpRoute --makeRouter--> Fetch

import { describe, expect, it } from "bun:test"
import { node, op } from "@rhi-zone/fractal-core/node"
import type { Meta } from "@rhi-zone/fractal-core/node"
import {
  applyMethods,
  applyPlacement,
  applyResponse,
  composeTransforms,
  httpRoute,
  isHttpRoute,
  naiveTransform,
} from "./route.ts"
import type { Pipeline } from "./route.ts"
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
    const api = node({
      children: {
        users: node({
          children: {
            list: op(list),
            create: op(create),
          },
        }),
      },
    })
    const route = naiveTransform(api)
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
    const api = node({
      fallback: { name: "bookId", subtree: op((_: { bookId: string }) => ({})) },
    })
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
    const api = node({
      children: {
        items: op((_: unknown) => ({}), { http: { directives: [{ kind: "method", value: "GET" }] } }),
      },
      fallback: {
        name: "id",
        subtree: op((_: unknown) => ({}), { http: { directives: [{ kind: "method", value: "PUT" }] } }),
      },
    })
    const route = applyMethods(naiveTransform(api))
    expect(Object.keys(route.children?.items?.methods ?? {})).toEqual(["GET"])
    expect(Object.keys(route.fallback?.subtree.methods ?? {})).toEqual(["PUT"])
  })
})

// ============================================================================
// applyPlacement — node moves under wildcard segment (motivating example)
// ============================================================================

describe("applyPlacement", () => {
  it("moves a node down under a new wildcard segment (./*)", () => {
    const getBook = (_: unknown) => ({})
    const api = node({
      children: {
        users: node({
          children: {
            list: op((_: unknown) => []),
            get: op(getBook, { http: { directives: [{ kind: "place", path: "./*" }] } }),
          },
        }),
      },
    })
    const route = applyPlacement(naiveTransform(api))
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
    const api = node({
      children: {
        books: node({
          children: {
            list: op((_: unknown) => []),
            create: op((_: unknown) => ({})),
            get: op(read, {
              http: { directives: [{ kind: "place", path: "./*" }, { kind: "method", value: "GET" }] },
            }),
            update: op(replace, {
              http: { directives: [{ kind: "place", path: "./*" }, { kind: "method", value: "PUT" }] },
            }),
            del: op(remove, {
              http: { directives: [{ kind: "place", path: "./*" }, { kind: "method", value: "DELETE" }] },
            }),
          },
        }),
      },
    })
    const transform = composeTransforms(applyMethods, applyPlacement)
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
    const api = node({
      children: { item: op(handler, { http: { directives: [{ kind: "place", path: "." }] } }) },
    })
    const route = applyPlacement(naiveTransform(api))
    expect(route.children?.item?.methods?.POST?.handler).toBe(handler)
  })

  it("`..` moves a node up one level from its containing position", () => {
    // itemPath = [admin, ping]; base (containing position) = [admin];
    // ".." pops one further from base → [] (root) — merges directly into root.
    const handler = (_: unknown) => ({})
    const api = node({
      children: {
        admin: node({
          children: {
            ping: op(handler, { http: { directives: [{ kind: "place", path: ".." }] } }),
          },
        }),
      },
    })
    const route = applyPlacement(naiveTransform(api))
    expect(route.children?.admin?.children?.ping).toBeUndefined()
    expect(route.methods?.POST?.handler).toBe(handler)
  })

  it("`../../admin` moves a deeply nested node under a new named segment", () => {
    const handler = (_: unknown) => ({})
    const api = node({
      children: {
        a: node({
          children: {
            b: node({
              children: {
                leaf: op(handler, { http: { directives: [{ kind: "place", path: "../../admin" }] } }),
              },
            }),
          },
        }),
      },
    })
    const route = applyPlacement(naiveTransform(api))
    expect(route.children?.a?.children?.b?.children?.leaf).toBeUndefined()
    expect(route.children?.admin?.methods?.POST?.handler).toBe(handler)
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
    const pipeline = composeTransforms(applyMethods, applyResponse, applyPlacement)
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

    const api = node({
      children: {
        books: node({
          // Pre-declared fallback supplies the wildcard's parameter name
          // ("bookId") that applyPlacement reuses when it creates/merges the
          // wildcard subtree for `get`/`remove` below.
          fallback: { name: "bookId", subtree: node({}) },
          children: {
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
                    { kind: "place", path: "./*" },
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
                    { kind: "place", path: "./*" },
                    { kind: "method", value: "DELETE" },
                  ],
                },
              },
            ),
          },
        }),
      },
    })

    const routes = toHttpRoutes(api)
    const pipeline = composeTransforms(applyMethods, applyPlacement, applyResponse)
    const router = makeRouter(pipeline(routes))

    // "list" and "create" carry no `place` directive, so they stay at their
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
    const n = node({ children: {} })
    expect(isHttpRoute(n)).toBe(false)
  })

  it("makeRouter dispatches an HttpRoute through the new simple dispatcher", async () => {
    const route = httpRoute({
      methods: { GET: { handler: (_: unknown) => ({ via: "route" }), meta: {} } },
      meta: {},
    })
    const router = makeRouter(route)
    const res = await router(new Request("http://localhost/"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ via: "route" })
  })

  it("makeRouter still dispatches a plain Node through the legacy tree-walk dispatcher", async () => {
    const api = op((_: unknown) => ({ via: "node" }), { tags: { readOnly: true } })
    const router = makeRouter(node({ children: { thing: api } }))
    const res = await router(new Request("http://localhost/thing"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ via: "node" })
  })
})

// ============================================================================
// Pipeline — interceptable request/response stages
// (docs/design/routing-and-transforms.md § "Interceptable pipeline")
// ============================================================================

describe("Pipeline", () => {
  it("runs a reqTransform that adds a header before decode", async () => {
    const seen: Array<string | null> = []
    const pipeline: Pipeline = {
      reqTransforms: [
        (req) => new Request(req, { headers: { ...Object.fromEntries(req.headers), "x-injected": "yes" } }),
      ],
      decode: (req) => {
        seen.push(req.headers.get("x-injected"))
        return {}
      },
    }
    const route = httpRoute({
      methods: { GET: { handler: (_: unknown) => ({}), meta: {} } },
      pipeline,
      meta: {},
    })
    const router = makeRouter(route)
    await router(new Request("http://localhost/"))
    expect(seen).toEqual(["yes"])
  })

  it("runs an inputTransform that injects a field before the handler sees it", async () => {
    let seenInput: unknown
    const pipeline: Pipeline = {
      inputTransforms: [(input) => ({ ...(input as Record<string, unknown>), injected: true })],
    }
    const route = httpRoute({
      methods: {
        GET: {
          handler: (input: unknown) => {
            seenInput = input
            return {}
          },
          meta: {},
        },
      },
      pipeline,
      meta: {},
    })
    const router = makeRouter(route)
    await router(new Request("http://localhost/"))
    expect(seenInput).toEqual({ injected: true })
  })

  it("runs an outputTransform that wraps the handler result", async () => {
    const pipeline: Pipeline = {
      outputTransforms: [(output) => ({ data: output })],
    }
    const route = httpRoute({
      methods: { GET: { handler: (_: unknown) => ({ id: 1 }), meta: {} } },
      pipeline,
      meta: {},
    })
    const router = makeRouter(route)
    const res = await router(new Request("http://localhost/"))
    expect(await res.json()).toEqual({ data: { id: 1 } })
  })

  it("runs a resTransform that adds CORS headers to the response", async () => {
    const pipeline: Pipeline = {
      resTransforms: [
        (res) => {
          const headers = new Headers(res.headers)
          headers.set("Access-Control-Allow-Origin", "*")
          return new Response(res.body, { status: res.status, headers })
        },
      ],
    }
    const route = httpRoute({
      methods: { GET: { handler: (_: unknown) => ({ ok: true }), meta: {} } },
      pipeline,
      meta: {},
    })
    const router = makeRouter(route)
    const res = await router(new Request("http://localhost/"))
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
  })

  it("uses a custom decode/encode pair in place of the defaults", async () => {
    const pipeline: Pipeline = {
      decode: async (req) => ({ text: await req.text() }),
      encode: (output) => new Response(`custom:${JSON.stringify(output)}`, { status: 202 }),
    }
    const route = httpRoute({
      methods: {
        POST: {
          handler: (input: unknown) => input,
          meta: {},
        },
      },
      pipeline,
      meta: {},
    })
    const router = makeRouter(route)
    const res = await router(new Request("http://localhost/", { method: "POST", body: "hello" }))
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('custom:{"text":"hello"}')
  })

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
    const router = makeRouter(route)
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

  it("merges node-level and method-level pipelines, method transforms running last", async () => {
    const order: string[] = []
    const route = httpRoute({
      methods: {
        GET: {
          handler: (input: unknown) => input,
          meta: {},
          pipeline: {
            inputTransforms: [(input) => { order.push("method"); return input }],
          },
        },
      },
      pipeline: {
        inputTransforms: [(input) => { order.push("node"); return input }],
      },
      meta: {},
    })
    const router = makeRouter(route)
    await router(new Request("http://localhost/"))
    expect(order).toEqual(["node", "method"])
  })

  it("runs the full pipeline (all stages) in the documented order", async () => {
    const order: string[] = []
    const pipeline: Pipeline = {
      reqTransforms: [
        (req: Request, _meta: Meta) => {
          order.push("reqTransform")
          return req
        },
      ],
      decode: (_req: Request, _meta: Meta) => {
        order.push("decode")
        return { n: 1 }
      },
      inputTransforms: [
        (input: unknown, _meta: Meta) => {
          order.push("inputTransform")
          return input
        },
      ],
      outputTransforms: [
        (output: unknown, _meta: Meta) => {
          order.push("outputTransform")
          return output
        },
      ],
      encode: (output: unknown, _meta: Meta) => {
        order.push("encode")
        return jsonResponse(output)
      },
      resTransforms: [
        (res: Response, _meta: Meta) => {
          order.push("resTransform")
          return res
        },
      ],
    }
    function jsonResponse(v: unknown): Response {
      return new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } })
    }
    const route = httpRoute({
      methods: {
        GET: {
          handler: (input: unknown) => {
            order.push("handler")
            return input
          },
          meta: {},
        },
      },
      pipeline,
      meta: {},
    })
    const router = makeRouter(route)
    const res = await router(new Request("http://localhost/"))
    expect(await res.json()).toEqual({ n: 1 })
    expect(order).toEqual([
      "reqTransform",
      "decode",
      "inputTransform",
      "handler",
      "outputTransform",
      "encode",
      "resTransform",
    ])
  })
})
