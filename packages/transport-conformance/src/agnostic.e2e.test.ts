// Transport-agnosticism: the KEY assertion of the whole adapter family.
//
// ONE node tree + ONE `clientOver`-derived typed client shape produce IDENTICAL
// `Result`s whether the calls travel over HTTP (request/response), WebSocket
// (duplex channel), worker_threads (MessagePort), or stdio (line-framed JSON).
// We run the same unary + stream calls across every transport and assert every
// path returns the same Results as the HTTP reference path.

import { describe, it, expect } from 'bun:test'
import { ok, branch, leaf, streamLeaf } from '@rhi-zone/fractal-core'
import {
  clientOver,
  compose,
  composeRequestResponse,
  attach,
} from '@rhi-zone/fractal-transport'
import { jsonCodec } from '@rhi-zone/fractal-codec-json'
import { structuredCloneCodec } from '@rhi-zone/fractal-codec-structured-clone'
import { correlation } from '@rhi-zone/fractal-protocol-correlation'
import { serveBun, type BunServer } from '@rhi-zone/fractal-channel-http/bun'
import { httpExchange } from '@rhi-zone/fractal-channel-http/client'
import { portChannel, type MessagePortLike } from '@rhi-zone/fractal-channel-worker'
import { stdioChannel, type StdioEnds } from '@rhi-zone/fractal-channel-stdio'
import { wsClientChannel, wsServeBun } from '@rhi-zone/fractal-channel-websocket'

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
const exercise = async (api: ReturnType<typeof clientOver<ReturnType<typeof makeTree>>>) => {
  const unary = await api.echo('hi')
  const stream: unknown[] = []
  for await (const r of api.count(3)) stream.push(r)
  return { unary, stream }
}

// bun:test's toEqual checks the argument type against the actual; cast to any
// so the literal object (with widened ok: boolean) satisfies the Result<> constraint.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const EXPECTED: any = {
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
      const url = `http://127.0.0.1:${server.port}`
      const got = await exercise(clientOver(makeTree(), composeRequestResponse(httpExchange(url), jsonCodec)))
      expect(got).toEqual(EXPECTED)
    } finally {
      server.stop()
    }
  })

  it('WebSocket matches the HTTP reference', async () => {
    const server = wsServeBun((ch) => attach(makeTree(), ch, jsonCodec, correlation), { port: 0 })
    try {
      const url = `ws://127.0.0.1:${server.port}`
      const got = await exercise(clientOver(makeTree(), compose(wsClientChannel(url), jsonCodec, correlation)))
      expect(got).toEqual(EXPECTED)
    } finally {
      server.stop()
    }
  })

  it('worker_threads (MessagePort) matches the HTTP reference', async () => {
    const { port1, port2 } = new MessageChannel()
    const detach = attach(makeTree(), portChannel(port1), structuredCloneCodec, correlation)
    try {
      const got = await exercise(clientOver(makeTree(), compose(portChannel(port2), structuredCloneCodec, correlation)))
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
    const detach = attach(makeTree(), stdioChannel(server), jsonCodec, correlation)
    try {
      const got = await exercise(clientOver(makeTree(), compose(stdioChannel(client), jsonCodec, correlation)))
      expect(got).toEqual(EXPECTED)
    } finally {
      detach()
    }
  })
})
