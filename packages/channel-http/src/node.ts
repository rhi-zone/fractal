// @rhi-zone/fractal-channel-http/node
// Node.js (20+) server adapter. Bridges node:http IncomingMessage/ServerResponse
// to/from the Web-standard Request/Response used by toWebHandler.
//
// Node 20+ has globalThis.fetch, Web Streams, AbortController, URL, Headers,
// Request, and Response — no polyfills required.
//
// node:http is loaded via a dynamic import cast to `any` so that this file
// requires no @types/node dependency (consistent with how bun.ts avoids
// @types/bun). The JS emitted by vite correctly references node:http.

import type { AnyNode } from '@rhi-zone/fractal-core'
import { toWebHandler, type WebHandlerOptions } from './web.ts'

// ── Public API ────────────────────────────────────────────────────────────────

export interface NodeServeOptions extends WebHandlerOptions {
  /** Port to listen on. 0 = OS-assigned ephemeral port. */
  readonly port?: number
  /** Hostname to bind. Defaults to '127.0.0.1'. */
  readonly hostname?: string
}

export interface NodeServer {
  /** Actual port the server is listening on (useful when port was 0). */
  readonly port: number
  /** Shut the server down and stop accepting new connections. */
  stop(): Promise<void>
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Read the entire IncomingMessage body as a Uint8Array. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readBody = (req: any): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    req.on('data', (chunk: Uint8Array) => chunks.push(chunk))
    req.on('end', () => {
      const totalLength = chunks.reduce((n, c) => n + c.byteLength, 0)
      const out = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.byteLength
      }
      resolve(out)
    })
    req.on('error', reject)
  })

/**
 * Start a Node.js HTTP server over a fractal node tree.
 *
 * Bridges node:http ↔ Web Fetch API:
 *   IncomingMessage  → Web Request  (reconstructed from host header + path)
 *   Web Response     → ServerResponse (status + headers + body piped)
 *
 * All request/response logic lives in toWebHandler; this file only handles the
 * impedance mismatch between node:http's callback style and the Fetch API.
 *
 * Contract (identical to the Bun adapter):
 *   URL path  → segments → branch dispatch
 *   JSON body → leaf input
 *   Result<O> → 200 + JSON body
 *   Result<E> → errorStatus(E) + JSON body (error payload)
 */
export const serveNode = (tree: AnyNode, options: NodeServeOptions = {}): Promise<NodeServer> => {
  const webHandler = toWebHandler(tree, options)
  const hostname = options.hostname ?? '127.0.0.1'

  // Dynamic import keeps 'node:http' out of non-Node bundles at tree-shaking
  // time. We hide the specifier behind a variable so the type checker never
  // tries to resolve 'node:http' (avoiding the @types/node requirement).
  // At runtime on Node 20 this resolves correctly.
  const nodeHttpSpecifier = 'node:http'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (import(/* @vite-ignore */ nodeHttpSpecifier) as Promise<any>).then(({ createServer }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = createServer(async (req: any, res: any) => {
      try {
        const host = (req.headers['host'] as string | undefined) ?? hostname
        const url = `http://${host}${(req.url as string | undefined) ?? '/'}`

        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers as Record<string, string | string[] | undefined>)) {
          if (value === undefined) continue
          if (Array.isArray(value)) {
            for (const v of value) headers.append(key, v)
          } else {
            headers.set(key, value)
          }
        }

        const bodyBytes = await readBody(req)
        const hasBody = bodyBytes.byteLength > 0

        const webRequest = new Request(url, {
          method: (req.method as string | undefined) ?? 'GET',
          headers,
          body: hasBody ? bodyBytes : undefined,
          // Node 20's undici-backed fetch requires 'duplex: half' when a body
          // is present on the Request constructor. Not in the TS RequestInit
          // type yet, so we spread via unknown.
          ...(hasBody ? { duplex: 'half' } : {}),
        } as RequestInit)

        const webResponse = await webHandler(webRequest)

        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        res.statusCode = webResponse.status
        webResponse.headers.forEach((value: string, key: string) => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          res.setHeader(key, value)
        })

        const responseBody = await webResponse.text()
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        res.end(responseBody)
      } catch (caught) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (!res.headersSent) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
          res.statusCode = 500
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          res.setHeader('content-type', 'application/json')
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          res.end(JSON.stringify({ code: 'internal_error', message: String(caught) }))
        }
      }
    })

    return new Promise<NodeServer>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      server.once('error', reject)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      server.listen(options.port ?? 0, hostname, () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        server.removeListener('error', reject)
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
        const addr = server.address()
        const port = addr !== null && typeof addr === 'object' ? (addr as { port: number }).port : (options.port ?? 0)

        resolve({
          port,
          stop: () =>
            new Promise<void>((res, rej) => {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-call
              server.close((err: unknown) => (err ? rej(err) : res()))
            }),
        })
      })
    })
  })
}
