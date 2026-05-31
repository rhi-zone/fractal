// worker_threads (MessagePort) channel end-to-end, fully in-process: a real
// `MessageChannel` whose two `MessagePort`s live in the same process; one end is
// the server, the other the client. Proves unary + stream + cancel over a
// MessagePort.

import { describe, it, expect } from 'vitest'
import { ok, branch, leaf, streamLeaf } from '@rhi-zone/fractal-core'
import { portClient, servePort, type MessagePortLike } from './index.ts'

let yieldedCount = 0
let generatorFinished = false

const makeTree = () =>
  branch({
    ping: leaf<string, string>((name) => ok(`pong:${name}`)),
    count: streamLeaf<number, number>(async function* (n) {
      generatorFinished = false
      yieldedCount = 0
      for (let i = 0; i < n; i++) {
        await new Promise((r) => setTimeout(r, 5))
        yieldedCount++
        yield ok(i)
      }
      generatorFinished = true
    }),
  })

// The web `MessageChannel` global exposes port1/port2; both are MessagePortLike.
declare const MessageChannel: {
  new (): { port1: MessagePortLike; port2: MessagePortLike }
}

describe('worker_threads (MessagePort) channel e2e', () => {
  it('unary + stream over an in-process MessagePort', async () => {
    const { port1, port2 } = new MessageChannel()
    const detach = servePort(makeTree(), port1)
    try {
      const api = portClient(makeTree(), port2)
      expect(await api.ping('m')).toEqual({ ok: true, value: 'pong:m' })

      const got: unknown[] = []
      for await (const r of api.count(3)) got.push(r)
      expect(got).toEqual([
        { ok: true, value: 0 },
        { ok: true, value: 1 },
        { ok: true, value: 2 },
      ])
    } finally {
      detach()
    }
  })

  it('cancels the server generator on early break', async () => {
    const { port1, port2 } = new MessageChannel()
    const detach = servePort(makeTree(), port1)
    try {
      const api = portClient(makeTree(), port2)
      const got: number[] = []
      for await (const r of api.count(1000)) {
        if (r.ok) got.push(r.value)
        if (got.length === 2) break
      }
      expect(got).toEqual([0, 1])
      await new Promise((r) => setTimeout(r, 50))
      expect(generatorFinished).toBe(false)
      expect(yieldedCount).toBeLessThan(40)
    } finally {
      detach()
    }
  })
})
