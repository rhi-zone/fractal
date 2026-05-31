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
//
// AXIS PURITY: this package depends on the transport KERNEL ONLY. It picks NO
// codec and NO protocol. Self-compose at the call site (this IS the preset):
//
//   client : clientOver(node, compose(stdioChannel(ends), jsonCodec, correlation))
//   server : attach(tree, stdioChannel(ends), jsonCodec, correlation, opts)

import type { Channel } from '@rhi-zone/fractal-transport'

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
