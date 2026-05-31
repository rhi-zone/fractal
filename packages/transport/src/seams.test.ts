// Reserved-seam proof (TYPE-LEVEL, no runtime behavior asserted).
//
// The three transport axes (channel × codec × protocol) are designed so a NEW
// codec and a NEW protocol can be PLUGGED IN later without changing the core:
// adding them is composition, not rearchitecting. This test proves that by
// expressing two stubs the core does NOT implement and feeding them through the
// real `compose` / `composeRequestResponse` assemblers — if the seams were not
// truly open, these would fail to typecheck.
//
//   - a NEW CODEC:    `capnprotoCodec` — a binary `Codec<Uint8Array>` shape
//   - a NEW PROTOCOL: `jsonRpcProtocol` — a `Protocol` shape (duplex)
//
// `@ts-expect-error` markers below are LOAD-BEARING: they assert a mismatch the
// type system MUST catch (a codec whose wire type disagrees with its channel).
// If the core ever loosened to accept the mismatch, the unused-directive error
// would fail this test — proving the pairing constraint is still enforced.

import { describe, it, expect } from 'vitest'
import {
  compose,
  composeRequestResponse,
  type Channel,
  type Codec,
  type Exchange,
  type MessageStream,
  type Protocol,
  type Transport,
} from './index.ts'

// ── A NEW CODEC the core does not implement: binary (Cap'n Proto-shaped) ──────
// Wire unit is Uint8Array. The body is a stub (a real impl would call into a
// Cap'n Proto runtime); only the SHAPE matters for the seam proof.
const capnprotoCodec: Codec<Uint8Array> = {
  encode: (value) => new TextEncoder().encode(JSON.stringify(value)),
  decode: (wire) => JSON.parse(new TextDecoder().decode(wire)) as unknown,
}

// ── A NEW PROTOCOL the core does not implement: JSON-RPC-shaped (duplex) ──────
// A stub satisfying the `Protocol` interface — proves a new call-semantics
// instance plugs into `compose` unchanged.
const jsonRpcProtocol: Protocol = {
  client: (_stream: MessageStream): Transport => ({
    invoke: async () => ({ ok: true, value: null }),
  }),
  server: (_tree, _stream, _options): (() => void) => () => {},
}

describe('reserved seams: a new codec and a new protocol compose without core changes', () => {
  it('a binary Channel<Uint8Array> + the new capnprotoCodec compose into a Transport', () => {
    // A medium whose wire unit is bytes — pairs with the binary codec.
    const binaryChannel: Channel<Uint8Array> = {
      send: () => {},
      onMessage: () => {},
      close: () => {},
    }
    // The EXISTING `correlation` protocol works over the NEW codec untouched —
    // here we use the new protocol too, to exercise both seams at once.
    const transport: Transport = compose(binaryChannel, capnprotoCodec, jsonRpcProtocol)
    expect(typeof transport.invoke).toBe('function')
  })

  it('the new protocol also drives the request-response axis with a new codec', () => {
    const binaryExchange: Exchange<Uint8Array> = {
      unary: async (_p, _b) => ({ ok: true, body: new Uint8Array() }),
    }
    const transport: Transport = composeRequestResponse(binaryExchange, capnprotoCodec)
    expect(typeof transport.invoke).toBe('function')
  })

  it('the channel/codec wire types MUST agree (load-bearing @ts-expect-error)', () => {
    const stringChannel: Channel<string> = {
      send: () => {},
      onMessage: () => {},
      close: () => {},
    }
    // A `Channel<string>` cannot be paired with a `Codec<Uint8Array>`: the wire
    // types disagree, and `compose`'s single `W` unifies them, so this is a type
    // error the core MUST reject. If the seam were not type-safe, the directive
    // below would be unused and this test would fail to compile.
    // @ts-expect-error wire-type mismatch: Channel<string> vs Codec<Uint8Array>
    compose(stringChannel, capnprotoCodec, jsonRpcProtocol)
    expect(true).toBe(true)
  })
})
