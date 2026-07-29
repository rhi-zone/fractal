// packages/http-api-projector/src/adapter-edge.test.ts — translation-logic
// tests for the edge/serverless adapters in adapter.ts (serveDeno,
// toCloudflareWorker, toVercelEdge, serveFastlyCompute, toAwsLambdaHandler).
//
// None of these run inside their target isolate (Deno, a Workers isolate, a
// Fastly Compute sandbox, or a real Lambda). Instead each test verifies the
// adapter's own request/response translation and wiring — the same approach
// `adapter.test.ts` takes for `serveNode`'s node:http shim — by stubbing the
// ambient platform global the adapter touches.

import { afterEach, describe, expect, it } from "bun:test"
import {
  type APIGatewayProxyEventV2,
  serveDeno,
  serveFastlyCompute,
  toAwsLambdaHandler,
  toCloudflareWorker,
  toVercelEdge,
} from "./adapter.ts"

describe("serveDeno", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).Deno
  })

  it("wires the handler and options through to Deno.serve and maps the return shape", () => {
    let seenOptions: unknown
    let seenHandler: unknown
    let shutdownCalled = false
    ;(globalThis as Record<string, unknown>).Deno = {
      serve(options: unknown, handler: unknown) {
        seenOptions = options
        seenHandler = handler
        return {
          addr: { port: 4321 },
          shutdown: async () => {
            shutdownCalled = true
          },
        }
      },
    }
    const handler = async () => new Response("ok")
    const server = serveDeno(handler, { port: 9 })
    expect(seenOptions).toEqual({ port: 9 })
    expect(seenHandler).toBe(handler)
    expect(server.port).toBe(4321)
    void server.stop().then(() => expect(shutdownCalled).toBe(true))
  })
})

describe("toCloudflareWorker", () => {
  it("returns a { fetch } module-worker export that delegates to the handler", async () => {
    let seenReq: Request | undefined
    const handler = async (req: Request) => {
      seenReq = req
      return new Response("hi", { status: 201 })
    }
    const worker = toCloudflareWorker(handler)
    const req = new Request("https://example.com/x")
    const res = await worker.fetch(req, { SOME_BINDING: "x" }, { waitUntil() {} })
    expect(seenReq).toBe(req)
    expect(res.status).toBe(201)
    expect(await res.text()).toBe("hi")
  })
})

describe("toVercelEdge", () => {
  it("is the identity function", () => {
    const handler = async () => new Response("ok")
    expect(toVercelEdge(handler)).toBe(handler)
  })

  it("the returned function behaves exactly like the input handler", async () => {
    const handler = async (req: Request) => new Response(req.url)
    const edge = toVercelEdge(handler)
    const res = await edge(new Request("https://example.com/y"))
    expect(await res.text()).toBe("https://example.com/y")
  })
})

describe("serveFastlyCompute", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).addEventListener
  })

  it("registers a fetch event listener that forwards event.request into the handler and respondWith", async () => {
    let registeredType = ""
    let registeredListener: ((event: unknown) => void) | undefined
    ;(globalThis as Record<string, unknown>).addEventListener = (type: string, listener: (event: unknown) => void) => {
      registeredType = type
      registeredListener = listener
    }
    let seenReq: Request | undefined
    const handler = async (req: Request) => {
      seenReq = req
      return new Response("compute-ok")
    }
    serveFastlyCompute(handler)
    expect(registeredType).toBe("fetch")
    const request = new Request("https://example.com/edge")
    let respondedWith: Promise<Response> | undefined
    registeredListener?.({
      request,
      respondWith: (p: Promise<Response>) => {
        respondedWith = p
      },
    })
    expect(seenReq).toBe(request)
    const res = await respondedWith
    expect(await res?.text()).toBe("compute-ok")
  })
})

describe("toAwsLambdaHandler", () => {
  const baseEvent = (overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 => ({
    rawPath: "/items",
    rawQueryString: "",
    headers: {},
    requestContext: { http: { method: "GET" } },
    ...overrides,
  })

  it("translates a GET event into a Request with the right URL and forwards the response", async () => {
    let seenUrl = ""
    let seenMethod = ""
    const lambda = toAwsLambdaHandler(async (req) => {
      seenUrl = req.url
      seenMethod = req.method
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    const result = await lambda(
      baseEvent({ rawPath: "/items", rawQueryString: "a=1&b=2", headers: { host: "api.example.com" } }),
    )
    expect(seenMethod).toBe("GET")
    expect(seenUrl).toBe("https://api.example.com/items?a=1&b=2")
    expect(result.statusCode).toBe(200)
    expect(result.body).toBe(JSON.stringify({ ok: true }))
    expect(result.isBase64Encoded).toBeUndefined()
  })

  it("forwards a POST body and content-type", async () => {
    let seenBody: unknown
    const lambda = toAwsLambdaHandler(async (req) => {
      seenBody = await req.json()
      return new Response(null, { status: 204 })
    })
    const result = await lambda(
      baseEvent({
        requestContext: { http: { method: "POST" } },
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Alice" }),
      }),
    )
    expect(seenBody).toEqual({ name: "Alice" })
    expect(result.statusCode).toBe(204)
  })

  it("base64-decodes an incoming base64-encoded body", async () => {
    let seenBody = ""
    const lambda = toAwsLambdaHandler(async (req) => {
      seenBody = await req.text()
      return new Response("ok")
    })
    await lambda(
      baseEvent({
        requestContext: { http: { method: "POST" } },
        body: btoa("hello world"),
        isBase64Encoded: true,
      }),
    )
    expect(seenBody).toBe("hello world")
  })

  it("folds incoming cookies into the Cookie header", async () => {
    let seenCookie = ""
    const lambda = toAwsLambdaHandler(async (req) => {
      seenCookie = req.headers.get("cookie") ?? ""
      return new Response("ok")
    })
    await lambda(baseEvent({ cookies: ["a=1", "b=2"] }))
    expect(seenCookie).toBe("a=1; b=2")
  })

  it("splits outgoing set-cookie headers into the result's cookies array", async () => {
    const lambda = toAwsLambdaHandler(async () => {
      const headers = new Headers()
      headers.append("set-cookie", "a=1")
      headers.append("set-cookie", "b=2")
      return new Response("ok", { headers })
    })
    const result = await lambda(baseEvent())
    expect(result.cookies).toEqual(["a=1", "b=2"])
    expect(result.headers?.["set-cookie"]).toBeUndefined()
  })

  it("base64-encodes a binary response body", async () => {
    const lambda = toAwsLambdaHandler(async () => {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "application/octet-stream" },
      })
    })
    const result = await lambda(baseEvent())
    expect(result.isBase64Encoded).toBe(true)
    expect(result.body).toBe(btoa(String.fromCharCode(1, 2, 3, 4)))
  })
})
