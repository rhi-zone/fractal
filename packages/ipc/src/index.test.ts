// IPC adapters end-to-end, both fully in-process (no child spawn, no ports left
// open):
//
//   worker_threads → a real `MessageChannel` whose two `MessagePort`s live in
//                    the same process; one end is the server, the other the
//                    client. Proves unary + stream + cancel over a MessagePort.
//   stdio          → two `PassThrough` streams cross-wired (client.out → server
//                    reads; server.out → client reads) as the two ends. Proves
//                    unary + stream over line-framed JSON.

import { describe, it, expect } from 'vitest'
import { ok, branch, leaf, streamLeaf } from '@rhi-zone/fractal-core'
import {
  portClient,
  servePort,
  stdioClient,
  serveStdio,
  type MessagePortLike,
  type StdioEnds,
} from './index.ts'

// Load node:stream's PassThrough behind a variable specifier so the type
// checker never resolves 'node:stream' (the repo does not depend on @types/node;
// see http/src/node.ts for the same pattern). At runtime under Bun this works.
const loadPassThrough = async (): Promise<new () => PassThroughLike> => {
  const spec = 'node:stream'
  const mod = (await import(/* @vite-ignore */ spec)) as { PassThrough: new () => PassThroughLike }
  return mod.PassThrough
}
interface PassThroughLike {
  write(chunk: string): unknown
  end?(): void
  on(event: 'data', cb: (chunk: unknown) => void): void
  on(event: 'end', cb: () => void): void
}

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

describe('IPC worker_threads (MessagePort) e2e', () => {
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

describe('IPC stdio (line-framed JSON) e2e', () => {
  // Cross-wire two PassThrough pipes: what the client writes, the server reads,
  // and vice-versa.
  const wire = async (): Promise<{ client: StdioEnds; server: StdioEnds }> => {
    const PassThrough = await loadPassThrough()
    const c2s = new PassThrough()
    const s2c = new PassThrough()
    return {
      client: { in: s2c as unknown as StdioEnds['in'], out: c2s as unknown as StdioEnds['out'] },
      server: { in: c2s as unknown as StdioEnds['in'], out: s2c as unknown as StdioEnds['out'] },
    }
  }

  it('unary + stream over line-framed JSON', async () => {
    const { client, server } = await wire()
    const detach = serveStdio(makeTree(), server)
    try {
      const api = stdioClient(makeTree(), client)
      expect(await api.ping('s')).toEqual({ ok: true, value: 'pong:s' })

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
})
