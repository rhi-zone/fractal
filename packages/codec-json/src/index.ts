// @rhi-zone/fractal-codec-json
// CODEC axis instance — JSON. `JSON.stringify` / `JSON.parse`; wire unit is a
// string. Pairs with any `Channel<string>` (WebSocket text frames, stdio line
// framing, HTTP request/response bodies). Depends only on the transport kernel
// for the `Codec` interface.

import type { Codec } from '@rhi-zone/fractal-transport'

/** JSON codec: `JSON.stringify` / `JSON.parse`. Wire unit is a string. */
export const jsonCodec: Codec<string> = {
  encode: (value) => JSON.stringify(value),
  decode: (wire) => JSON.parse(wire) as unknown,
}
