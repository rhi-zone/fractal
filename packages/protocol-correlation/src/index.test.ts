import { describe, it, expect } from 'vitest'
import { ok, branch, leaf, streamLeaf } from '@rhi-zone/fractal-core'
import type { MessageStream } from '@rhi-zone/fractal-transport'
import { correlation } from './index.ts'

// Wire two in-memory MessageStreams together: what one sends, the other
// receives. Lets us exercise the correlation client + server with no medium.
const pair = (): [MessageStream, MessageStream] => {
  let aCb: ((m: unknown) => void) | null = null
  let bCb: ((m: unknown) => void) | null = null
  const a: MessageStream = {
    send: (m) => queueMicrotask(() => bCb?.(m)),
    onMessage: (cb) => {
      aCb = cb
    },
    close: () => {},
  }
  const b: MessageStream = {
    send: (m) => queueMicrotask(() => aCb?.(m)),
    onMessage: (cb) => {
      bCb = cb
    },
    close: () => {},
  }
  return [a, b]
}

const makeTree = () =>
  branch({
    echo: leaf<string, string>((s) => ok(`echo:${s}`)),
    count: streamLeaf<number, number>(async function* (n) {
      for (let i = 0; i < n; i++) yield ok(i)
    }),
  })

describe('correlation protocol (client + server over an in-memory MessageStream)', () => {
  it('multiplexes a unary call', async () => {
    const [clientStream, serverStream] = pair()
    const detach = correlation.server(makeTree(), serverStream)
    try {
      const transport = correlation.client(clientStream)
      expect(await transport.invoke(['echo'], 'hi')).toEqual({ ok: true, value: 'echo:hi' })
    } finally {
      detach()
    }
  })

  it('multiplexes a streaming call', async () => {
    const [clientStream, serverStream] = pair()
    const detach = correlation.server(makeTree(), serverStream)
    try {
      const transport = correlation.client(clientStream)
      const got: unknown[] = []
      for await (const r of transport.stream!(['count'], 3)) got.push(r)
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
