// packages/graphql-api-projector/src/ws.ts — @rhi-zone/fractal-graphql-api-projector
//
// WebSocket subscription transport: a hand-rolled implementation of the
// graphql-ws protocol (https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md)
// over `GraphQLServer.subscribe()` (server.ts). Mirrors presets.ts's
// `createHttpGraphQLServer` — this is the "I don't want to think about the
// wire format" entry point for subscriptions, the one transport
// `createHttpGraphQLServer` explicitly declines to serve (see its module
// doc: GraphQL-over-HTTP has no standard subscription transport).
//
// Hand-rolled rather than depending on the `graphql-ws` package (settled
// design decision) — the protocol is six message types and materially
// simpler than the HTTP routing this codebase already hand-rolls in
// http-api-projector. No new dependency, same "protocol is not that hard"
// stance this codebase takes elsewhere.
//
// ── Layering ─────────────────────────────────────────────────────────────
// `createWsHandler` is WebSocket-API-agnostic: it takes a `send`/`close`
// pair and returns `{ onMessage, onClose }`. This is the same split
// http-api-projector's adapter.ts draws between the fetch-handler core and
// its Bun/Node runtime bindings — the protocol logic here never touches a
// concrete `WebSocket` type, so it works against Bun's `ServerWebSocket`,
// Node's `ws` package, or Deno's WebSocket alike. `handleBunWebSocket` is
// the one concrete binding this module ships (mirrors adapter.ts's
// `serveBun`); a Node binding is a few lines against the `ws` package or
// Node's built-in `WebSocket` and is left to the caller (documented below)
// rather than adding `ws` as a dependency for a handful of lines.
//
// ── Per-connection state ────────────────────────────────────────────────
// One graphql-ws connection is not one request — it lives for the life of
// the socket and can carry many concurrent subscriptions (each identified
// by the client-chosen `id` in its `subscribe` message). `createWsHandler`
// therefore returns a FACTORY — `(conn) => connectionHandler` — invoked
// once per socket; each invocation closes over its own `acknowledged` flag
// and `subscriptions: Map<id, AsyncIterator>` so connections never share
// state. This is why the shape isn't a single stateless handler function:
// the protocol is inherently connection-scoped.

import type { ExecutionResult, GraphQLFormattedError } from "graphql"
import type { GraphQLServer } from "./server.ts"

// ============================================================================
// Wire message shapes (graphql-ws PROTOCOL.md)
// ============================================================================

type ConnectionInitMessage = { readonly type: "connection_init"; readonly payload?: Record<string, unknown> }
type SubscribeMessage = {
  readonly type: "subscribe"
  readonly id: string
  readonly payload: {
    readonly query: string
    readonly variables?: Record<string, unknown>
    readonly operationName?: string
  }
}
type CompleteMessage = { readonly type: "complete"; readonly id: string }
type PingMessage = { readonly type: "ping"; readonly payload?: unknown }
type PongMessage = { readonly type: "pong"; readonly payload?: unknown }

type ClientMessage = ConnectionInitMessage | SubscribeMessage | CompleteMessage | PingMessage | PongMessage

type ConnectionAckMessage = { readonly type: "connection_ack"; readonly payload?: Record<string, unknown> }
type NextMessage = { readonly type: "next"; readonly id: string; readonly payload: ExecutionResult }
type ErrorMessage = { readonly type: "error"; readonly id: string; readonly payload: readonly GraphQLFormattedError[] }
type ServerCompleteMessage = { readonly type: "complete"; readonly id: string }

// ============================================================================
// Close codes (graphql-ws PROTOCOL.md's "Custom WebSocket Close Codes")
// ============================================================================

const CLOSE_INVALID_MESSAGE = 4400
const CLOSE_UNAUTHORIZED = 4401
const CLOSE_FORBIDDEN = 4403
const CLOSE_CONNECTION_INIT_TIMEOUT = 4408
const CLOSE_SUBSCRIBER_ALREADY_EXISTS = 4409
const CLOSE_TOO_MANY_INIT_REQUESTS = 4429

const DEFAULT_CONNECTION_INIT_WAIT_TIMEOUT_MS = 3000

// ============================================================================
// Public option/connection shapes
// ============================================================================

/** The two operations `createWsHandler`'s protocol logic needs from a concrete WebSocket — everything else is runtime-specific and lives in an adapter like `handleBunWebSocket`. */
export type GraphQLWsSender = {
  send(data: string): void
  close(code: number, reason: string): void
}

/** What one connection's `onMessage`/`onClose` pair looks like — the shape `handleBunWebSocket` (and any other adapter) drives from the underlying socket's own events. */
export type GraphQLWsConnectionHandler = {
  /** Feed one raw text frame received on the socket. */
  onMessage(data: string): void
  /** The socket closed (any reason) — cancels every active subscription on this connection. */
  onClose(): void
}

export type GraphQLWsHandlerOptions = {
  /**
   * Milliseconds to wait for a `connection_init` message before closing the
   * socket with `4408 Connection initialisation timeout`. Defaults to 3000,
   * matching the reference `graphql-ws` server's own default. Pass `0` (or
   * a falsy value is NOT the same as disabling — pass `Infinity`) to
   * disable the timeout entirely.
   */
  readonly connectionInitWaitTimeout?: number
  /**
   * Called once per connection when a `connection_init` message arrives,
   * before `connection_ack` is sent — the auth hook. Receives the message's
   * optional `payload`. Returning/resolving `false` closes the socket with
   * `4403 Forbidden` instead of acknowledging. Returning/resolving `true`,
   * `undefined`, or omitting `onConnect` entirely acknowledges
   * unconditionally (no auth check).
   */
  readonly onConnect?: (payload: Record<string, unknown> | undefined) => boolean | Promise<boolean>
  /**
   * `contextValue` passed to every `server.subscribe(...)` call on this
   * connection, merged with `{ connectionParams }` (the `connection_init`
   * payload). Defaults to `{}`.
   */
  readonly context?: Record<string, unknown>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Parse + structurally validate one raw frame into a `ClientMessage`, or `undefined` if it's malformed (caller closes with `4400`). */
function parseClientMessage(data: string): ClientMessage | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return undefined

  switch (parsed.type) {
    case "connection_init": {
      if (parsed.payload !== undefined && !isRecord(parsed.payload)) return undefined
      const payload = parsed.payload as Record<string, unknown> | undefined
      return payload === undefined ? { type: "connection_init" } : { type: "connection_init", payload }
    }
    case "subscribe": {
      if (typeof parsed.id !== "string" || !isRecord(parsed.payload)) return undefined
      const payload = parsed.payload
      if (typeof payload.query !== "string") return undefined
      if (payload.variables !== undefined && !isRecord(payload.variables)) return undefined
      if (payload.operationName !== undefined && typeof payload.operationName !== "string") return undefined
      const variables = payload.variables as Record<string, unknown> | undefined
      const operationName = payload.operationName as string | undefined
      return {
        type: "subscribe",
        id: parsed.id,
        payload: {
          query: payload.query,
          ...(variables !== undefined ? { variables } : {}),
          ...(operationName !== undefined ? { operationName } : {}),
        },
      }
    }
    case "complete":
      if (typeof parsed.id !== "string") return undefined
      return { type: "complete", id: parsed.id }
    case "ping":
      return { type: "ping", payload: parsed.payload }
    case "pong":
      return { type: "pong", payload: parsed.payload }
    default:
      return undefined
  }
}

/**
 * Build a graphql-ws protocol handler over `server` — a factory,
 * `(conn) => { onMessage, onClose }`, invoked once per WebSocket connection
 * (see module doc on why per-connection state needs a factory rather than a
 * single shared handler). `conn` is the minimal `send`/`close` pair a
 * concrete WebSocket adapter (e.g. `handleBunWebSocket`) drives from the
 * real socket.
 *
 * ```ts
 * const server = createGraphQLServer(tree, opts)
 * const wsFactory = createWsHandler(server, { connectionInitWaitTimeout: 5000 })
 * const conn = wsFactory({ send: (d) => ws.send(d), close: (c, r) => ws.close(c, r) })
 * // conn.onMessage(rawFrameText) on each incoming frame; conn.onClose() when the socket closes.
 * ```
 */
export function createWsHandler(
  server: GraphQLServer,
  opts: GraphQLWsHandlerOptions = {},
): (conn: GraphQLWsSender) => GraphQLWsConnectionHandler {
  const waitTimeout = opts.connectionInitWaitTimeout ?? DEFAULT_CONNECTION_INIT_WAIT_TIMEOUT_MS

  return (conn: GraphQLWsSender): GraphQLWsConnectionHandler => {
    let acknowledged = false
    let connectionParams: Record<string, unknown> | undefined
    const subscriptions = new Map<string, AsyncIterator<ExecutionResult>>()

    const initTimer: ReturnType<typeof setTimeout> | undefined =
      waitTimeout === Infinity
        ? undefined
        : setTimeout(() => {
            if (!acknowledged) conn.close(CLOSE_CONNECTION_INIT_TIMEOUT, "Connection initialisation timeout")
          }, waitTimeout)

    const send = (message: ConnectionAckMessage | NextMessage | ErrorMessage | ServerCompleteMessage | PingMessage | PongMessage): void =>
      conn.send(JSON.stringify(message))

    /** Cancel + drop one subscription's underlying iterator (client `complete`, server-side completion, or connection close). */
    const stopSubscription = (id: string): void => {
      const iterator = subscriptions.get(id)
      if (iterator === undefined) return
      subscriptions.delete(id)
      void iterator.return?.(undefined)
    }

    const runSubscription = async (msg: SubscribeMessage): Promise<void> => {
      const contextValue = { ...opts.context, connectionParams }
      const iterableOrResult = await server.subscribe(msg.payload.query, msg.payload.variables, contextValue, msg.payload.operationName)

      if (Symbol.asyncIterator in (iterableOrResult as object)) {
        const iterable = iterableOrResult as AsyncIterable<ExecutionResult>
        const iterator = iterable[Symbol.asyncIterator]()
        // A `subscribe` for this id may already have raced a client
        // `complete` (or the connection may already have closed) by the
        // time `server.subscribe`'s own setup work resolves — don't
        // register or emit for a subscription nobody is listening for
        // anymore; just cancel the freshly-created iterator immediately.
        if (!subscriptions.has(msg.id)) {
          void iterator.return?.(undefined)
          return
        }
        subscriptions.set(msg.id, iterator)

        try {
          for (;;) {
            const step = await iterator.next()
            if (!subscriptions.has(msg.id)) return // cancelled mid-stream
            if (step.done) break
            send({ type: "next", id: msg.id, payload: step.value })
          }
        } catch (error) {
          subscriptions.delete(msg.id)
          const formatted: GraphQLFormattedError = { message: error instanceof Error ? error.message : String(error) }
          send({ type: "error", id: msg.id, payload: [formatted] })
          return
        }
        subscriptions.delete(msg.id)
        send({ type: "complete", id: msg.id })
        return
      }

      // Setup failure (parse/validate/coerce) — a plain ExecutionResult
      // carrying `errors`, never registered as a live subscription.
      const result = iterableOrResult as ExecutionResult
      const payload: readonly GraphQLFormattedError[] =
        result.errors !== undefined ? result.errors.map((e) => e.toJSON()) : [{ message: "Subscription failed" }]
      send({ type: "error", id: msg.id, payload })
    }

    const onMessage = (data: string): void => {
      const msg = parseClientMessage(data)
      if (msg === undefined) {
        conn.close(CLOSE_INVALID_MESSAGE, "Invalid message")
        return
      }

      switch (msg.type) {
        case "connection_init": {
          if (acknowledged) {
            conn.close(CLOSE_TOO_MANY_INIT_REQUESTS, "Too many initialisation requests")
            return
          }
          void (async () => {
            const ok = opts.onConnect === undefined ? true : await opts.onConnect(msg.payload)
            if (!ok) {
              conn.close(CLOSE_FORBIDDEN, "Forbidden")
              return
            }
            acknowledged = true
            connectionParams = msg.payload
            if (initTimer !== undefined) clearTimeout(initTimer)
            send({ type: "connection_ack" })
          })()
          return
        }

        case "subscribe": {
          if (!acknowledged) {
            conn.close(CLOSE_UNAUTHORIZED, "Unauthorized")
            return
          }
          if (subscriptions.has(msg.id)) {
            conn.close(CLOSE_SUBSCRIBER_ALREADY_EXISTS, `Subscriber already exists: ${msg.id}`)
            return
          }
          // Reserve the id synchronously (placeholder iterator swapped in by
          // runSubscription once server.subscribe resolves) so a second
          // `subscribe` with the same id — arriving before the first one's
          // async setup finishes — is rejected per the protocol.
          subscriptions.set(msg.id, { next: () => Promise.resolve({ done: true, value: undefined }) })
          void runSubscription(msg)
          return
        }

        case "complete":
          stopSubscription(msg.id)
          return

        case "ping":
          send({ type: "pong", payload: msg.payload })
          return

        case "pong":
          return
      }
    }

    const onClose = (): void => {
      if (initTimer !== undefined) clearTimeout(initTimer)
      for (const id of [...subscriptions.keys()]) stopSubscription(id)
    }

    return { onMessage, onClose }
  }
}

// ============================================================================
// Bun adapter (mirrors http-api-projector/src/adapter.ts's `serveBun`)
// ============================================================================

/** The subset of Bun's `ServerWebSocket` this adapter drives. */
export type BunServerWebSocketLike = {
  send(data: string): void
  close(code?: number, reason?: string): void
}

/** Bun's `{ open, message, close }` websocket handler shape (`Bun.serve({ websocket })`). */
export type BunWebSocketHandlers<Ws extends BunServerWebSocketLike = BunServerWebSocketLike> = {
  open(ws: Ws): void
  message(ws: Ws, message: string | Uint8Array): void
  close(ws: Ws, code: number, reason: string): void
}

/**
 * Build a Bun `websocket` handler object (the shape `Bun.serve({ fetch, websocket })`
 * wants — see https://bun.sh/docs/api/websockets) that speaks graphql-ws
 * over `server`:
 *
 * ```ts
 * const server = createGraphQLServer(tree, opts)
 * Bun.serve({
 *   fetch(req, bunServer) {
 *     if (bunServer.upgrade(req)) return
 *     return new Response("Upgrade failed", { status: 400 })
 *   },
 *   websocket: handleBunWebSocket(server),
 * })
 * ```
 *
 * The graphql-ws spec requires the `graphql-transport-ws` WebSocket
 * subprotocol to be negotiated on upgrade — pass
 * `{ headers: { "Sec-WebSocket-Protocol": "graphql-transport-ws" } }` (or
 * the equivalent `protocol` option Bun's `upgrade()` exposes) at the
 * `fetch` call site above; that negotiation happens before this module ever
 * sees the socket, so it isn't this adapter's concern.
 */
export function handleBunWebSocket<Ws extends BunServerWebSocketLike = BunServerWebSocketLike>(
  server: GraphQLServer,
  opts: GraphQLWsHandlerOptions = {},
): BunWebSocketHandlers<Ws> {
  const factory = createWsHandler(server, opts)
  const connections = new WeakMap<BunServerWebSocketLike, GraphQLWsConnectionHandler>()

  return {
    open(ws: Ws): void {
      const handler = factory({
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
      })
      connections.set(ws, handler)
    },
    message(ws: Ws, message: string | Uint8Array): void {
      const handler = connections.get(ws)
      if (handler === undefined) return
      handler.onMessage(typeof message === "string" ? message : new TextDecoder().decode(message))
    },
    close(ws: Ws): void {
      const handler = connections.get(ws)
      handler?.onClose()
      connections.delete(ws)
    },
  }
}

// ── Node ─────────────────────────────────────────────────────────────────
// No `handleNodeWebSocket` ships here — deliberately, to avoid adding the
// `ws` package (or committing to Node's still-experimental built-in
// `WebSocket` server support) as a dependency for a few lines of glue. Wire
// `createWsHandler` up with the `ws` package like this:
//
// ```ts
// import { WebSocketServer } from "ws"
// const wss = new WebSocketServer({ server: httpServer, handleProtocols: () => "graphql-transport-ws" })
// const factory = createWsHandler(server, opts)
// wss.on("connection", (ws) => {
//   const conn = factory({
//     send: (data) => ws.send(data),
//     close: (code, reason) => ws.close(code, reason),
//   })
//   ws.on("message", (data) => conn.onMessage(data.toString()))
//   ws.on("close", () => conn.onClose())
// })
// ```
