// @rhi-zone/fractal-codec-json
// CODEC axis instance — JSON. `JSON.stringify` / `JSON.parse`; wire unit is a
// string. Pairs with any `Channel<string>` (WebSocket text frames, stdio line
// framing, HTTP request/response bodies). Depends only on the transport kernel
// for the `Codec` interface.

import type { Codec } from '@rhi-zone/fractal-transport'

/**
 * JSON codec: `JSON.stringify` / `JSON.parse`. Wire unit is a string.
 *
 * `encode(undefined)` yields `''` (an absent value has no JSON form), and
 * `decode('')` round-trips it back to `undefined`. This makes the empty wire
 * unit the canonical "no value" — a medium that carries no body (an empty HTTP
 * request body, a bare line) decodes to `undefined` rather than throwing.
 */
export const jsonCodec: Codec<string> = {
  encode: (value) => (value === undefined ? '' : JSON.stringify(value)),
  decode: (wire) => (wire === '' ? undefined : (JSON.parse(wire) as unknown)),
}
