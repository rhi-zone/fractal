// packages/http-api-projector/src/extensions/streaming.ts — @rhi-zone/fractal-http-api-projector
//
// Built-in `ClientExtension`: consumes the Server-Sent-Events stream
// `route.ts`'s `streamAsSse` produces for a handler that returns an
// `AsyncIterable<T>` (see api-tree/src/index.ts's `StreamEffect`), turning
// the wire format back into an `AsyncIterable` on the client side. The
// server's format (module doc, route.ts):
//   - each yielded value → a plain `data: <json>\n\n` frame, UNLESS it's a
//     `StreamProgress` effect, which is sent as `event: progress\ndata:
//     <json-without-kind>\n\n` (a `StreamChunk`'s own `kind`/wrapper is
//     already stripped server-side too — its `data` field is sent bare, so
//     it's indistinguishable on the wire from an untagged yielded value,
//     BY DESIGN: see route.ts's `streamAsSse` doc)
//   - the generator's return value (distinct from what it yields) → one
//     final `event: done\ndata: <json>\n\n` frame before the stream closes
//
// Two independent implementations of the same parse, one per interpreter
// (see ../extension.ts's module doc):
//   - `decodeResponse` recognizes a `Content-Type: text/event-stream`
//     response and hands back an `AsyncGenerator` built from `res.body`,
//     instead of letting `client.ts`'s `makeCaller` run its default JSON/
//     text decode (which would hang forever trying to buffer an
//     unbounded/never-closing stream).
//   - `codegen.streamingCall` emits a call to `__requestStream` (see
//     `STREAMING_CODEGEN_HELPERS`) — an `async function*` in the generated
//     client, so calling it returns the `AsyncGenerator` SYNCHRONOUSLY (an
//     async generator function's body doesn't start running until the
//     first `.next()`), matching this extension's contract that a streaming
//     operation returns `AsyncIterable<T>` directly, not `Promise<T>`.
//
// Cleanup: an early consumer `break` out of a `for await` loop calls the
// iterator's `.return()`, which resumes the generator as if a `return`
// statement ran at its current suspension point — running through the
// `finally` blocks below, which cancel the underlying stream reader
// (`reader.cancel()`), closing the connection instead of leaking it.
//
// Error handling: a dropped connection surfaces as `reader.read()`
// rejecting, and a malformed `data:` line (invalid JSON) is caught and
// rethrown with a descriptive message — both propagate as the generator's
// `.next()` rejecting, ordinary async-iterator error semantics.

import type { ClientExtension, DecodedResponse } from "../extension.ts"

// ============================================================================
// Runtime
// ============================================================================

function isSseResponse(res: Response): boolean {
  return (res.headers.get("Content-Type") ?? "").includes("text/event-stream")
}

type SseFrame = { readonly event?: string | undefined; readonly data: unknown }

/**
 * Parse a `ReadableStream<Uint8Array>` of SSE bytes into a stream of
 * `{ event?, data }` frames, one per blank-line-terminated frame (per the
 * SSE spec, and exactly what `route.ts`'s `sseFrame` writes: `event: <name>`
 * optional, then `data: <json>`, then a blank line).
 */
async function* parseSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame, void, undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawFrame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        if (rawFrame.length === 0) continue

        let event: string | undefined
        let dataLine: string | undefined
        for (const line of rawFrame.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7)
          else if (line.startsWith("data: ")) dataLine = line.slice(6)
        }
        if (dataLine === undefined) continue

        let data: unknown
        try {
          data = JSON.parse(dataLine)
        } catch (err) {
          throw new Error(`Malformed SSE frame: could not JSON.parse data line ${JSON.stringify(dataLine)}`, {
            cause: err,
          })
        }
        yield { event, data }
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Already closed/errored — cancel() on a dead reader is a no-op we don't care about.
    }
  }
}

/**
 * Reconstruct a `StreamEffect`-shaped value from one parsed SSE frame — the
 * client-side counterpart to `streamAsSse`'s server-side tagging (route.ts):
 * a `progress` frame had its `kind` stripped before transmission (only the
 * bare `{ progress, total?, message? }` payload was sent), so it's restored
 * here to `{ kind: "progress", ... }`. A plain data frame (no `event` name —
 * this is also what an originally-yielded `StreamChunk` degrades to once its
 * own wrapper is stripped server-side) is handed back as-is.
 */
function toYieldedValue(frame: SseFrame): unknown {
  if (frame.event === "progress") {
    return { kind: "progress", ...(frame.data as Record<string, unknown>) }
  }
  return frame.data
}

/**
 * Drain an SSE `Response` into an `AsyncGenerator` matching what the
 * ORIGINAL server-side handler yielded/returned: yields reconstructed
 * `StreamEffect`/plain values, and its own return value is the `event: done`
 * frame's payload (the handler's generator return value, round-tripped).
 */
async function* consumeSseStream(res: Response): AsyncGenerator<unknown, unknown, undefined> {
  if (res.body === null) {
    throw new Error("Streaming response has no body")
  }
  for await (const frame of parseSseFrames(res.body)) {
    if (frame.event === "done") return frame.data
    yield toYieldedValue(frame)
  }
}

/**
 * SSE-consuming client extension: recognizes a `text/event-stream` response
 * and hands the caller back an `AsyncIterable` reassembling the original
 * handler's yields/return, instead of the client's default JSON/text decode.
 *
 * @example
 * const client = createClient(node, { extensions: [streaming()] })
 * for await (const chunk of await client.generate({ prompt })) { ... }
 */
export function streaming(): ClientExtension {
  const decodeResponse = (res: Response): DecodedResponse | undefined => {
    if (!isSseResponse(res)) return undefined
    return { value: consumeSseStream(res) }
  }

  return {
    name: "streaming",
    decodeResponse,
    codegen: {
      helpers: STREAMING_CODEGEN_HELPERS,
      streamingCall: (args) =>
        `__requestStream(${args.baseUrlExpr}, ${args.fetchExpr}, ${args.headersExpr}, "${args.method}", ` +
        `\`${args.pathLiteral}\`, ${args.inputExpr}, ${args.baseTimeoutExpr}, ${args.baseSignalExpr}, ${args.callOptsExpr})`,
    },
  }
}

// ============================================================================
// Codegen helper source — emitted verbatim into generated client files that
// use `streaming()`. Mirrors the runtime parse above against the platform
// `fetch(url, init)` shape (see codegen.ts's `__request`), reusing
// `__resolveSignal`/`__describeAbort`/`ClientError` from codegen.ts's
// unconditionally-emitted `RUNTIME_HELPERS` (emitted before any extension
// helpers — see codegen.ts's `render`).
// ============================================================================

const STREAMING_CODEGEN_HELPERS = `
type __SseFrame = { readonly event?: string; readonly data: unknown }

async function* __parseSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<__SseFrame, void, undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf("\\n\\n")) !== -1) {
        const rawFrame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        if (rawFrame.length === 0) continue

        let event: string | undefined
        let dataLine: string | undefined
        for (const line of rawFrame.split("\\n")) {
          if (line.startsWith("event: ")) event = line.slice(7)
          else if (line.startsWith("data: ")) dataLine = line.slice(6)
        }
        if (dataLine === undefined) continue

        let data: unknown
        try {
          data = JSON.parse(dataLine)
        } catch (err) {
          throw new Error(\`Malformed SSE frame: could not JSON.parse data line \${JSON.stringify(dataLine)}\`, { cause: err })
        }
        yield { event, data }
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Already closed/errored.
    }
  }
}

function __sseYieldedValue(frame: __SseFrame): unknown {
  if (frame.event === "progress") {
    return { kind: "progress", ...(frame.data as Record<string, unknown>) }
  }
  return frame.data
}

async function* __requestStream(
  baseUrl: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string> | undefined,
  method: string,
  path: string,
  input: unknown,
  baseTimeout: number | undefined,
  baseSignal: AbortSignal | undefined,
  callOpts: CallOptions | undefined,
): AsyncGenerator<unknown, unknown, undefined> {
  const timeout = callOpts?.timeout ?? baseTimeout
  const signal = __resolveSignal(baseTimeout, baseSignal, callOpts) ?? null

  let url: string
  const init: RequestInit = { method, headers: { ...(headers ?? {}) }, signal }

  if (method === "GET" || method === "HEAD" || method === "DELETE") {
    const isAbsolute = baseUrl.startsWith("http")
    const u = new URL(path, isAbsolute ? baseUrl : "http://localhost")
    if (input !== null && input !== undefined && typeof input === "object") {
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
      }
    }
    url = isAbsolute ? u.toString() : \`\${baseUrl}\${u.pathname}\${u.search}\`
  } else {
    url = \`\${baseUrl}\${path}\`
    init.headers = { ...(init.headers as Record<string, string>), "Content-Type": "application/json" }
    init.body = JSON.stringify(input ?? {})
  }

  let res: Response
  try {
    res = await fetchImpl(url, init)
  } catch (err) {
    throw __describeAbort(err, method, path, timeout)
  }

  if (!res.ok) {
    const ct = res.headers.get("Content-Type") ?? ""
    const body = ct.includes("application/json") ? await res.json() : await res.text()
    throw new ClientError(res.status, res.statusText, body)
  }
  if (res.body === null) {
    throw new Error("Streaming response has no body")
  }

  for await (const frame of __parseSseFrames(res.body)) {
    if (frame.event === "done") return frame.data
    yield __sseYieldedValue(frame)
  }
}`.trim()
