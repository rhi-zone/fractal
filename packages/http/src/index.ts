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
// Result → Response rendering  (the general mechanism — no app-specific map)
//
// A handler may return any of three things; `render` turns each into a Response:
//
//   1. a Response        — used as-is (incl. sse()/binary()). Passthrough.
//   2. an Outcome<Ok,Err> — tagged result. `ok` → 200 via the renderer;
//                           `error` → Response via the USER-SUPPLIED policy.
//   3. any plain value    — rendered to 200 via the renderer (default: JSON).
//
// The framework supplies the MECHANISM only. The error-code→status table is the
// user's: it arrives as an `ErrorPolicy` passed to `respond(...)` (per route) or
// bound once via `withPolicy(policy)` for an app/router-level default (a route
// may still pass its own policy to override). The framework hardcodes no codes.
// This is distinct from withValidation's framework-level 400 (a malformed
// *request*), which never consults the domain error policy — see withValidation.
// ============================================================================

/** A tagged result: success carries `value`, failure carries `error`. The
 *  rendering layer renders `ok` via the renderer and `error` via the policy. */
export type Outcome<Ok, Err> =
  | { readonly ok: true; readonly value: Ok }
  | { readonly ok: false; readonly error: Err }

/** Construct a success outcome. */
export function ok<Ok>(value: Ok): Outcome<Ok, never> {
  return { ok: true, value }
}

/** Construct a failure outcome. */
export function err<Err>(error: Err): Outcome<never, Err> {
  return { ok: false, error }
}

/** Renders a plain (non-Response, non-Outcome) value to a Response. The default
 *  is JSON at 200. Swap it to change the default content-type / serializer. */
export type Renderer = (value: unknown) => Response

/** The default renderer: JSON at 200. */
export const jsonRenderer: Renderer = (value) => json(value)

/** A user-supplied policy mapping a domain error to a Response. It may return a
 *  Response directly or a `{ status, body }` pair (body rendered via the
 *  renderer; default status body is the error itself when `body` is omitted). */
export type ErrorPolicy<Err> = (
  error: Err,
) => Response | { status: number; body?: unknown }

function isResponse(v: unknown): v is Response {
  return v instanceof Response
}

function isOutcome(v: unknown): v is Outcome<unknown, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    "ok" in v &&
    typeof (v as { ok: unknown }).ok === "boolean" &&
    (((v as { ok: boolean }).ok && "value" in v) ||
      (!(v as { ok: boolean }).ok && "error" in v))
  )
}

/** The general rendering step. A Response passes through; an Outcome renders
 *  via renderer (ok) or policy (error); any other value renders via renderer. */
export function render<Err>(
  value: unknown,
  policy: ErrorPolicy<Err>,
  renderer: Renderer = jsonRenderer,
): Response {
  if (isResponse(value)) return value
  if (isOutcome(value)) {
    if (value.ok) return renderer(value.value)
    const out = policy(value.error as Err)
    if (isResponse(out)) return out
    const body = "body" in out ? out.body : value.error
    return new Response(JSON.stringify(body), {
      status: out.status,
      headers: { "Content-Type": "application/json" },
    })
  }
  return renderer(value)
}

/** Wrap a handler whose return type is `Response | Outcome<Ok,Err> | Value`
 *  into a Response-returning handler, applying `render`. The policy's `Err` is
 *  inferred from / linked to the handler's Outcome error type — no cast needed
 *  at the call site. `renderer` defaults to JSON. */
export function respond<Ctx, Ok, Err, Value>(
  handler: (ctx: Ctx) => Response | Outcome<Ok, Err> | Value | Promise<Response | Outcome<Ok, Err> | Value>,
  policy: ErrorPolicy<Err>,
  renderer: Renderer = jsonRenderer,
): (ctx: Ctx) => Promise<Response> {
  return async (ctx: Ctx) => render(await handler(ctx), policy, renderer)
}

/** App/router-level default: bind a policy (and optional renderer) once, get a
 *  `respond`-shaped wrapper to reuse across routes. Each route may still call
 *  the standalone `respond` with its own policy to override per-route. */
export function withPolicy<Err>(
  policy: ErrorPolicy<Err>,
  renderer: Renderer = jsonRenderer,
): <Ctx, Ok, Value>(
  handler: (ctx: Ctx) => Response | Outcome<Ok, Err> | Value | Promise<Response | Outcome<Ok, Err> | Value>,
) => (ctx: Ctx) => Promise<Response> {
  return (handler) => respond(handler, policy, renderer)
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
