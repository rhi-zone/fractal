// WebSocket adapter end-to-end ON BUN: the SAME tree shape as the HTTP example
// (a unary leaf + a streamLeaf + an auth-gated leaf), served via `serveWs` from
// the preset and `wsClient` from the preset. Proves: unary call, streamed values
// in order, cancellation (consumer break → server generator stops), and meta (an
// auth token threaded via the per-call meta slot rather than a header).
//
// One test also exercises the bare `compose` one-liner directly to prove both
// paths (preset sugar and raw compose) produce identical results.

import { describe, it, expect } from 'bun:test'
import { ok, branch, leaf, streamLeaf, withAuth, type AnyNode } from '@rhi-zone/fractal-core'
import { clientOver, compose, attach, type CapGrant, type DispatcherOptions } from '@rhi-zone/fractal-transport'
import { jsonCodec } from '@rhi-zone/fractal-codec-json'
import { correlation } from '@rhi-zone/fractal-protocol-correlation'
import { wsServeBun, wsClientChannel, type WsServer } from './index.ts'
import { wsClient, serveWs } from '@rhi-zone/fractal-preset-websocket'

// Bare compose one-liners (kept here so both paths are exercised in tests):
//   server: wsServeBun((ch) => attach(tree, ch, jsonCodec, correlation, opts), opts)
//   client: clientOver(node, compose(wsClientChannel(url), jsonCodec, correlation))

// Shared flags to observe server-side generator behaviour (cancellation).
let generatorFinished = false
let yieldedCount = 0

const makeTree = () =>
  branch({
    ping: leaf<string, string>((name) => ok(`pong:${name}`)),
    count: streamLeaf<number, number>(async function* (n) {
      generatorFinished = false
      yieldedCount = 0
      for (let i = 0; i < n; i++) {
        await new Promise((r) => setTimeout(r, 10))
        yieldedCount++
        yield ok(i)
      }
      generatorFinished = true
    }),
    secure: withAuth(
      leaf<void, string, never, { auth: { user: string | null } }>((_input, ctx) =>
        ctx.caps.auth.user !== null
          ? ok(`hello:${ctx.caps.auth.user}`)
          : ok('hello:anon'),
      ),
    ),
  })

// Auth grant reads the token from per-call meta (the WS envelope carries meta).
const authGrant: CapGrant = (req) => {
  const token = (req.meta as { authorization?: unknown } | undefined)?.authorization
  const m = typeof token === 'string' ? /^Bearer (.+)$/.exec(token) : null
  return { auth: { user: m !== null ? m[1] : null } }
}

const url = (s: WsServer) => `ws://127.0.0.1:${s.port}`

describe('WebSocket adapter e2e (Bun)', () => {
  it('unary call — preset serveWs + wsClient', async () => {
    const server = serveWs(makeTree(), { port: 0, grants: { auth: authGrant } })
    try {
      const api = wsClient(makeTree(), url(server))
      expect(await api.ping('x')).toEqual({ ok: true, value: 'pong:x' })
    } finally {
      server.stop()
    }
  })

  it('bare compose one-liner produces the same result as the preset', async () => {
    // Exercises the raw compose path directly: no preset involved.
    const server = wsServeBun((ch) => attach(makeTree(), ch, jsonCodec, correlation, { grants: { auth: authGrant } }), { port: 0 })
    try {
      const api = clientOver(makeTree(), compose(wsClientChannel(url(server)), jsonCodec, correlation))
      expect(await api.ping('compose-check')).toEqual({ ok: true, value: 'pong:compose-check' })
    } finally {
      server.stop()
    }
  })

  it('streams several framed Results in order', async () => {
    const server = serveWs(makeTree(), { port: 0, grants: { auth: authGrant } })
    try {
      const api = wsClient(makeTree(), url(server))
      const got: unknown[] = []
      for await (const r of api.count(4)) got.push(r)
      expect(got).toEqual([
        { ok: true, value: 0 },
        { ok: true, value: 1 },
        { ok: true, value: 2 },
        { ok: true, value: 3 },
      ])
    } finally {
      server.stop()
    }
  })

  it('cancels the server generator when the consumer breaks mid-stream', async () => {
    const server = serveWs(makeTree(), { port: 0, grants: { auth: authGrant } })
    try {
      const api = wsClient(makeTree(), url(server))
      const got: number[] = []
      for await (const r of api.count(1000)) {
        if (r.ok) got.push(r.value)
        if (got.length === 2) break
      }
      expect(got).toEqual([0, 1])
      await new Promise((r) => setTimeout(r, 60))
      expect(generatorFinished).toBe(false)
      expect(yieldedCount).toBeLessThan(20)
    } finally {
      server.stop()
    }
  })

  it('threads an auth token via per-call meta', async () => {
    const server = serveWs(makeTree(), { port: 0, grants: { auth: authGrant } })
    try {
      const api = wsClient(makeTree(), url(server))
      expect(await api.secure(undefined, { authorization: 'Bearer bob' })).toEqual({
        ok: true,
        value: 'hello:bob',
      })
      // Without the meta token the auth gate denies before reaching the leaf.
      expect(await api.secure(undefined)).toEqual({ ok: false, error: { code: 'unauthorized' } })
    } finally {
      server.stop()
    }
  })

  it('multiplexes concurrent calls over one connection', async () => {
    const server = serveWs(makeTree(), { port: 0, grants: { auth: authGrant } })
    try {
      const api = wsClient(makeTree(), url(server))
      const [a, b, c] = await Promise.all([api.ping('a'), api.ping('b'), api.ping('c')])
      expect([a, b, c]).toEqual([
        { ok: true, value: 'pong:a' },
        { ok: true, value: 'pong:b' },
        { ok: true, value: 'pong:c' },
      ])
    } finally {
      server.stop()
    }
  })
})
