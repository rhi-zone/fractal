// @rhi-zone/fractal-rpc-dispatch/protocol
// PROTOCOL axis — one of the three orthogonal transport axes (channel × codec ×
// protocol). A Protocol is the CALL SEMANTICS over a medium: how a `path +
// input (+ meta)` becomes one or more wire envelopes, how a Result (or stream of
// Results) comes back, how concurrent calls are correlated, and how the server
// side frames its responses. It depends ONLY on a {@link MessageStream} (decoded
// envelopes — the {@link Codec} layer is below it) and on the shared
// {@link Dispatcher} (server side).
//
// Two instances ship here:
//   - `correlation`     : the duplex, multiplexed invoke/stream/cancel protocol
//                         (one connection carries many concurrent calls, keyed
//                         by an explicit per-message `id`). WS + worker + stdio.
//   - `requestResponse` : the one-shot HTTP-style protocol (each call is its own
//                         request/response; correlation is implicit). Lives in
//                         the http package via the same `compose` seam.
//
// RESERVED seams (NOT implemented): JSON-RPC, dbus, gRPC — each would be a new
// `Protocol` value, plugged into `compose` without changing the core. A protocol
// MAY constrain/carry its own codec.
//
//   correlation wire (unchanged from the prior `channelTransport`/`attachChannel`):
//     client → server : { id, kind:'invoke'|'stream', path, input, meta? }
//                        { id, kind:'cancel' }
//     server → client : { id, ok }                       (unary result)
//                        { id, item } / { id, end } / { id, error }   (stream)

import type { AnyNode, Meta, Result } from '@rhi-zone/fractal-core'
import {
  dispatcher,
  type DispatcherOptions,
  type DispatchRequest,
  type Transport,
} from './index.ts'
import type { Channel, MessageStream } from './channel.ts'
import type { Codec } from './codec.ts'

// ── Protocol axis interface ───────────────────────────────────────────────────

/**
 * A Protocol expresses call semantics over a {@link MessageStream}. Both halves
 * of one RPC boundary:
 *
 *   - `client(stream)` → a {@link Transport} (the consumer-facing surface).
 *   - `server(tree, stream, options)` → a detach function; it runs the shared
 *     {@link Dispatcher} and frames responses per the protocol's wire shape.
 *
 * A Protocol is medium- and encoding-agnostic: it sees only decoded envelopes.
 * `compose`/`attach` pair it with a {@link Channel} + {@link Codec}.
 */
export interface Protocol {
  client(stream: MessageStream): Transport
  server(tree: AnyNode, stream: MessageStream, options?: DispatcherOptions): () => void
}

// ── compose / attach: the three-axis assemblers ──────────────────────────────

/**
 * Layer a {@link Codec} over a raw wire {@link Channel} to produce the decoded
 * {@link MessageStream} a {@link Protocol} consumes. This is the single seam
 * where encoding meets medium.
 */
const layerCodec = <W>(channel: Channel<W>, codec: Codec<W>): MessageStream => ({
  send: (msg) => channel.send(codec.encode(msg)),
  onMessage: (cb) => channel.onMessage((wire) => cb(codec.decode(wire))),
  close: () => channel.close(),
})

/**
 * CLIENT assembler: `compose(channel, codec, protocol) → Transport`. Layers the
 * codec over the channel and lets the protocol express call semantics over the
 * resulting decoded stream. The `W` of the channel and codec MUST match.
 */
export const compose = <W>(channel: Channel<W>, codec: Codec<W>, protocol: Protocol): Transport =>
  protocol.client(layerCodec(channel, codec))

/**
 * SERVER assembler: `attach(tree, channel, codec, protocol, options) → detach`.
 * The dual of {@link compose} for the server side.
 */
export const attach = <W>(
  tree: AnyNode,
  channel: Channel<W>,
  codec: Codec<W>,
  protocol: Protocol,
  options?: DispatcherOptions,
): (() => void) => protocol.server(tree, layerCodec(channel, codec), options)

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
 * the WS (rpc) and worker/stdio (ipc) adapters — composed with `jsonCodec`
 * (WS/stdio) or `structuredCloneCodec` (worker) plus the appropriate channel.
 */
export const correlation: Protocol = {
  client: correlationClient,
  server: correlationServer,
}

// ── request-response axis (HTTP-style one-shot) ───────────────────────────────
// A SECOND protocol family. Unlike the duplex `correlation` protocol, each call
// is its OWN request/response exchange — correlation is implicit (one round-trip
// = one call), so there is no `id` and no multiplexing. The medium is not a
// persistent `MessageStream` but a request-scoped {@link Exchange}: it carries
// one encoded request body and returns one encoded response (or a stream of
// encoded response units). HTTP is the present instance (URL path addressing,
// status→ok/error mapping, NDJSON streaming — see the http package).
//
// RESERVED: any other one-shot RPC (a plain POST-per-call JSON-RPC over fetch)
// would supply its own `Exchange` + the same `requestResponse` protocol.

/** One unary response from an {@link Exchange}: an ok/error flag + an encoded body. */
export interface ExchangeResponse<W> {
  /** Whether the medium reports success (HTTP: 2xx). Maps to the Result's ok-ness. */
  readonly ok: boolean
  /** The encoded response body (the codec decodes it into the Result payload). */
  readonly body: W
}

/**
 * A request-scoped medium for the {@link requestResponse} protocol: each call is
 * an independent addressed round-trip carrying already-encoded wire bodies `W`.
 * The medium owns addressing (URL path) and transport-level success (HTTP
 * status); it knows nothing of Result shapes or value encoding.
 *
 *   unary  : one encoded request body → one {@link ExchangeResponse}
 *   stream : one encoded request body → many encoded response units (each unit
 *            decodes to a full `Result` — the server frames Results directly,
 *            mirroring NDJSON)
 */
export interface Exchange<W = unknown> {
  unary(path: readonly string[], body: W, meta?: Meta): Promise<ExchangeResponse<W>>
  stream?(path: readonly string[], body: W, meta?: Meta): AsyncIterable<W>
}

/**
 * Build a {@link Transport} from an {@link Exchange} + {@link Codec}: the
 * request-response analogue of {@link compose}. The protocol's whole job is the
 * value↔Result mapping on top of the exchange:
 *
 *   invoke → encode input, do the unary exchange, then `ok ? {ok:true,value} :
 *            {ok:false,error}` over the DECODED response body.
 *   stream → encode input, do the streaming exchange, decode each response unit
 *            as a full `Result` (the server emits framed Results directly).
 *
 * `stream` is advertised on the Transport iff the Exchange provides one.
 */
export const composeRequestResponse = <W>(exchange: Exchange<W>, codec: Codec<W>): Transport => {
  const transport: Transport = {
    async invoke(path, input, meta) {
      const res = await exchange.unary(path, codec.encode(input), meta)
      const value = codec.decode(res.body)
      return (res.ok ? { ok: true, value } : { ok: false, error: value }) as Result<unknown, unknown>
    },
  }
  if (exchange.stream) {
    const streamFn = exchange.stream.bind(exchange)
    transport.stream = async function* (path, input, meta) {
      for await (const unit of streamFn(path, codec.encode(input), meta)) {
        yield codec.decode(unit) as Result<unknown, unknown>
      }
    }
  }
  return transport
}
