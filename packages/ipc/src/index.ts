// @rhi-zone/fractal-ipc
// IPC adapters over the unified duplex-channel transport (rpc-dispatch).
//
// Two persistent-duplex transports, both wrapping their concrete channel as a
// `Channel` and deferring all RPC logic (correlation, multiplexing, streaming,
// cancellation) to rpc-dispatch's `channelTransport` / `attachChannel`:
//
//   worker_threads → a `MessagePort` (node:worker_threads, or a web
//                    MessageChannel). Structured clone — NO JSON framing needed;
//                    the message IS the object.
//     client → `portClient(node, port)`        server → `servePort(tree, port, …)`
//
//   stdio          → a readable/writable pair (process.stdin/stdout, or any
//                    Duplex). LINE-FRAMED JSON: one JSON object per '\n'-line.
//                    This is the MCP / LSP-style transport.
//     client → `stdioClient(node, {in, out})`  server → `serveStdio(tree, {in,out}, …)`

import {
  attachChannel,
  channelTransport,
  clientOver,
  type AttachOptions,
  type Channel,
} from '@rhi-zone/fractal-rpc-dispatch'
import type { AnyNode, UClient } from '@rhi-zone/fractal-core'

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
 * Wrap a {@link MessagePortLike} as a {@link Channel}. The transport unit is the
 * structured-cloned message object itself — no JSON framing, so any
 * clone-transferable value (TypedArrays, Maps, …) inside a Result survives.
 */
export const portChannel = (port: MessagePortLike): Channel => ({
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

/** Build a typed client over a {@link MessagePortLike}. */
export const portClient = <N extends AnyNode>(node: N, port: MessagePortLike): UClient<N> =>
  clientOver(node, channelTransport(portChannel(port)))

/** Attach a node tree to a {@link MessagePortLike} as the server. Returns a detach fn. */
export const servePort = (
  tree: AnyNode,
  port: MessagePortLike,
  options: AttachOptions = {},
): (() => void) => attachChannel(tree, portChannel(port), options)

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
 * Wrap a readable/writable pair as a {@link Channel} with LINE-FRAMED JSON: each
 * message is `JSON.stringify(msg) + '\n'` on the wire; inbound bytes are split
 * on '\n' and each non-empty line is `JSON.parse`d. This is the MCP/LSP-style
 * transport — robust over pipes that chunk arbitrarily.
 */
export const stdioChannel = (ends: StdioEnds): Channel => {
  let buffer = ''
  return {
    send(msg) {
      ends.out.write(JSON.stringify(msg) + '\n')
    },
    onMessage(cb) {
      ends.in.on('data', (chunk) => {
        buffer += toText(chunk)
        let nl: number
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          if (line.length > 0) cb(JSON.parse(line))
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
  clientOver(node, channelTransport(stdioChannel(ends)))

/** Attach a node tree to a stdio pair as the server. Returns a detach fn. */
export const serveStdio = (
  tree: AnyNode,
  ends: StdioEnds,
  options: AttachOptions = {},
): (() => void) => attachChannel(tree, stdioChannel(ends), options)
