// packages/http-api-projector/src/extensions/streaming.test.ts — @rhi-zone/fractal-http-api-projector
//
// Three kinds of coverage, mirroring codegen.test.ts's own split:
//   1. Unit: `streaming()`'s `decodeResponse` against hand-built SSE
//      `Response`s — recognizes the content type, reconstructs
//      `StreamEffect`s, surfaces the `event: done` payload as the
//      generator's return value, propagates malformed-frame errors, and
//      cancels the underlying reader on an early consumer break.
//   2. Runtime integration: `createClient` + `createFetch` (in-process, no
//      network) driving a REAL async-generator handler through `route.ts`'s
//      `streamAsSse` and back through `streaming()`'s `decodeResponse`.
//   3. Codegen: structural (manual `SchemaMap` with `x-stream`) and eval
//      end-to-end (real Bun server + a real generated module), proving the
//      emitted `AsyncIterable<T>`-returning operation actually streams.

import { afterAll, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import type { SchemaMap } from "@rhi-zone/fractal-api-tree/tree"
import type { JsonSchema } from "@rhi-zone/fractal-api-tree/extract"
import { createClient } from "../client.ts"
import { createFetch } from "../preset.ts"
import { httpProjection } from "../dx.ts"
import { generateClient } from "../codegen.ts"
import { serveBun } from "../adapter.ts"
import { streaming } from "./streaming.ts"
import type { DecodeContext } from "../extension.ts"

/** Placeholder `DecodeContext` for unit tests exercising `decodeResponse`
 *  directly — `streaming()` itself only reads its first parameter (`res`),
 *  same as any extension written against the original single-argument
 *  shape (see extension.ts's `DecodeContext` doc), but the declared TYPE of
 *  `decodeResponse` still requires a second argument at the call site. */
const testCtx: DecodeContext = {
  request: new Request("http://localhost/"),
  refetch: async () => new Response(),
  meta: {},
}

// ============================================================================
// 1. Unit — decodeResponse against hand-built SSE responses
// ============================================================================

/** One SSE response whose frames are pre-baked bytes, drip-fed via `pull` so
 *  the stream stays open (never closes on its own) until either every frame
 *  is consumed via repeated `pull`s or the reader is cancelled — lets a test
 *  break early and observe cancellation, which a stream that closes after
 *  one `enqueue` can't exercise. */
function openSseStream(frames: readonly string[]): { readonly response: Response; readonly cancelled: () => boolean } {
  const encoder = new TextEncoder()
  let idx = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx < frames.length) {
        controller.enqueue(encoder.encode(frames[idx]))
        idx++
      }
      // Past the last frame: stall forever (simulates an ongoing stream)
      // rather than closing, so a test can prove early-break cancellation.
    },
    cancel() {
      cancelled = true
    },
  })
  return {
    response: new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
    cancelled: () => cancelled,
  }
}

/** One SSE response that closes normally after its frames. */
function closedSseStream(frames: string): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames))
      controller.close()
    },
  })
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
}

describe("streaming() — decodeResponse", () => {
  it("declines a non-SSE response (falls through to the default decode)", () => {
    const ext = streaming()
    const res = new Response("{}", { headers: { "Content-Type": "application/json" } })
    expect(ext.decodeResponse?.(res, testCtx)).toBeUndefined()
  })

  it("recognizes text/event-stream and hands back an AsyncIterable", () => {
    const ext = streaming()
    const res = closedSseStream("data: 1\n\n" + "event: done\ndata: 2\n\n")
    const decoded = ext.decodeResponse?.(res, testCtx)
    expect(decoded).toBeDefined()
    expect(typeof (decoded?.value as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function")
  })

  it("yields plain data frames and returns the event: done payload as the generator's return value", async () => {
    const ext = streaming()
    const res = closedSseStream("data: 1\n\n" + "data: 2\n\n" + 'event: done\ndata: {"total":2}\n\n')
    const iterable = (ext.decodeResponse?.(res, testCtx)?.value ?? undefined) as AsyncGenerator<unknown, unknown, undefined>

    const yielded: unknown[] = []
    let step = await iterable.next()
    while (!step.done) {
      yielded.push(step.value)
      step = await iterable.next()
    }
    expect(yielded).toEqual([1, 2])
    expect(step.value).toEqual({ total: 2 })
  })

  it("reconstructs a StreamProgress effect's kind tag, stripped server-side", async () => {
    const ext = streaming()
    const res = closedSseStream('event: progress\ndata: {"progress":1,"total":4}\n\n' + "event: done\ndata: null\n\n")
    const iterable = (ext.decodeResponse?.(res, testCtx)?.value ?? undefined) as AsyncGenerator<unknown, unknown, undefined>

    const step = await iterable.next()
    expect(step.value).toEqual({ kind: "progress", progress: 1, total: 4 })
  })

  it("propagates a malformed (non-JSON) data line as a rejection", async () => {
    const ext = streaming()
    const res = closedSseStream("data: {not valid json\n\n")
    const iterable = (ext.decodeResponse?.(res, testCtx)?.value ?? undefined) as AsyncGenerator<unknown, unknown, undefined>
    await expect(iterable.next()).rejects.toThrow(/Malformed SSE frame/)
  })

  it("cancels the underlying reader when the consumer breaks early", async () => {
    const ext = streaming()
    const { response, cancelled } = openSseStream(["data: 1\n\n", "data: 2\n\n"])
    const iterable = (ext.decodeResponse?.(response, testCtx)?.value ?? undefined) as AsyncGenerator<unknown, unknown, undefined>

    const first = await iterable.next()
    expect(first.value).toBe(1)
    expect(cancelled()).toBe(false)

    // Equivalent to a `for await (...) { break }` — the for-await protocol
    // calls `.return()` on early exit.
    await iterable.return(undefined)
    expect(cancelled()).toBe(true)
  })
})

// ============================================================================
// 2. Runtime integration — createClient + createFetch, no network
// ============================================================================

describe("streaming() — createClient integration (in-process, no network)", () => {
  async function* gen(): AsyncGenerator<unknown, { total: number }, undefined> {
    yield { kind: "progress", progress: 1, total: 3 }
    yield { kind: "chunk", data: "a" }
    yield "b"
    return { total: 2 }
  }

  const streamNode = api_({
    generate: op((_: unknown) => gen(), {
      http: { directives: [{ kind: "method", value: "GET" }] },
    }),
  })

  it("reassembles the server's SSE stream back into the original yields + return value", async () => {
    const serverFetch = createFetch(streamNode)
    const client = createClient(streamNode, {
      baseUrl: "http://localhost",
      fetch: serverFetch,
      extensions: [streaming()],
    })

    const iterable = (await client.generate()) as AsyncGenerator<unknown, unknown, undefined>
    const yielded: unknown[] = []
    let step = await iterable.next()
    while (!step.done) {
      yielded.push(step.value)
      step = await iterable.next()
    }

    expect(yielded).toEqual([{ kind: "progress", progress: 1, total: 3 }, "a", "b"])
    expect(step.value).toEqual({ total: 2 })
  })

  it("without streaming(), the raw SSE text comes back as an unparsed string", async () => {
    const serverFetch = createFetch(streamNode)
    const client = createClient(streamNode, { baseUrl: "http://localhost", fetch: serverFetch })

    const raw = (await client.generate()) as unknown as string
    expect(typeof raw).toBe("string")
    expect(raw).toContain("event: done")
  })
})

// ============================================================================
// 3. Codegen — structural + eval end-to-end
// ============================================================================

describe("generateClient — streaming() codegen", () => {
  const tree = api_({
    generate: op((_: unknown): unknown[] => [], {
      http: { directives: [{ kind: "method", value: "GET" }] },
    }),
  })
  const route = httpProjection(tree)
  const manualSchemas: SchemaMap = {
    generate_get: {
      inputSchema: {},
      outputSchema: { type: "array", items: { type: "string" }, "x-stream": true } as JsonSchema,
    },
  }

  it("emits Promise<Array<T>> (unchanged) when streaming() is NOT included, even for an x-stream schema", () => {
    const withoutExt = generateClient(route, manualSchemas)
    expect(withoutExt).not.toContain("__requestStream")
    expect(withoutExt).toMatch(/readonly generate: \(callOpts\?: CallOptions\) => Promise<GenerateGetOutput>/)
    expect(withoutExt).toContain("export type GenerateGetOutput = Array<string>")
  })

  it("emits AsyncIterable<T> and a __requestStream call when streaming() is included", () => {
    const withExt = generateClient(route, manualSchemas, { extensions: [streaming()] })
    expect(withExt).toContain("__requestStream(")
    expect(withExt).toMatch(/readonly generate: \(callOpts\?: CallOptions\) => AsyncIterable<GenerateGetOutput>/)
    expect(withExt).toContain("export type GenerateGetOutput = string")
    expect(withExt).toMatch(/generate: \(callOpts\?: CallOptions\): AsyncIterable<GenerateGetOutput> =>/)
    expect(withExt).toMatch(/__requestStream\(baseUrl, fetchImpl, headers, "GET", `\/generate`, undefined,/)
  })
})

describe("generateClient — streaming() eval end-to-end against a real server", () => {
  let server: { port: number; stop(closeActiveConnections?: boolean): void } | undefined
  let tmpDir: string | undefined

  afterAll(async () => {
    server?.stop(true)
    if (tmpDir !== undefined) await rm(tmpDir, { recursive: true, force: true })
  })

  async function* gen(): AsyncGenerator<unknown, { total: number }, undefined> {
    yield { kind: "progress", progress: 1, total: 3 }
    yield { kind: "chunk", data: "a" }
    yield "b"
    return { total: 2 }
  }

  const streamNode = api_({
    generate: op((_: unknown) => gen(), {
      http: { directives: [{ kind: "method", value: "GET" }] },
    }),
  })

  it("a generated client's __requestStream reassembles a real SSE response over real HTTP", async () => {
    const route = httpProjection(streamNode)
    const manualSchemas: SchemaMap = {
      generate_get: {
        inputSchema: {},
        outputSchema: { type: "array", items: {}, "x-stream": true } as JsonSchema,
      },
    }
    const source = generateClient(route, manualSchemas, { extensions: [streaming()] })

    const fetchHandler = createFetch(streamNode)
    server = serveBun(fetchHandler, { port: 0 })

    tmpDir = await mkdtemp(join(tmpdir(), "fractal-codegen-streaming-"))
    const modulePath = join(tmpDir, "client.ts")
    await writeFile(modulePath, source, "utf8")
    const mod = (await import(pathToFileURL(modulePath).href)) as {
      createClient: (baseUrl: string) => { readonly generate: () => AsyncGenerator<unknown, unknown, undefined> }
    }

    const client = mod.createClient(`http://localhost:${server.port}`)
    const iterable = client.generate()

    const yielded: unknown[] = []
    let step = await iterable.next()
    while (!step.done) {
      yielded.push(step.value)
      step = await iterable.next()
    }

    expect(yielded).toEqual([{ kind: "progress", progress: 1, total: 3 }, "a", "b"])
    expect(step.value).toEqual({ total: 2 })
  })
})
