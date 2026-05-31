// @rhi-zone/fractal-http/web
// Runtime-neutral Web-standard handler.
// Uses ONLY Web Platform APIs (Request, Response, URL, Headers) — nothing from
// Bun, Node, or Deno is referenced here. This is the single HTTP entry point;
// runtime adapters (bun.ts, node.ts) wrap it as thin shims.

import type { AnyNode } from '@rhi-zone/fractal-core'
import { serve, type ServeOptions } from './index.ts'

export interface WebHandlerOptions extends ServeOptions {
  // No additional options at the web layer for now; extend here as needed.
}

/**
 * Build a Web-standard request handler over a fractal node tree.
 *
 *   URL path  → segments → branch dispatch
 *   JSON body → leaf input
 *   Result<O> → 200 + JSON
 *   Result<E> → errorStatus(E) + JSON
 *
 * The returned function is a `(request: Request) => Promise<Response>` that
 * works as-is in:
 *   - Bun's `Bun.serve({ fetch: handler })`
 *   - Cloudflare Workers' `fetch` export
 *   - Deno's `Deno.serve(handler)`
 *   - Any other runtime that speaks Web Fetch API
 *
 * Node.js needs a thin bridge (see node.ts) because `node:http` predates the
 * Fetch API.
 */
export const toWebHandler = (
  tree: AnyNode,
  options: WebHandlerOptions = {},
): ((request: Request) => Promise<Response>) => {
  const handler = serve(tree, options)

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const segments = url.pathname.split('/').filter(Boolean)

    let body: unknown = undefined
    const ct = request.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) {
      try {
        body = await request.json()
      } catch {
        body = undefined
      }
    }

    const httpReq = {
      method: request.method,
      segments,
      body,
      signal: request.signal,
      headers: request.headers,
    }

    const res = await handler(httpReq)
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    })
  }
}
