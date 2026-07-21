// packages/graphql-api-projector/src/ws.test.ts — createWsHandler (graphql-ws protocol) tests
//
// Drives the protocol handler directly with mock send/close callbacks — no
// real socket involved (that's what `handleBunWebSocket` binds on top, and
// it's a thin enough wrapper that exercising the protocol logic itself here
// is the higher-value test).

import { describe, expect, it } from "bun:test"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { t, types } from "@rhi-zone/fractal-type-ir"
import type { FieldTypeMap } from "./project.ts"
import { createGraphQLServer } from "./server.ts"
import { createWsHandler } from "./ws.ts"
import type { GraphQLWsHandlerOptions } from "./ws.ts"

// ============================================================================
// Test fixtures
// ============================================================================

const watchTypes: FieldTypeMap = {
  watch: { input: t(types.object({ count: t(types.integer, { optional: true }) })) },
}

function makeServer() {
  const tree = api_({
    watch: op(
      async function* (input: { count?: number }) {
        const n = input.count ?? 2
        for (let i = 0; i < n; i++) yield `event-${i}`
      },
      { tags: { streaming: true } },
    ),
  })
  return createGraphQLServer(tree, { types: watchTypes })
}

/** A mock socket recording every sent frame + close call, decoding each `send` back into a parsed message for assertions. */
function mockConn() {
  const sent: unknown[] = []
  const closed: { code: number; reason: string }[] = []
  return {
    send: (data: string) => sent.push(JSON.parse(data)),
    close: (code: number, reason: string) => closed.push({ code, reason }),
    sent,
    closed,
  }
}

/** Wait one microtask/macrotask tick — the protocol handler's async work (subscribe setup, iteration) needs to flush before assertions. */
function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function init(conn: ReturnType<typeof mockConn>, factory: ReturnType<typeof createWsHandler>) {
  const handler = factory(conn)
  handler.onMessage(JSON.stringify({ type: "connection_init" }))
  await tick()
  return handler
}

// ============================================================================
// 1. connection_init / connection_ack handshake
// ============================================================================

describe("createWsHandler — handshake", () => {
  it("connection_init produces a connection_ack", async () => {
    const factory = createWsHandler(makeServer())
    const conn = mockConn()
    await init(conn, factory)
    expect(conn.sent).toEqual([{ type: "connection_ack" }])
  })

  it("a second connection_init closes with 4429", async () => {
    const factory = createWsHandler(makeServer())
    const conn = mockConn()
    const handler = await init(conn, factory)
    handler.onMessage(JSON.stringify({ type: "connection_init" }))
    await tick()
    expect(conn.closed).toEqual([{ code: 4429, reason: "Too many initialisation requests" }])
  })

  it("subscribe before connection_init closes with 4401", async () => {
    const factory = createWsHandler(makeServer())
    const conn = mockConn()
    const handler = factory(conn)
    handler.onMessage(JSON.stringify({ type: "subscribe", id: "1", payload: { query: "subscription { watch }" } }))
    await tick()
    expect(conn.closed).toEqual([{ code: 4401, reason: "Unauthorized" }])
  })

  it("a malformed frame closes with 4400", async () => {
    const factory = createWsHandler(makeServer())
    const conn = mockConn()
    const handler = factory(conn)
    handler.onMessage("not json")
    expect(conn.closed).toEqual([{ code: 4400, reason: "Invalid message" }])
  })

  it("onConnect returning false closes with 4403 and skips the ack", async () => {
    const opts: GraphQLWsHandlerOptions = { onConnect: () => false }
    const factory = createWsHandler(makeServer(), opts)
    const conn = mockConn()
    const handler = factory(conn)
    handler.onMessage(JSON.stringify({ type: "connection_init" }))
    await tick()
    expect(conn.closed).toEqual([{ code: 4403, reason: "Forbidden" }])
    expect(conn.sent).toEqual([])
  })

  it("onConnect receives the connection_init payload and can accept", async () => {
    let received: unknown
    const opts: GraphQLWsHandlerOptions = {
      onConnect: (payload) => {
        received = payload
        return true
      },
    }
    const factory = createWsHandler(makeServer(), opts)
    const conn = mockConn()
    const handler = factory(conn)
    handler.onMessage(JSON.stringify({ type: "connection_init", payload: { token: "abc" } }))
    await tick()
    expect(received).toEqual({ token: "abc" })
    expect(conn.sent).toEqual([{ type: "connection_ack" }])
  })

  it("connectionInitWaitTimeout closes the socket with 4408 if no init arrives in time", async () => {
    const factory = createWsHandler(makeServer(), { connectionInitWaitTimeout: 10 })
    const conn = mockConn()
    factory(conn)
    await tick(30)
    expect(conn.closed).toEqual([{ code: 4408, reason: "Connection initialisation timeout" }])
  })

  it("connectionInitWaitTimeout does not fire once acknowledged in time", async () => {
    const factory = createWsHandler(makeServer(), { connectionInitWaitTimeout: 20 })
    const conn = mockConn()
    const handler = factory(conn)
    handler.onMessage(JSON.stringify({ type: "connection_init" }))
    await tick(40)
    expect(conn.closed).toEqual([])
  })
})

// ============================================================================
// 2. subscribe → next → complete lifecycle
// ============================================================================

describe("createWsHandler — subscribe lifecycle", () => {
  it("subscribe streams next messages then a server complete", async () => {
    const factory = createWsHandler(makeServer())
    const conn = mockConn()
    const handler = await init(conn, factory)

    handler.onMessage(
      JSON.stringify({ type: "subscribe", id: "sub-1", payload: { query: "subscription { watch }" } }),
    )
    await tick()
    await tick()

    const messages = conn.sent as { type: string; id?: string; payload?: unknown }[]
    const nexts = messages.filter((m) => m.type === "next")
    expect(nexts.length).toBe(2)
    expect(nexts.map((m) => (m.payload as { data: { watch: string } }).data.watch)).toEqual(["event-0", "event-1"])
    expect(messages[messages.length - 1]).toEqual({ type: "complete", id: "sub-1" })
  })

  it("passes variables through to the subscription query", async () => {
    const factory = createWsHandler(makeServer())
    const conn = mockConn()
    const handler = await init(conn, factory)

    handler.onMessage(
      JSON.stringify({
        type: "subscribe",
        id: "sub-1",
        payload: { query: "subscription($count: Int) { watch(count: $count) }", variables: { count: 1 } },
      }),
    )
    await tick()
    await tick()

    const messages = conn.sent as { type: string; payload?: unknown }[]
    const nexts = messages.filter((m) => m.type === "next")
    expect(nexts.length).toBe(1)
  })
})

// ============================================================================
// 3. client-initiated complete (cancellation)
// ============================================================================

describe("createWsHandler — client complete", () => {
  it("client complete stops further next messages for that id", async () => {
    const tree = api_({
      watch: op(
        async function* () {
          yield "a"
          await new Promise((resolve) => setTimeout(resolve, 20))
          yield "b"
        },
        { tags: { streaming: true } },
      ),
    })
    const server = createGraphQLServer(tree)
    const factory = createWsHandler(server)
    const conn = mockConn()
    const handler = await init(conn, factory)

    handler.onMessage(JSON.stringify({ type: "subscribe", id: "sub-1", payload: { query: "subscription { watch }" } }))
    await tick()
    // First value delivered; cancel before the second yield's timer fires.
    handler.onMessage(JSON.stringify({ type: "complete", id: "sub-1" }))
    await tick(40)

    const messages = conn.sent as { type: string; id?: string }[]
    const nexts = messages.filter((m) => m.type === "next")
    expect(nexts.length).toBe(1)
    // No server-sent complete for a client-initiated cancellation.
    expect(messages.some((m) => m.type === "complete")).toBe(false)
  })

  it("re-subscribing with the same id after completing succeeds", async () => {
    const factory = createWsHandler(makeServer())
    const conn = mockConn()
    const handler = await init(conn, factory)

    handler.onMessage(JSON.stringify({ type: "subscribe", id: "sub-1", payload: { query: "subscription { watch }" } }))
    await tick()
    await tick()
    handler.onMessage(JSON.stringify({ type: "subscribe", id: "sub-1", payload: { query: "subscription { watch }" } }))
    await tick()
    await tick()

    expect(conn.closed).toEqual([])
  })

  it("subscribing twice with the same live id closes with 4409", async () => {
    const tree = api_({
      watch: op(
        async function* () {
          await new Promise((resolve) => setTimeout(resolve, 50))
          yield "a"
        },
        { tags: { streaming: true } },
      ),
    })
    const server = createGraphQLServer(tree)
    const factory = createWsHandler(server)
    const conn = mockConn()
    const handler = await init(conn, factory)

    handler.onMessage(JSON.stringify({ type: "subscribe", id: "sub-1", payload: { query: "subscription { watch }" } }))
    handler.onMessage(JSON.stringify({ type: "subscribe", id: "sub-1", payload: { query: "subscription { watch }" } }))
    await tick()

    expect(conn.closed).toEqual([{ code: 4409, reason: "Subscriber already exists: sub-1" }])
  })
})

// ============================================================================
// 4. Error handling
// ============================================================================

describe("createWsHandler — errors", () => {
  it("subscribing to a non-existent field sends an error message, not a close", async () => {
    const factory = createWsHandler(makeServer())
    const conn = mockConn()
    const handler = await init(conn, factory)

    handler.onMessage(
      JSON.stringify({ type: "subscribe", id: "sub-1", payload: { query: "subscription { doesNotExist }" } }),
    )
    await tick()

    expect(conn.closed).toEqual([])
    const messages = conn.sent as { type: string; id?: string; payload?: unknown }[]
    const errorMsg = messages.find((m) => m.type === "error")
    expect(errorMsg).toBeDefined()
    expect(errorMsg?.id).toBe("sub-1")
    expect(Array.isArray(errorMsg?.payload)).toBe(true)
  })

  it("an invalid query document sends an error message", async () => {
    const factory = createWsHandler(makeServer())
    const conn = mockConn()
    const handler = await init(conn, factory)

    handler.onMessage(JSON.stringify({ type: "subscribe", id: "sub-1", payload: { query: "subscription { " } }))
    await tick()

    const messages = conn.sent as { type: string; id?: string }[]
    expect(messages.some((m) => m.type === "error" && m.id === "sub-1")).toBe(true)
  })
})

// ============================================================================
// 5. Connection close cleans up subscriptions
// ============================================================================

describe("createWsHandler — onClose", () => {
  it("closing the connection cancels active subscriptions (no further next messages)", async () => {
    const tree = api_({
      watch: op(
        async function* () {
          yield "a"
          await new Promise((resolve) => setTimeout(resolve, 20))
          yield "b"
        },
        { tags: { streaming: true } },
      ),
    })
    const server = createGraphQLServer(tree)
    const factory = createWsHandler(server)
    const conn = mockConn()
    const handler = await init(conn, factory)

    handler.onMessage(JSON.stringify({ type: "subscribe", id: "sub-1", payload: { query: "subscription { watch }" } }))
    await tick()
    handler.onClose()
    await tick(40)

    const nexts = (conn.sent as { type: string }[]).filter((m) => m.type === "next")
    expect(nexts.length).toBe(1)
  })
})

// ============================================================================
// 6. Multiple concurrent subscriptions on one connection
// ============================================================================

describe("createWsHandler — concurrent subscriptions", () => {
  it("two subscriptions with different ids stream independently", async () => {
    const factory = createWsHandler(makeServer())
    const conn = mockConn()
    const handler = await init(conn, factory)

    handler.onMessage(
      JSON.stringify({ type: "subscribe", id: "a", payload: { query: "subscription { watch(count: 1) }" } }),
    )
    handler.onMessage(
      JSON.stringify({ type: "subscribe", id: "b", payload: { query: "subscription { watch(count: 3) }" } }),
    )
    await tick()
    await tick()

    const messages = conn.sent as { type: string; id?: string }[]
    const aNexts = messages.filter((m) => m.type === "next" && m.id === "a")
    const bNexts = messages.filter((m) => m.type === "next" && m.id === "b")
    expect(aNexts.length).toBe(1)
    expect(bNexts.length).toBe(3)
    expect(messages.some((m) => m.type === "complete" && m.id === "a")).toBe(true)
    expect(messages.some((m) => m.type === "complete" && m.id === "b")).toBe(true)
  })
})

// ============================================================================
// 7. ping/pong
// ============================================================================

describe("createWsHandler — ping/pong", () => {
  it("ping produces a pong", async () => {
    const factory = createWsHandler(makeServer())
    const conn = mockConn()
    const handler = await init(conn, factory)
    handler.onMessage(JSON.stringify({ type: "ping" }))
    expect(conn.sent).toContainEqual({ type: "pong", payload: undefined })
  })
})
