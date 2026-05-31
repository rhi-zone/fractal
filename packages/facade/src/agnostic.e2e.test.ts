// Transport-agnosticism: the KEY assertion of the whole adapter family.
//
// ONE node tree + ONE `clientOver`-derived typed client shape produce IDENTICAL
// `Result`s whether the calls travel over HTTP (request/response), WebSocket
// (duplex channel), worker_threads (MessagePort), or stdio (line-framed JSON).
// We run the same unary + stream calls across every transport and assert every
// path returns the same Results as the HTTP reference path.

import { describe, it, expect } from 'vitest'
import {
  ok,
  branch,
  leaf,
  streamLeaf,
  serveBun,
  type BunServer,
  httpClient,
  portClient,
  servePort,
  stdioClient,
  serveStdio,
  serveWsBun,
  wsClient,
  type MessagePortLike,
  type StdioEnds,
} from './index.ts'

// node:stream's PassThrough loaded behind a variable specifier (no @types/node).
const loadPassThrough = async (): Promise<new () => StdioEnds['in'] & StdioEnds['out']> => {
  const spec = 'node:stream'
  const mod = (await import(/* @vite-ignore */ spec)) as { PassThrough: new () => StdioEnds['in'] & StdioEnds['out'] }
  return mod.PassThrough
}

// One tree, reused for every transport. (Each transport gets its own instance,
// but the SHAPE is identical — that is what `clientOver` is typed against.)
const makeTree = () =>
  branch({
    echo: leaf<string, string>((s) => ok(`echo:${s}`)),
    count: streamLeaf<number, number>(async function* (n) {
      for (let i = 0; i < n; i++) yield ok(i)
    }),
  })

declare const MessageChannel: { new (): { port1: MessagePortLike; port2: MessagePortLike } }

// Run the SAME calls against a typed client (whatever transport backs it).
const exercise = async (api: ReturnType<typeof httpClient<ReturnType<typeof makeTree>>>) => {
  const unary = await api.echo('hi')
  const stream: unknown[] = []
  for await (const r of api.count(3)) stream.push(r)
  return { unary, stream }
}

const EXPECTED = {
  unary: { ok: true, value: 'echo:hi' },
  stream: [
    { ok: true, value: 0 },
    { ok: true, value: 1 },
    { ok: true, value: 2 },
  ],
}

describe('transport agnosticism: identical Results over HTTP / WS / IPC', () => {
  it('HTTP (reference)', async () => {
    const server: BunServer = serveBun(makeTree(), { port: 0 })
    try {
      const got = await exercise(httpClient(makeTree(), `http://127.0.0.1:${server.port}`))
      expect(got).toEqual(EXPECTED)
    } finally {
      server.stop()
    }
  })

  it('WebSocket matches the HTTP reference', async () => {
    const server = serveWsBun(makeTree(), { port: 0 })
    try {
      const got = await exercise(wsClient(makeTree(), `ws://127.0.0.1:${server.port}`))
      expect(got).toEqual(EXPECTED)
    } finally {
      server.stop()
    }
  })

  it('worker_threads (MessagePort) matches the HTTP reference', async () => {
    const { port1, port2 } = new MessageChannel()
    const detach = servePort(makeTree(), port1)
    try {
      const got = await exercise(portClient(makeTree(), port2))
      expect(got).toEqual(EXPECTED)
    } finally {
      detach()
    }
  })

  it('stdio (line-framed JSON) matches the HTTP reference', async () => {
    const PassThrough = await loadPassThrough()
    const c2s = new PassThrough()
    const s2c = new PassThrough()
    const client: StdioEnds = { in: s2c as unknown as StdioEnds['in'], out: c2s as unknown as StdioEnds['out'] }
    const server: StdioEnds = { in: c2s as unknown as StdioEnds['in'], out: s2c as unknown as StdioEnds['out'] }
    const detach = serveStdio(makeTree(), server)
    try {
      const got = await exercise(stdioClient(makeTree(), client))
      expect(got).toEqual(EXPECTED)
    } finally {
      detach()
    }
  })
})
