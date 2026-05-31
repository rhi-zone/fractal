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
// `Exchange`, `ExchangeResponse`) and the AXIS ASSEMBLERS: `compose`/`attach`
// for the duplex `MessageStream` form, and `composeRequestResponse` (client) +
// `serveExchange` (server) for the one-shot `Exchange` form. The assemblers are
// generic over any protocol/exchange; the concrete duplex protocol INSTANCE
// lives in its own per-axis package:
//   - `@rhi-zone/fractal-protocol-correlation`        → correlation
// The one-shot request/response form has NO standalone package — its whole logic
// IS `composeRequestResponse` + `serveExchange` here; HTTP is its instance
// (fractal-channel-http supplies the `httpExchange` medium + server handlers).
//
// RESERVED seams (NOT implemented): JSON-RPC, dbus, gRPC — each would be a new
// `Protocol` value, plugged into `compose` without changing the kernel. A
// protocol MAY constrain/carry its own codec.

import type { AnyNode, Meta, Result } from '@rhi-zone/fractal-core'
import {
  dispatcher,
  type DispatcherOptions,
  type DispatchOutcome,
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

// ── request-response axis: SERVER side ────────────────────────────────────────
// The server analogue of `composeRequestResponse`. It owns the SAME codec seam
// the client side does — decode the encoded request body into the leaf input,
// run the shared `dispatcher`, then encode the response payload(s) back to the
// wire unit `W`. What it does NOT own is the medium's framing: a unary outcome
// is reported as `{ kind:'unary', result, body }` so the channel can map the
// Result's ok-ness onto a transport status (HTTP 2xx/4xx); a streaming outcome
// is reported as `{ kind:'stream', units }` of pre-encoded `W` so the channel
// can frame them (HTTP NDJSON). This keeps the channel codec-AGNOSTIC: it never
// calls `JSON.stringify`/`JSON.parse` — only `codec.encode`/`codec.decode` here.

/**
 * A request whose body is still the encoded wire unit `W` (codec not yet
 * applied). Channels MAY attach their own extra fields (e.g. HTTP `headers`,
 * `segments`) — those flow through onto the {@link DispatchRequest} unchanged so
 * capability grants written against a channel's request shape keep working.
 */
export interface EncodedRequest<W> {
  readonly path: readonly string[]
  /** The encoded request body; `serveExchange` decodes it via the codec. */
  readonly body: W
  readonly meta?: Meta
  readonly signal?: AbortSignal
  /** Channel-specific extras passed through to grants (HTTP headers, …). */
  readonly [extra: string]: unknown
}

/**
 * The codec-encoded result of one server-side exchange. A unary outcome carries
 * both the original `Result` (so the channel can map ok-ness → transport status)
 * and the encoded body; a stream carries an AsyncIterable of pre-encoded units.
 */
export type EncodedOutcome<W> =
  | { readonly kind: 'unary'; readonly result: Result<unknown, unknown>; readonly body: W }
  | { readonly kind: 'stream'; readonly units: AsyncIterable<W> }

/**
 * Build a server-side request-response handler from a node tree + a {@link Codec}:
 * the request-response analogue of {@link attach}. Returns a function from an
 * {@link EncodedRequest} to an {@link EncodedOutcome}. The codec seam lives HERE
 * (decode request body, encode response payloads), so the channel handler stays
 * codec-agnostic and only does medium framing + status mapping.
 *
 *   unary  → decode body, dispatch, encode the ok-value or error payload.
 *   stream → decode body, dispatch, encode each framed `Result` as one unit.
 */
export const serveExchange = <W>(
  tree: AnyNode,
  codec: Codec<W>,
  options: DispatcherOptions = {},
): ((req: EncodedRequest<W>) => Promise<EncodedOutcome<W>>) => {
  const dispatch = dispatcher(tree, options)
  return async (req: EncodedRequest<W>): Promise<EncodedOutcome<W>> => {
    // Spread the channel's extra fields through to grants, then overwrite the
    // canonical dispatch fields (decoding the body) so they take precedence.
    const dreq = {
      ...req,
      path: req.path,
      input: codec.decode(req.body),
      ...(req.meta !== undefined ? { meta: req.meta } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    } as unknown as DispatchRequest
    const outcome: DispatchOutcome = await dispatch(dreq)
    if (outcome.kind === 'unary') {
      const result = outcome.result
      const payload = result.ok ? result.value : result.error
      return { kind: 'unary', result, body: codec.encode(payload) }
    }
    const stream = outcome.stream
    const units = (async function* (): AsyncIterable<W> {
      for await (const item of stream) yield codec.encode(item)
    })()
    return { kind: 'stream', units }
  }
}
