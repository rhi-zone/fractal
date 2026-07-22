// packages/http-api-projector/src/codegen-extensions.test.ts — @rhi-zone/fractal-http-api-projector
//
// Integration: `CodegenOptions.extensions` baked into generated source,
// then eval'd and driven against a real Bun server (same eval methodology
// as codegen.test.ts's "eval end-to-end" describe block) — proves
// `retry()` in the codegen path isn't just plausible-looking emitted text
// but an actually-working retry loop wrapping real HTTP calls.

import { afterAll, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { generateClientFromNode } from "./codegen.ts"
import { createFetch } from "./preset.ts"
import { serveBun } from "./adapter.ts"
import { api, clearStore } from "../../../examples/library-api/src/tree.ts"
import { retry } from "./extensions/retry.ts"

describe("generateClientFromNode — extensions baked into generated source", () => {
  it("emits no extension helpers/wrap when extensions is omitted (backwards-compatible output)", () => {
    const withoutExt = generateClientFromNode(api)
    expect(withoutExt).not.toContain("__withRetry")
    expect(withoutExt).toContain("const fetchImpl = options.fetch ?? fetch")
  })

  it("emits the retry helper and wraps fetchImpl when extensions: [retry(...)] is passed", () => {
    const withExt = generateClientFromNode(api, undefined, { extensions: [retry({ maxRetries: 4 })] })
    expect(withExt).toContain("function __withRetry(")
    expect(withExt).toMatch(/const fetchImpl = __withRetry\(options\.fetch \?\? fetch, \{"maxRetries":4,/)
  })
})

describe("generateClientFromNode — retry() eval end-to-end against a real flaky server", () => {
  let server: { port: number; stop(closeActiveConnections?: boolean): void } | undefined
  let tmpDir: string | undefined

  afterAll(async () => {
    server?.stop(true)
    if (tmpDir !== undefined) await rm(tmpDir, { recursive: true, force: true })
  })

  it("the generated client's baked-in retry recovers from transient 503s over real HTTP", async () => {
    clearStore()
    const realFetchHandler = createFetch(api, { openapi: false })

    // A server that fails the first 2 requests to any path with 503, then
    // delegates to the real handler — proves the retry loop really re-sends
    // over the wire, not just re-calls a mocked function.
    let failuresLeft = 2
    const flakyHandler = async (req: Request): Promise<Response> => {
      if (failuresLeft > 0) {
        failuresLeft--
        return new Response("Service Unavailable", { status: 503 })
      }
      return realFetchHandler(req)
    }
    server = serveBun(flakyHandler, { port: 0 })

    const source = generateClientFromNode(api, undefined, {
      extensions: [retry({ maxRetries: 3, baseDelayMs: 1, jitter: false })],
    })

    tmpDir = await mkdtemp(join(tmpdir(), "fractal-codegen-retry-"))
    const modulePath = join(tmpDir, "client.ts")
    await writeFile(modulePath, source, "utf8")
    const mod = (await import(pathToFileURL(modulePath).href)) as {
      createClient: (baseUrl: string) => { readonly books: { readonly list: () => Promise<unknown[]> } }
    }

    const client = mod.createClient(`http://localhost:${server.port}`)
    const books = await client.books.list()
    expect(Array.isArray(books)).toBe(true)
    expect(failuresLeft).toBe(0)
  })
})
