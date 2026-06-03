// packages/http/src/adapter.ts — @rhi-zone/fractal-http runtime adapters
//
// The ONLY runtime touch in this package. The core http module (./index)
// imports nothing from here, so it stays runtime-agnostic. An adapter takes a
// WHATWG fetch handler and binds it to a concrete server runtime.

type FetchHandler = (req: Request) => Promise<Response>

// Bun is ambient in a Bun runtime; declared here so the file typechecks
// without pulling Bun into the core http module.
declare const Bun: {
  serve(options: { fetch: FetchHandler; port?: number; hostname?: string }): {
    port: number
    stop(closeActiveConnections?: boolean): void
  }
}

/** Serve a fetch handler on Bun. The single Bun touch in the codebase. */
export function serveBun(
  handler: FetchHandler,
  options: { port?: number; hostname?: string } = {},
): { port: number; stop(closeActiveConnections?: boolean): void } {
  return Bun.serve({ fetch: handler, ...options })
}

/** Serve a fetch handler on Node via node:http.
 *
 *  A thin shim that adapts node's req/res to a WHATWG Request/Response. Kept
 *  minimal — the proof is runtime-neutrality, not a production Node server. */
export async function serveNode(
  handler: FetchHandler,
  options: { port?: number; hostname?: string } = {},
): Promise<{ port: number; stop(): void }> {
  const http = await import("node:http")
  const server = http.createServer((nodeReq, nodeRes) => {
    void (async () => {
      const host = nodeReq.headers.host ?? "localhost"
      const url = `http://${host}${nodeReq.url ?? "/"}`
      const chunks: Uint8Array[] = []
      for await (const chunk of nodeReq) chunks.push(chunk as Uint8Array)
      const hasBody = nodeReq.method !== "GET" && nodeReq.method !== "HEAD" && chunks.length > 0
      const init: RequestInit = {
        method: nodeReq.method ?? "GET",
        headers: nodeReq.headers as Record<string, string>,
      }
      if (hasBody) init.body = Buffer.concat(chunks)
      const request = new Request(url, init)
      const response = await handler(request)
      nodeRes.statusCode = response.status
      response.headers.forEach((value, key) => nodeRes.setHeader(key, value))
      const buf = Buffer.from(await response.arrayBuffer())
      nodeRes.end(buf)
    })()
  })
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.hostname, resolve))
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : (options.port ?? 0)
  return { port, stop: () => server.close() }
}
