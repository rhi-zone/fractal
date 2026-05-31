// @rhi-zone/fractal-rpc
// WebSocket adapter over the unified duplex-channel transport (rpc-dispatch).
//
// WebSocket is a PERSISTENT DUPLEX connection, so this adapter does almost
// nothing of its own: it wraps a WebSocket as a `Channel<string>` (the medium
// moves text frames; it owns frame boundaries ONLY — encoding is the codec's
// job) and composes it with `jsonCodec` + the `correlation` protocol via
// `compose` (client) / `attach` (server). The correlation protocol, stream
// multiplexing, cancellation, and JSON encoding all live in rpc-dispatch.
//
//   client → `wsClient(node, url)`           wraps a `WebSocket` (the global)
//   server → `serveWsBun(tree, {grants})`    Bun's native Bun.serve websocket
//   server → `wsServerChannel(ws)`           generic ws-like wrapper (Node BYO)
//
// NODE WS-SERVER CAVEAT: Node has no built-in WebSocket *server*. Rather than
// install a dependency (`ws`), Node users bring their own server library and
// wrap each connection with `wsServerChannel(ws)` + `attachChannel`. See below.

import {
  attach,
  compose,
  clientOver,
  correlation,
  jsonCodec,
  type Channel,
  type DispatcherOptions,
} from '@rhi-zone/fractal-rpc-dispatch'
import type { AnyNode, UClient } from '@rhi-zone/fractal-core'

/** Options for the WS server attach (capability grants). */
type AttachOptions = DispatcherOptions

// ── Minimal WebSocket shapes ─────────────────────────────────────────────────
// We avoid lib.dom / @types — only the members used here are declared.

/** The client-side WebSocket surface this adapter uses (the global `WebSocket`). */
interface WebSocketLike {
  send(data: string): void
  close(): void
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void
  addEventListener(type: 'open', cb: () => void): void
  readyState: number
}
interface WebSocketCtor {
  new (url: string): WebSocketLike
  readonly OPEN: number
}

// ── Channel wrappers ──────────────────────────────────────────────────────────

/** Coerce a WebSocket message payload (string | Buffer | ArrayBuffer) to text. */
const toText = (data: unknown): string => {
  if (typeof data === 'string') return data
  // Bun/Node may deliver Buffer / ArrayBuffer / Uint8Array.
  if (data instanceof Uint8Array) return new TextDecoder().decode(data)
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data))
  return String(data)
}

/**
 * Wrap a ws-like object as a {@link Channel}<string>: it moves TEXT frames and
 * owns frame boundaries only — value encoding is the codec's concern. Outbound
 * sends before the socket is OPEN are buffered and flushed on `open`, so a
 * client can `invoke` immediately after construction without awaiting the
 * handshake.
 */
const wsChannel = (ws: WebSocketLike, isOpen: () => boolean): Channel<string> => {
  const outbox: string[] = []
  let open = isOpen()
  const flush = () => {
    open = true
    for (const frame of outbox.splice(0)) ws.send(frame)
  }
  if (!open && typeof ws.addEventListener === 'function') ws.addEventListener('open', flush)
  return {
    send(frame) {
      if (open) ws.send(frame)
      else outbox.push(frame)
    },
    onMessage(cb) {
      ws.addEventListener('message', (ev) => cb(toText(ev.data)))
    },
    close() {
      ws.close()
    },
  }
}

/**
 * Wrap a server-side ws-like connection as a {@link Channel}<string>. Accepts
 * any object with `send(string)`, `close()`, and `addEventListener('message',
 * …)` — Node users with the `ws` library can pass a `ws` connection here (BYO
 * server — see module header). Assumed already OPEN.
 */
export const wsServerChannel = (ws: WebSocketLike): Channel<string> => wsChannel(ws, () => true)

// ── Client ────────────────────────────────────────────────────────────────────

declare const WebSocket: WebSocketCtor

/** Options for {@link wsClient}: inject a WebSocket implementation (else global). */
export interface WsClientOptions {
  WebSocket?: WebSocketCtor
}

/**
 * Build a typed WebSocket client over a node tree. Opens a `WebSocket` to `url`,
 * wraps it as a {@link Channel}, and routes every call through the shared
 * `channelTransport`. Unary leaves return `Promise<Result>`; streaming leaves
 * return `AsyncIterable<Result>`. Per-call `meta` rides the correlation
 * envelope (no headers — WebSocket has none after the handshake).
 *
 * Works wherever the global `WebSocket` exists: Bun, Node 22+, Deno, browsers.
 */
export const wsClient = <N extends AnyNode>(
  node: N,
  url: string,
  opts?: WsClientOptions,
): UClient<N> => {
  const Ctor = opts?.WebSocket ?? WebSocket
  const ws = new Ctor(url)
  const channel = wsChannel(ws, () => ws.readyState === Ctor.OPEN)
  return clientOver(node, compose(channel, jsonCodec, correlation))
}

// ── Server (Bun native) ───────────────────────────────────────────────────────

// Minimal Bun.serve websocket shapes — only members used here. Avoids @types/bun.
interface BunServerWebSocket {
  send(data: string): void
  close(): void
  data: { detach?: () => void; onMessage?: (frame: string) => void }
}
interface BunWebSocketHandlers {
  open(ws: BunServerWebSocket): void
  message(ws: BunServerWebSocket, message: string | Uint8Array): void
  close(ws: BunServerWebSocket): void
}
interface BunUpgradeServer {
  upgrade(req: Request, opts?: { data: unknown }): boolean
}
interface BunServeWsConfig {
  port: number
  hostname?: string
  fetch(req: Request, server: BunUpgradeServer): Response | undefined
  websocket: BunWebSocketHandlers
}
interface BunServerHandle {
  readonly port: number
  stop(force?: boolean): void
}
declare const Bun: { serve(config: BunServeWsConfig): BunServerHandle }

export interface ServeWsOptions extends AttachOptions {
  /** Port to listen on. 0 = OS-assigned ephemeral port. */
  readonly port?: number
  /** Hostname to bind. Defaults to '127.0.0.1'. */
  readonly hostname?: string
}

export interface WsServer {
  readonly port: number
  stop(): void
}

/**
 * Start a Bun-native WebSocket server over a node tree. Each upgraded
 * connection becomes a {@link Channel}, attached via the shared
 * `attachChannel`; the correlation protocol + streaming + cancellation are
 * rpc-dispatch's, so this file only bridges Bun's ServerWebSocket callback API
 * (open / message / close) onto the `Channel` interface.
 *
 * NODE NOTE: Bun has a built-in WS server; Node does not. Node users wrap each
 * connection from an external `ws` library with {@link wsServerChannel} +
 * `attachChannel` instead (we do NOT depend on `ws`).
 */
export const serveWsBun = (tree: AnyNode, options: ServeWsOptions = {}): WsServer => {
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? '127.0.0.1',
    fetch(req, srv) {
      if (srv.upgrade(req, { data: {} })) return undefined
      return new Response('expected websocket', { status: 426 })
    },
    websocket: {
      open(ws) {
        // Build a Channel<string> whose onMessage stores the callback on ws.data
        // so the `message` handler can route inbound text frames to it; detach on
        // close. Encoding is the codec's job — this channel moves text only.
        const channel: Channel<string> = {
          send: (frame) => ws.send(frame),
          onMessage: (cb) => {
            ws.data.onMessage = cb
          },
          close: () => ws.close(),
        }
        ws.data.detach = attach(tree, channel, jsonCodec, correlation, options)
      },
      message(ws, message) {
        const cb = ws.data.onMessage
        if (cb) cb(toText(message))
      },
      close(ws) {
        ws.data.detach?.()
      },
    },
  })

  return {
    get port() {
      return server.port
    },
    stop() {
      server.stop(true)
    },
  }
}
