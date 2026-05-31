// stdio (line-framed JSON) channel end-to-end, fully in-process: two
// `PassThrough` streams cross-wired (client.out → server reads; server.out →
// client reads) as the two ends. Proves unary + stream over line-framed JSON.

import { describe, it, expect } from 'vitest'
import { ok, branch, leaf, streamLeaf } from '@rhi-zone/fractal-core'
import { stdioClient, serveStdio, type StdioEnds } from './index.ts'

// Load node:stream's PassThrough behind a variable specifier so the type
// checker never resolves 'node:stream' (the repo does not depend on @types/node;
// see channel-http/src/node.ts for the same pattern). At runtime under Bun this
// works.
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

const makeTree = () =>
  branch({
    ping: leaf<string, string>((name) => ok(`pong:${name}`)),
    count: streamLeaf<number, number>(async function* (n) {
      for (let i = 0; i < n; i++) yield ok(i)
    }),
  })

describe('stdio (line-framed JSON) channel e2e', () => {
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
