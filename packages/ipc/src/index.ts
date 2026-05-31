// @rhi-zone/fractal-ipc
// IPC adapters over the unified duplex-channel transport (rpc-dispatch).
//
// Two persistent-duplex transports, both wrapping their concrete medium as a
// `Channel` and composing it with a codec + the `correlation` protocol via
// `compose` (client) / `attach` (server) — all RPC logic (correlation,
// multiplexing, streaming, cancellation) and encoding live in rpc-dispatch:
//
//   worker_threads → a `MessagePort` (node:worker_threads, or a web
//                    MessageChannel) as a `Channel<unknown>` + the IDENTITY
//                    `structuredCloneCodec`: the medium clones the object, so the
//                    message IS the wire unit — no JSON round-trip.
//     client → `portClient(node, port)`        server → `servePort(tree, port, …)`
//
//   stdio          → a readable/writable pair (process.stdin/stdout, or any
//                    Duplex) as a `Channel<string>` (it owns LINE framing only) +
//                    `jsonCodec`. This is the MCP / LSP-style transport.
//     client → `stdioClient(node, {in, out})`  server → `serveStdio(tree, {in,out}, …)`

import {
  attach,
  compose,
  clientOver,
  correlation,
  jsonCodec,
  structuredCloneCodec,
  type Channel,
  type DispatcherOptions,
} from '@rhi-zone/fractal-rpc-dispatch'
import type { AnyNode, UClient } from '@rhi-zone/fractal-core'

/** Options for an IPC server attach (capability grants). */
type AttachOptions = DispatcherOptions

// ── worker_threads: MessagePort ───────────────────────────────────────────────

/**
 * The MessagePort surface used here — covers both `node:worker_threads`
 * MessagePort and the web `MessageChannel` port. Only the members we touch are
 * declared (avoids @types/node). `on('message', …)` (Node) and
 * `addEventListener('message', …)` (web) are both supported.
 */
export interface MessagePortLike {
  postMessage(value: unknown): void
  on?(event: 'message', cb: (value: unknown) => void): void
  addEventListener?(event: 'message', cb: (ev: { data: unknown }) => void): void
  start?(): void
  close?(): void
}

/**
 * Wrap a {@link MessagePortLike} as a {@link Channel}<unknown>: the medium moves
 * whole objects and structured-clones them on transfer, so it owns "framing" by
 * message boundary. Paired with the identity {@link structuredCloneCodec} (no
 * JSON), any clone-transferable value (TypedArrays, Maps, …) inside a Result
 * survives.
 */
export const portChannel = (port: MessagePortLike): Channel<unknown> => ({
  send(msg) {
    port.postMessage(msg)
  },
  onMessage(cb) {
    if (typeof port.on === 'function') {
      port.on('message', (value) => cb(value))
    } else if (typeof port.addEventListener === 'function') {
      port.addEventListener('message', (ev) => cb(ev.data))
    }
    port.start?.()
  },
  close() {
    port.close?.()
  },
})

/** Build a typed client over a {@link MessagePortLike} (structured clone). */
export const portClient = <N extends AnyNode>(node: N, port: MessagePortLike): UClient<N> =>
  clientOver(node, compose(portChannel(port), structuredCloneCodec, correlation))

/** Attach a node tree to a {@link MessagePortLike} as the server. Returns a detach fn. */
export const servePort = (
  tree: AnyNode,
  port: MessagePortLike,
  options: AttachOptions = {},
): (() => void) => attach(tree, portChannel(port), structuredCloneCodec, correlation, options)

// ── stdio: line-framed JSON over a readable/writable pair ─────────────────────

/** Minimal writable stream surface (process.stdout, any Node Writable). */
export interface WritableLike {
  write(chunk: string): unknown
  end?(): void
}
/** Minimal readable stream surface (process.stdin, any Node Readable). */
export interface ReadableLike {
  on(event: 'data', cb: (chunk: unknown) => void): void
  on(event: 'end', cb: () => void): void
}

/** A stdio endpoint: where to read framed messages from and write them to. */
export interface StdioEnds {
  readonly in: ReadableLike
  readonly out: WritableLike
}

const toText = (chunk: unknown): string =>
  typeof chunk === 'string'
    ? chunk
    : chunk instanceof Uint8Array
      ? new TextDecoder().decode(chunk)
      : String(chunk)

/**
 * Wrap a readable/writable pair as a {@link Channel}<string> that owns LINE
 * framing ONLY: each outbound wire unit is written as `frame + '\n'`; inbound
 * bytes are split on '\n' and each non-empty line is emitted as a string. Value
 * encoding (JSON) is the codec's job — composed with {@link jsonCodec}, this is
 * the MCP/LSP-style transport, robust over pipes that chunk arbitrarily.
 */
export const stdioChannel = (ends: StdioEnds): Channel<string> => {
  let buffer = ''
  return {
    send(frame) {
      ends.out.write(frame + '\n')
    },
    onMessage(cb) {
      ends.in.on('data', (chunk) => {
        buffer += toText(chunk)
        let nl: number
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          if (line.length > 0) cb(line)
        }
      })
    },
    close() {
      ends.out.end?.()
    },
  }
}

/** Build a typed client over a stdio pair (line-framed JSON). */
export const stdioClient = <N extends AnyNode>(node: N, ends: StdioEnds): UClient<N> =>
  clientOver(node, compose(stdioChannel(ends), jsonCodec, correlation))

/** Attach a node tree to a stdio pair as the server. Returns a detach fn. */
export const serveStdio = (
  tree: AnyNode,
  ends: StdioEnds,
  options: AttachOptions = {},
): (() => void) => attach(tree, stdioChannel(ends), jsonCodec, correlation, options)
