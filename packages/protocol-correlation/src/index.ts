// @rhi-zone/fractal-protocol-correlation
// PROTOCOL axis instance — the duplex, multiplexed invoke/stream/cancel
// `correlation` protocol. One persistent connection carries many concurrent
// calls, keyed by an explicit per-message `id`. It is the call-semantics value
// used by the WebSocket, worker, and stdio channels (composed with jsonCodec or
// structuredCloneCodec via the kernel's `compose`/`attach`).
//
//   client → server : { id, kind:'invoke'|'stream', path, input, meta? }
//                      { id, kind:'cancel' }
//   server → client : { id, ok }                       (unary result)
//                      { id, item } / { id, end } / { id, error }   (stream)
//
// Depends only on the transport kernel: the `Protocol`/`MessageStream`/
// `Transport` interfaces, `DispatcherOptions`/`DispatchRequest`, and the shared
// `dispatcher` (server side).

import type { AnyNode, Meta, Result } from '@rhi-zone/fractal-core'
import {
  dispatcher,
  type DispatcherOptions,
  type DispatchRequest,
  type MessageStream,
  type Protocol,
  type Transport,
} from '@rhi-zone/fractal-transport'

// ── correlation protocol: client side ─────────────────────────────────────────

/** Client→server: open a unary or streaming call, or cancel an in-flight one. */
type InvokeMessage = { id: number; kind: 'invoke'; path: readonly string[]; input: unknown; meta?: Meta }
type StreamMessage = { id: number; kind: 'stream'; path: readonly string[]; input: unknown; meta?: Meta }
type CancelMessage = { id: number; kind: 'cancel' }
type ClientMessage = InvokeMessage | StreamMessage | CancelMessage

/** Server→client: a unary result, or one stream frame (item / end / error). */
type ServerMessage =
  | { id: number; ok: Result<unknown, unknown> }
  | { id: number; item: Result<unknown, unknown> }
  | { id: number; end: true }
  | { id: number; error: unknown }

/**
 * The correlation protocol's CLIENT transport over a decoded {@link MessageStream}.
 * Many concurrent calls are multiplexed by a monotonically-increasing `id`:
 *
 *   invoke → send `{id, kind:'invoke', …}`, resolve on the matching `{id, ok}`.
 *   stream → send `{id, kind:'stream', …}`, return an AsyncIterable that yields
 *            each matching `{id, item}` until `{id, end}` / `{id, error}`. On
 *            early `break`/`return`, send `{id, kind:'cancel'}` so the server
 *            aborts its generator.
 */
const correlationClient = (stream: MessageStream): Transport => {
  let nextId = 1
  const pendingInvoke = new Map<number, (r: Result<unknown, unknown>) => void>()
  const streams = new Map<number, StreamSink>()

  stream.onMessage((raw) => {
    const msg = raw as ServerMessage
    if (typeof msg !== 'object' || msg === null || typeof msg.id !== 'number') return
    if ('ok' in msg) {
      const resolve = pendingInvoke.get(msg.id)
      if (resolve) {
        pendingInvoke.delete(msg.id)
        resolve(msg.ok)
      }
      return
    }
    const sink = streams.get(msg.id)
    if (!sink) return
    if ('item' in msg) sink.push(msg.item)
    else if ('end' in msg) {
      streams.delete(msg.id)
      sink.end()
    } else if ('error' in msg) {
      // Surface a transport/dispatch error as one final error Result, then end —
      // mirrors the HTTP stream adapter's single-error-Result shape.
      streams.delete(msg.id)
      sink.push({ ok: false, error: msg.error } as Result<unknown, unknown>)
      sink.end()
    }
  })

  return {
    invoke(path, input, meta) {
      const id = nextId++
      return new Promise<Result<unknown, unknown>>((resolve) => {
        pendingInvoke.set(id, resolve)
        const msg: ClientMessage = meta !== undefined
          ? { id, kind: 'invoke', path, input, meta }
          : { id, kind: 'invoke', path, input }
        stream.send(msg)
      })
    },

    stream(path, input, meta): AsyncIterable<Result<unknown, unknown>> {
      const id = nextId++
      const sink = makeStreamSink()
      streams.set(id, sink)
      const open: ClientMessage = meta !== undefined
        ? { id, kind: 'stream', path, input, meta }
        : { id, kind: 'stream', path, input }
      stream.send(open)
      return {
        [Symbol.asyncIterator](): AsyncIterator<Result<unknown, unknown>> {
          const iter = sink.iterator()
          return {
            next: () => iter.next(),
            // Early stop (break/return): cancel the server-side call.
            return: (value?: unknown) => {
              if (streams.delete(id)) {
                const cancel: ClientMessage = { id, kind: 'cancel' }
                stream.send(cancel)
                sink.end()
              }
              return iter.return ? iter.return(value) : Promise.resolve({ done: true, value: undefined })
            },
          }
        },
      }
    },
  }
}

// A push/pull bridge: the channel callback PUSHES items; the AsyncIterable PULLS
// them. Buffers items that arrive before the consumer asks, and parks the
// consumer when it gets ahead of arrivals.
interface StreamSink {
  push(item: Result<unknown, unknown>): void
  end(): void
  iterator(): AsyncIterator<Result<unknown, unknown>>
}

const makeStreamSink = (): StreamSink => {
  const buffer: Result<unknown, unknown>[] = []
  let done = false
  let waiting: ((r: IteratorResult<Result<unknown, unknown>>) => void) | null = null

  const push = (item: Result<unknown, unknown>) => {
    if (waiting) {
      const w = waiting
      waiting = null
      w({ value: item, done: false })
    } else {
      buffer.push(item)
    }
  }
  const end = () => {
    done = true
    if (waiting) {
      const w = waiting
      waiting = null
      w({ value: undefined, done: true })
    }
  }
  return {
    push,
    end,
    iterator: () => ({
      next: () =>
        new Promise<IteratorResult<Result<unknown, unknown>>>((resolve) => {
          const next = buffer.shift()
          if (next !== undefined) resolve({ value: next, done: false })
          else if (done) resolve({ value: undefined, done: true })
          else waiting = resolve
        }),
      return: () => {
        done = true
        return Promise.resolve({ value: undefined, done: true })
      },
    }),
  }
}

// ── correlation protocol: server side ─────────────────────────────────────────

/**
 * The correlation protocol's SERVER attach over a decoded {@link MessageStream}.
 * On each inbound `invoke`/`stream` message it runs the shared {@link dispatcher}:
 *
 *   unary  → send `{id, ok: result}`.
 *   stream → iterate the dispatched AsyncIterable, send each `{id, item}`, then
 *            `{id, end}` (or `{id, error}` if iteration throws). A subsequent
 *            `{id, cancel}` aborts that call's `Context.signal`.
 *
 * Returns a detach function that aborts all in-flight streams and closes the
 * stream.
 */
const correlationServer = (
  tree: AnyNode,
  stream: MessageStream,
  options: DispatcherOptions = {},
): (() => void) => {
  const dispatch = dispatcher(tree, options)
  // Per-call abort controllers for in-flight streams, keyed by correlation id.
  const inflight = new Map<number, AbortController>()

  const onInvoke = async (msg: InvokeMessage) => {
    const req: DispatchRequest = msg.meta !== undefined
      ? { path: msg.path, input: msg.input, meta: msg.meta }
      : { path: msg.path, input: msg.input }
    const outcome = await dispatch(req)
    if (outcome.kind === 'unary') {
      send({ id: msg.id, ok: outcome.result })
    } else {
      send({
        id: msg.id,
        ok: { ok: false, error: { code: 'not_unary', message: 'leaf is streaming; use stream()' } },
      })
    }
  }

  const onStream = async (msg: StreamMessage) => {
    const controller = new AbortController()
    inflight.set(msg.id, controller)
    const req: DispatchRequest = msg.meta !== undefined
      ? { path: msg.path, input: msg.input, meta: msg.meta, signal: controller.signal }
      : { path: msg.path, input: msg.input, signal: controller.signal }
    try {
      const outcome = await dispatch(req)
      if (outcome.kind === 'unary') {
        // A streaming client opened a unary leaf: deliver the single Result as
        // one item then end, so the client's AsyncIterable yields exactly once.
        send({ id: msg.id, item: outcome.result })
        send({ id: msg.id, end: true })
        return
      }
      for await (const item of outcome.stream) {
        if (controller.signal.aborted) break
        send({ id: msg.id, item })
      }
      send({ id: msg.id, end: true })
    } catch (e) {
      send({ id: msg.id, error: errorPayload(e) })
    } finally {
      inflight.delete(msg.id)
    }
  }

  const send = (msg: ServerMessage) => stream.send(msg)

  stream.onMessage((raw) => {
    const msg = raw as ClientMessage
    if (typeof msg !== 'object' || msg === null || typeof msg.id !== 'number') return
    switch (msg.kind) {
      case 'invoke':
        void onInvoke(msg)
        break
      case 'stream':
        void onStream(msg)
        break
      case 'cancel': {
        const controller = inflight.get(msg.id)
        if (controller) controller.abort()
        break
      }
    }
  })

  return () => {
    for (const controller of inflight.values()) controller.abort()
    inflight.clear()
    stream.close()
  }
}

const errorPayload = (e: unknown): unknown =>
  e instanceof Error ? { code: 'stream_failed', message: e.message } : { code: 'stream_failed', message: String(e) }

/**
 * The duplex, multiplexed invoke/stream/cancel correlation Protocol. Shared by
 * the WebSocket and worker/stdio channels — composed with `jsonCodec`
 * (WS/stdio) or `structuredCloneCodec` (worker) plus the appropriate channel.
 */
export const correlation: Protocol = {
  client: correlationClient,
  server: correlationServer,
}
