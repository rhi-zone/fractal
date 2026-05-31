// HTTP streaming end-to-end: a streamLeaf served via serveBun, consumed via the
// unified httpClient as an AsyncIterable, proving (1) framed values arrive in
// order, (2) per-call meta threads as a header the server reads, and (3) client
// disconnect mid-stream aborts the server generator (cancellation).

import { describe, it, expect } from 'bun:test'
import { ok, branch, leaf, streamLeaf, withAuth } from '@rhi-zone/fractal-core'
import { clientOver, composeRequestResponse } from '@rhi-zone/fractal-transport'
import { jsonCodec } from '@rhi-zone/fractal-codec-json'
import type { AnyNode } from '@rhi-zone/fractal-core'
import { serveBun, type BunServer } from './bun.ts'
import { httpExchange } from './client.ts'
import type { HttpCapGrant as CapGrant } from './index.ts'

// SELF-COMPOSE: NO preset. `httpExchange` is the pure HTTP CHANNEL (request/
// response medium); the codec + the request-response protocol form are wired
// here via the kernel's `composeRequestResponse`.
const httpClient = <N extends AnyNode>(node: N, baseUrl: string) =>
  clientOver(node, composeRequestResponse(httpExchange(baseUrl), jsonCodec))

// A counter stream that records, via the shared flag below, whether its
// generator ran to completion or was cut short by client disconnect.
let generatorFinished = false
let yieldedCount = 0

const makeTree = () =>
  branch({
    // Streams `n` values, one per ~10ms so a mid-stream abort is observable.
    count: streamLeaf<number, number>(async function* (n) {
      generatorFinished = false
      yieldedCount = 0
      try {
        for (let i = 0; i < n; i++) {
          await new Promise((r) => setTimeout(r, 10))
          yieldedCount++
          yield ok(i)
        }
        generatorFinished = true
      } finally {
        // Runs on normal completion AND on early return (client disconnect →
        // ReadableStream cancel → iterator.return → generator finally).
      }
    }),
    // An auth-gated stream proving meta threads to the server as a header.
    secure: withAuth(
      streamLeaf<number, string, never, { auth: { user: string | null } }>(async function* (n, ctx) {
        for (let i = 0; i < n; i++) yield ok(`${ctx.caps.auth.user}:${i}`)
      }),
    ),
  })

const authGrant: CapGrant = (req) => {
  const header = req.raw.headers?.get('authorization') ?? ''
  const m = /^Bearer (.+)$/.exec(header)
  return { auth: { user: m !== null ? m[1] : null } }
}

describe('HTTP streaming e2e', () => {
  it('streams several framed Results in order', async () => {
    const server: BunServer = serveBun(makeTree(), { port: 0, grants: { auth: authGrant } })
    try {
      const api = httpClient(makeTree(), `http://127.0.0.1:${server.port}`)
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

  it('threads per-call meta as a header the server reads (auth token over a stream)', async () => {
    const server: BunServer = serveBun(makeTree(), { port: 0, grants: { auth: authGrant } })
    try {
      const api = httpClient(makeTree(), `http://127.0.0.1:${server.port}`)
      const got: unknown[] = []
      for await (const r of api.secure(2, { authorization: 'Bearer bob' })) got.push(r)
      expect(got).toEqual([{ ok: true, value: 'bob:0' }, { ok: true, value: 'bob:1' }])

      // Without the meta token the auth gate denies; the stream carries one error.
      const denied: unknown[] = []
      for await (const r of api.secure(2)) denied.push(r)
      expect(denied).toEqual([{ ok: false, error: { code: 'unauthorized' } }])
    } finally {
      server.stop()
    }
  })

  it('aborts the server generator when the client disconnects mid-stream', async () => {
    const tree = makeTree()
    const server: BunServer = serveBun(tree, { port: 0, grants: { auth: authGrant } })
    try {
      const api = httpClient(tree, `http://127.0.0.1:${server.port}`)
      const got: number[] = []
      for await (const r of api.count(1000)) {
        if (r.ok) got.push(r.value)
        if (got.length === 2) break // disconnect mid-stream
      }
      expect(got).toEqual([0, 1])
      // Give the server a moment to observe the disconnect and unwind.
      await new Promise((r) => setTimeout(r, 50))
      // The generator must NOT have run to completion (it was cut short).
      expect(generatorFinished).toBe(false)
      // And it must have stopped pulling: far fewer than 1000 items were yielded.
      expect(yieldedCount).toBeLessThan(20)
    } finally {
      server.stop()
    }
  })

  it('a non-streaming transport-shaped unary leaf still works over HTTP', async () => {
    const tree = branch({ ping: leaf<unknown, string>(() => ok('pong')) })
    const server: BunServer = serveBun(tree, { port: 0 })
    try {
      const api = httpClient(tree, `http://127.0.0.1:${server.port}`)
      expect(await api.ping(undefined)).toEqual({ ok: true, value: 'pong' })
    } finally {
      server.stop()
    }
  })
})
