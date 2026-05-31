// @rhi-zone/fractal-channel-stdio
// CHANNEL axis instance — stdio. A readable/writable pair (process.stdin/stdout,
// or any Duplex) wrapped as a `Channel<string>` that owns LINE framing ONLY:
// each outbound wire unit is written as `frame + '\n'`; inbound bytes are split
// on '\n'. Value encoding (JSON) is the codec's job — paired with `jsonCodec`
// this is the MCP / LSP-style transport, robust over pipes that chunk
// arbitrarily. Composed with the `correlation` protocol via the kernel's
// `compose` / `attach`.
//
//   channel → `stdioChannel(ends)`               (the pure Channel<string>)
//   client  → `stdioClient(node, {in, out})`     server → `serveStdio(tree, {in,out}, …)`
//
// NOTE (axis purity): the pure CHANNEL (`stdioChannel`) depends on the kernel
// ONLY; `stdioClient`/`serveStdio` CONVENIENCE presets additionally pick the
// codec (`@rhi-zone/fractal-codec-json`) and protocol
// (`@rhi-zone/fractal-protocol-correlation`) — intrinsic to a ready-made preset.

import {
  attach,
  compose,
  clientOver,
  type Channel,
  type DispatcherOptions,
} from '@rhi-zone/fractal-transport'
import { correlation } from '@rhi-zone/fractal-protocol-correlation'
import { jsonCodec } from '@rhi-zone/fractal-codec-json'
import type { AnyNode, UClient } from '@rhi-zone/fractal-core'

/** Options for a stdio server attach (capability grants). */
type AttachOptions = DispatcherOptions

/** Minimal writable stream surface (process.stdout, any Node Writable). */
export interface WritableLike {
  write(chunk: string): unknown
  end?(): void
}
/** Minimal readable stream surface (process.stdin, any Node Readable). */
export interface ReadableLike {
  on(event: 'data', cb: (chunk: unknown) => void): void
  on(event: 'end', cb: () => void): void
}

/** A stdio endpoint: where to read framed messages from and write them to. */
export interface StdioEnds {
  readonly in: ReadableLike
  readonly out: WritableLike
}

const toText = (chunk: unknown): string =>
  typeof chunk === 'string'
    ? chunk
    : chunk instanceof Uint8Array
      ? new TextDecoder().decode(chunk)
      : String(chunk)

/**
 * Wrap a readable/writable pair as a {@link Channel}<string> that owns LINE
 * framing ONLY: each outbound wire unit is written as `frame + '\n'`; inbound
 * bytes are split on '\n' and each non-empty line is emitted as a string. Value
 * encoding (JSON) is the codec's job — composed with {@link jsonCodec}, this is
 * the MCP/LSP-style transport, robust over pipes that chunk arbitrarily.
 */
export const stdioChannel = (ends: StdioEnds): Channel<string> => {
  let buffer = ''
  return {
    send(frame) {
      ends.out.write(frame + '\n')
    },
    onMessage(cb) {
      ends.in.on('data', (chunk) => {
        buffer += toText(chunk)
        let nl: number
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          if (line.length > 0) cb(line)
        }
      })
    },
    close() {
      ends.out.end?.()
    },
  }
}

/** Build a typed client over a stdio pair (line-framed JSON). */
export const stdioClient = <N extends AnyNode>(node: N, ends: StdioEnds): UClient<N> =>
  clientOver(node, compose(stdioChannel(ends), jsonCodec, correlation))

/** Attach a node tree to a stdio pair as the server. Returns a detach fn. */
export const serveStdio = (
  tree: AnyNode,
  ends: StdioEnds,
  options: AttachOptions = {},
): (() => void) => attach(tree, stdioChannel(ends), jsonCodec, correlation, options)
