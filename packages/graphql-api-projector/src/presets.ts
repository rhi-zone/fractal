// packages/graphql-api-projector/src/presets.ts — @rhi-zone/fractal-graphql-api-projector
//
// Transport-owning convenience preset over `createGraphQLServer` (server.ts).
// `createGraphQLServer` deliberately returns a transport-agnostic
// `GraphQLServer` (schema + `execute`/`subscribe`) and leaves transport
// wiring to the caller — this module is the "I don't want to think about it"
// one-call HTTP entry point, mirroring `createFetch`
// (http-api-projector/src/preset.ts) and `createHttpMcpServer`
// (mcp-api-projector/src/presets.ts).
//
// `createHttpGraphQLServer` mounts the standard GraphQL-over-HTTP contract
// (https://graphql.org/learn/serving-over-http/) at one path: `POST` with a
// `{query, variables, operationName}` JSON body for queries/mutations, and a
// `GET` with `?query=`/`?variables=`/`?operationName=` query-string params for
// simple browser-navigable queries — the same GET support most GraphQL
// servers offer for cache-friendly reads and quick manual testing. A bare
// `GET` with no `query` param serves the raw SDL text, handy as a poor man's
// "playground"/introspection landing page without pulling in a real GraphiQL
// bundle (`opts.playground: false` turns this off in favor of a 400).
//
// The returned handler is the same `(req: Request) => Promise<Response>`
// shape `createFetch`/`createHttpMcpServer` return — hand it directly to
// `Bun.serve({ fetch: handler })`, `Deno.serve(handler)`, a Cloudflare
// Worker's `fetch` export, or http-api-projector's own runtime adapters
// (`serveBun`/`serveNode`, packages/http-api-projector/src/adapter.ts — those
// adapters are transport-agnostic over any fetch-compatible handler, not
// HTTP-projector-specific, so they work here with no new dependency).
//
// Subscriptions are NOT served by this preset — GraphQL-over-HTTP has no
// standard subscription transport (the spec above is silent on it; the
// de facto standard is `graphql-ws` over WebSocket). `createGraphQLServer`'s
// `.subscribe()` already produces the `AsyncIterable<ExecutionResult>` a
// `graphql-ws` transport drains (see server.ts's module doc) — see ws.ts for
// that transport: a hand-rolled graphql-ws protocol implementation over
// `.subscribe()`, with a Bun WebSocket adapter (`handleBunWebSocket`)
// mirroring this module's own HTTP preset.

import type { Node } from "@rhi-zone/fractal-api-tree/node"
import { createGraphQLServer } from "./server.ts"
import type { CreateGraphQLServerOptions } from "./server.ts"

/** The standard GraphQL-over-HTTP request body shape. */
type GraphQLHttpRequestBody = {
  readonly query?: unknown
  readonly variables?: Record<string, unknown> | undefined
  readonly operationName?: string | undefined
}

/** CORS configuration — `true` for permissive defaults (`origin: "*"`), or an object to configure origin/credentials. Mirrors http-api-projector's `CorsOptions` shape (kept local rather than an import — see module doc on avoiding a new cross-package dependency for a handful of lines). */
export type HttpGraphQLCorsOptions = {
  readonly origin?: string | readonly string[]
  readonly credentials?: boolean
}

export type CreateHttpGraphQLServerOptions<T = unknown> = CreateGraphQLServerOptions<T> & {
  /** URL path the handler responds to. Every other path gets a 404. Defaults to `/graphql`. */
  readonly path?: string
  /** Enable CORS. `true` for permissive defaults (`origin: "*"`), an options object to configure origin/credentials, or omitted/`false` to disable (default). */
  readonly cors?: boolean | HttpGraphQLCorsOptions
  /** Serve the raw SDL text on a bare `GET <path>` (no `query` param) — a minimal playground/introspection landing page. Default `true`; pass `false` to 400 instead. */
  readonly playground?: boolean
}

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  })
}

/** CORS response headers for `req`, or `{}` when CORS is disabled or the request's Origin isn't allowed. */
function corsHeaders(req: Request, cors: boolean | HttpGraphQLCorsOptions | undefined): Record<string, string> {
  if (cors === undefined || cors === false) return {}
  const opts = cors === true ? {} : cors
  const origins: readonly string[] = opts.origin === undefined ? ["*"] : typeof opts.origin === "string" ? [opts.origin] : opts.origin
  const reqOrigin = req.headers.get("Origin")
  const allowed = origins.includes("*") ? "*" : reqOrigin !== null && origins.includes(reqOrigin) ? reqOrigin : undefined
  if (allowed === undefined) return {}
  return {
    "Access-Control-Allow-Origin": allowed,
    ...(opts.credentials === true ? { "Access-Control-Allow-Credentials": "true" } : {}),
  }
}

/** `OPTIONS` preflight response — 204 + the standard CORS preflight headers. */
function corsPreflightResponse(req: Request, cors: boolean | HttpGraphQLCorsOptions): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(req, cors),
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": req.headers.get("Access-Control-Request-Headers") ?? "Content-Type",
    },
  })
}

/**
 * Build a fetch-compatible `(req: Request) => Promise<Response>` handler
 * that serves `tree` as a GraphQL API over the standard GraphQL-over-HTTP
 * contract:
 *
 * ```ts
 * const handler = createHttpGraphQLServer(tree, { path: "/graphql" })
 * Bun.serve({ fetch: handler })
 * ```
 *
 * `POST <path>` with `{query, variables?, operationName?}` JSON body executes
 * a query/mutation; `GET <path>?query=...&variables=...&operationName=...`
 * does the same from query-string params; a bare `GET <path>` (no `query`)
 * serves the SDL text (see `opts.playground`). Any other path is a 404; any
 * other method on `path` is a 405.
 */
export function createHttpGraphQLServer<T = unknown>(
  tree: Node,
  opts: CreateHttpGraphQLServerOptions<T> = {},
): (req: Request) => Promise<Response> {
  const server = createGraphQLServer(tree, opts)
  const path = opts.path ?? "/graphql"
  const playground = opts.playground ?? true

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    if (url.pathname !== path) return new Response("Not Found", { status: 404 })

    if (req.method === "OPTIONS") {
      if (opts.cors === undefined || opts.cors === false) {
        return new Response(null, { status: 204, headers: { Allow: "GET, POST, OPTIONS" } })
      }
      return corsPreflightResponse(req, opts.cors)
    }

    const cors = corsHeaders(req, opts.cors)

    let body: GraphQLHttpRequestBody
    if (req.method === "GET") {
      const query = url.searchParams.get("query")
      if (query === null) {
        if (!playground) return jsonResponse({ errors: [{ message: "Must provide query string" }] }, 400, cors)
        return new Response(server.sdl, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", ...cors } })
      }
      const variablesParam = url.searchParams.get("variables")
      let variables: Record<string, unknown> | undefined
      if (variablesParam !== null) {
        try {
          variables = JSON.parse(variablesParam) as Record<string, unknown>
        } catch {
          return jsonResponse({ errors: [{ message: "Variables are invalid JSON" }] }, 400, cors)
        }
      }
      body = { query, variables, operationName: url.searchParams.get("operationName") ?? undefined }
    } else if (req.method === "POST") {
      try {
        body = (await req.json()) as GraphQLHttpRequestBody
      } catch {
        return jsonResponse({ errors: [{ message: "Request body is invalid JSON" }] }, 400, cors)
      }
    } else {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST, OPTIONS", ...cors } })
    }

    if (typeof body.query !== "string") {
      return jsonResponse({ errors: [{ message: "Must provide query string" }] }, 400, cors)
    }

    const result = await server.execute(body.query, body.variables, { request: req }, body.operationName)
    return jsonResponse(result, 200, cors)
  }
}
