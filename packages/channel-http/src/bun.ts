// @rhi-zone/fractal-channel-http/bun
// Bun-specific server adapter. Thin wrapper over toWebHandler (web.ts).
// Bun natively accepts a Web-standard (Request) => Promise<Response> fetch
// function, so this file does nothing but set up Bun.serve and expose the
// BunServer handle with .port / .stop().

import type { AnyNode } from '@rhi-zone/fractal-core'
import { toWebHandler, type WebHandlerOptions } from './web.ts'

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

export interface BunServeOptions extends WebHandlerOptions {
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
 * Delegates all request/response logic to toWebHandler (the Web-standard
 * handler); Bun.serve accepts a Web Fetch function natively, so no bridging
 * is required.
 *
 * Contract (mirrors the interpreter):
 *   URL path  → segments (non-empty after splitting on '/') → branch dispatch
 *   JSON body → leaf input (leaf receives `req.body` = the parsed value)
 *   Result<O> → 200 + JSON body
 *   Result<E> → errorStatus(E) + JSON body (error payload)
 */
export const serveBun = (tree: AnyNode, options: BunServeOptions = {}): BunServer => {
  const fetch = toWebHandler(tree, options)

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? '127.0.0.1',
    fetch,
  })

  return {
    get port() { return server.port },
    stop() { server.stop(true) },
  }
}
