import { describe, it, expect } from 'vitest'
import type { Codec } from '@rhi-zone/fractal-transport'
import { composeRequestResponse, type Exchange } from './index.ts'

// An inline JSON codec — kept local so this package's test does not depend on a
// sibling codec package (which would couple the build tiers).
const jsonCodec: Codec<string> = {
  encode: (value) => JSON.stringify(value),
  decode: (wire) => JSON.parse(wire) as unknown,
}

describe('request-response protocol form (composeRequestResponse)', () => {
  it('maps a unary exchange ok/error flag onto the Result', async () => {
    const exchange: Exchange<string> = {
      unary: async (_path, body) => ({ ok: true, body }),
    }
    const transport = composeRequestResponse(exchange, jsonCodec)
    expect(await transport.invoke(['echo'], { n: 1 })).toEqual({ ok: true, value: { n: 1 } })
  })

  it('maps a non-ok exchange onto an error Result', async () => {
    const exchange: Exchange<string> = {
      unary: async () => ({ ok: false, body: jsonCodec.encode({ code: 'boom' }) }),
    }
    const transport = composeRequestResponse(exchange, jsonCodec)
    expect(await transport.invoke(['x'], undefined)).toEqual({ ok: false, error: { code: 'boom' } })
  })

  it('advertises stream only when the exchange provides one', () => {
    const unaryOnly: Exchange<string> = { unary: async (_p, b) => ({ ok: true, body: b }) }
    expect(composeRequestResponse(unaryOnly, jsonCodec).stream).toBeUndefined()
  })
})
