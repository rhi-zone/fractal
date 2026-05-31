// @rhi-zone/fractal-http/bun
// Bun-specific server adapter. Converts a Bun Request → HttpRequestLike,
// delegates to the framework-agnostic `serve` interpreter, and writes back a
// Bun Response. Nothing outside this file knows about Bun's API.

import type { AnyNode } from '@rhi-zone/fractal-core'
import { serve, type ServeOptions } from './index.ts'

// Minimal Bun server shape — only what this file uses. Avoids depending on
// @types/bun (which is not installed) while still being type-safe here.
interface BunServeConfig {
  port: number
  hostname?: string
  fetch(req: Request): Promise<Response>
}
interface BunServerHandle {
  readonly port: number
  stop(force?: boolean): void
}
declare const Bun: {
  serve(config: BunServeConfig): BunServerHandle
}

export interface BunServeOptions extends ServeOptions {
  /** Port to listen on. 0 = OS-assigned ephemeral port. */
  readonly port?: number
  /** Hostname to bind. Defaults to '127.0.0.1'. */
  readonly hostname?: string
}

export interface BunServer {
  /** Actual port the server is listening on (useful when port was 0). */
  readonly port: number
  /** Shut the server down cleanly. */
  stop(): void
}

/**
 * Start a Bun HTTP server over a fractal node tree.
 *
 * Contract (mirrors the interpreter):
 *   URL path  → segments (non-empty after splitting on '/') → branch dispatch
 *   JSON body → leaf input (leaf receives `req.body` = the parsed value)
 *   Result<O> → 200 + JSON body
 *   Result<E> → errorStatus(E) + JSON body (error payload)
 *
 * Capability handles are injected by the `grants` map in ServeOptions, keyed
 * by capability `kind`. The adapter passes extra context (raw headers) so
 * grants can read Authorization headers from the incoming request.
 */
export const serveBun = (tree: AnyNode, options: BunServeOptions = {}): BunServer => {
  const handler = serve(tree, options)

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? '127.0.0.1',
    async fetch(req: Request): Promise<Response> {
      // Parse path segments: strip leading/trailing '/', drop empty strings.
      const url = new URL(req.url)
      const segments = url.pathname.split('/').filter(Boolean)

      // Parse JSON body; non-JSON or empty body → undefined.
      let body: unknown = undefined
      const ct = req.headers.get('content-type') ?? ''
      if (ct.includes('application/json')) {
        try {
          body = await req.json()
        } catch {
          body = undefined
        }
      }

      // Build the HttpRequestLike. We expose `headers` as a plain object on the
      // body field is already set above; grants access the raw headers via
      // a cast — the interpreter only reads body/segments/method from the
      // HttpRequestLike interface, but grants receive the full object.
      const httpReq = {
        method: req.method,
        segments,
        body,
        signal: req.signal,
        headers: req.headers,
      }

      const res = await handler(httpReq)
      return new Response(JSON.stringify(res.body), {
        status: res.status,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  return {
    get port() { return server.port },
    stop() { server.stop(true) },
  }
}
