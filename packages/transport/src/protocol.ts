// @rhi-zone/fractal-transport/protocol
// PROTOCOL axis — one of the three orthogonal transport axes (channel × codec ×
// protocol). A Protocol is the CALL SEMANTICS over a medium: how a `path +
// input (+ meta)` becomes one or more wire envelopes, how a Result (or stream of
// Results) comes back, how concurrent calls are correlated, and how the server
// side frames its responses. It depends ONLY on a {@link MessageStream} (decoded
// envelopes — the {@link Codec} layer is below it) and on the shared
// {@link Dispatcher} (server side).
//
// This kernel module declares the protocol-axis INTERFACES (`Protocol`,
// `Exchange`, `ExchangeResponse`) and the AXIS ASSEMBLERS (`compose`/`attach` for
// the duplex `MessageStream` form, `composeRequestResponse` for the one-shot
// `Exchange` form). The assemblers are generic over any protocol/exchange; the
// concrete protocol INSTANCES live in their own per-axis packages:
//   - `@rhi-zone/fractal-protocol-correlation`        → correlation
//   - `@rhi-zone/fractal-protocol-request-response`   → requestResponse helpers
//
// RESERVED seams (NOT implemented): JSON-RPC, dbus, gRPC — each would be a new
// `Protocol` value, plugged into `compose` without changing the kernel. A
// protocol MAY constrain/carry its own codec.

import type { AnyNode, Meta, Result } from '@rhi-zone/fractal-core'
import type {
  DispatcherOptions,
  Transport,
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

// ── request-response axis (one-shot Exchange form) ────────────────────────────
// A SECOND protocol family. Unlike the duplex `Protocol` (a persistent
// `MessageStream`), each call is its OWN request/response exchange — correlation
// is implicit (one round-trip = one call), so there is no `id` and no
// multiplexing. The medium is a request-scoped {@link Exchange}: it carries one
// encoded request body and returns one encoded response (or a stream of encoded
// response units). HTTP is the present instance (URL path addressing,
// status→ok/error mapping, NDJSON streaming — see the request-response /
// channel-http packages).

/** One unary response from an {@link Exchange}: an ok/error flag + an encoded body. */
export interface ExchangeResponse<W> {
  /** Whether the medium reports success (HTTP: 2xx). Maps to the Result's ok-ness. */
  readonly ok: boolean
  /** The encoded response body (the codec decodes it into the Result payload). */
  readonly body: W
}

/**
 * A request-scoped medium for the request-response protocol form: each call is
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
