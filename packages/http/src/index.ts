// packages/http/src/index.ts — @rhi-zone/fractal-http
//
// HTTP surface for the library-first framework core.
//
// Provides:
//   - HttpCtx<Vars>        a routing context over a WHATWG Request
//   - httpRouter()         a Router specialised to HttpCtx / Response
//   - toHandler(router)    Router → (Request) => Promise<Response>  (WHATWG)
//   - withValidation       library-fn → node (validate → fn → render)
//   - json / text / sse / binary  Response helpers
//
// Runtime-agnostic: this module imports NO Bun and NO Node. The only runtime
// touch lives in ./adapter (serveBun / serveNode), which this file does not
// import. Streaming (SSE) and binary are ordinary Response bodies.

import {
  createRouter,
  type InferOutput,
  type Middleware,
  type NoVars,
  type Node,
  type Router,
  type RoutingCtx,
  type StandardSchema,
} from "@rhi-zone/fractal-core"

// ============================================================================
// HttpCtx — the HTTP routing context
// ============================================================================

/** The HTTP layer's request context.
 *
 *  - method:   HTTP verb (uppercase)
 *  - segments: remaining path segments (consumed by router dispatch)
 *  - params:   path params captured by router (e.g. { id: "42" })
 *  - query:    raw query-string accessor (URLSearchParams) — possibly-undefined
 *  - headers:  raw header accessor (Headers) — possibly-undefined
 *  - body:     lazy body thunk (pulled at most once)
 *  - request:  the underlying WHATWG Request (escape hatch)
 *  - vars:     typed context variables set by middleware
 *
 *  Query and headers are RAW by default — no capture combinator. */
export interface HttpCtx<Vars extends Record<string, unknown> = NoVars>
  extends RoutingCtx<Vars> {
  readonly query: URLSearchParams
  readonly headers: Headers
  readonly body: () => Promise<unknown>
  readonly request: Request
}

/** Middleware specialised to the HTTP context, returning Response. */
export type HttpMiddleware<
  Vars extends Record<string, unknown>,
  Extra extends Record<string, unknown>,
> = Middleware<HttpCtx, Vars, Extra, Response>

/** A router specialised to HttpCtx / Response. */
export type HttpRouter<
  In extends Record<string, unknown> = NoVars,
  Cur extends Record<string, unknown> = In,
> = Router<HttpCtx, In, Cur, Response>

/** Create an HTTP router. */
export function httpRouter<
  Vars extends Record<string, unknown> = NoVars,
>(): HttpRouter<Vars, Vars> {
  return createRouter<HttpCtx, Vars, Response>()
}

// ============================================================================
// toHandler — Router → (Request) => Promise<Response>  (WHATWG)
// ============================================================================

export function toHandler(router: HttpRouter<NoVars, NoVars>): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const segments = url.pathname.replace(/^\//, "").split("/").filter(Boolean)

    // Lazy body thunk — pulled at most once, only if a handler calls body().
    let bodyCache: unknown
    let bodyCalled = false
    const body = async (): Promise<unknown> => {
      if (bodyCalled) return bodyCache
      bodyCalled = true
      const ct = req.headers.get("content-type") ?? ""
      if (ct.includes("application/json")) {
        bodyCache = await req.json().catch(() => null)
      } else if (ct.startsWith("text/")) {
        bodyCache = await req.text()
      } else {
        bodyCache = await req.arrayBuffer()
      }
      return bodyCache
    }

    const ctx: HttpCtx<NoVars> = {
      method: req.method.toUpperCase(),
      segments,
      params: {},
      query: url.searchParams,
      headers: req.headers,
      body,
      request: req,
      vars: {},
    }

    const result = await router.dispatch(ctx)
    return result ?? notFound()
  }
}

// ============================================================================
// withValidation — library function → node  (validate → fn → render)
//
// LINCHPIN 2 (from spike/linchpins.ts): `Args` is inferred from `fn`; the
// validator's output is statically constrained to equal `Args` via
// `& (InferOutput<V> extends Args ? unknown : never)`. A validator producing
// the wrong shape is a COMPILE error — no manual annotation, no cast.
// ============================================================================

/** A node produced by withValidation: a Response handler plus meta carrying
 *  the validator and the underlying library function (for reflection). */
export interface ValidatedNode<Args, Result> extends Node<
  HttpCtx,
  Response,
  { readonly kind: "validate"; readonly validator: StandardSchema<unknown, Args>; readonly fn: (args: Args) => Promise<Result> }
> {}

export function withValidation<Args, Result, V extends StandardSchema<unknown, Args>>(
  fn: (args: Args) => Result | Promise<Result>,
  validator: V & (InferOutput<V> extends Args ? unknown : never),
): ValidatedNode<Args, Result> {
  const wrapped = validator as StandardSchema<unknown, Args>
  return {
    meta: { kind: "validate", validator: wrapped, fn: async (a) => fn(a) },
    handler: async (ctx: HttpCtx) => {
      const raw = await ctx.body()
      const result = wrapped["~standard"].validate(raw)
      if (result.issues !== undefined) {
        return json({ error: "Validation failed", issues: result.issues }, 400)
      }
      return json(await fn(result.value))
    },
  }
}

// ============================================================================
// Response helpers
// ============================================================================

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

export function text(value: string, status = 200): Response {
  return new Response(value, { status, headers: { "Content-Type": "text/plain" } })
}

export function notFound(): Response {
  return json({ error: "Not Found" }, 404)
}

/** Binary response — body is any Uint8Array / Blob / ArrayBuffer. Ordinary
 *  Response; the framework carries it unchanged. */
export function binary(
  body: Uint8Array | ArrayBuffer | Blob,
  contentType = "application/octet-stream",
  status = 200,
): Response {
  return new Response(body as BodyInit, { status, headers: { "Content-Type": contentType } })
}

/** Server-Sent-Events response — a text/event-stream ReadableStream body.
 *  An ordinary Response; no special framework support needed. */
export function sse(
  produce: (emit: (event: string, data: unknown) => void) => void | Promise<void>,
): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }
      try {
        await produce(emit)
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}

export type {
  InferOutput,
  Middleware,
  NoVars,
  Node,
  Router,
  RoutingCtx,
  StandardSchema,
  WithVars,
} from "@rhi-zone/fractal-core"
