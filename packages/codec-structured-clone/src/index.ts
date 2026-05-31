// @rhi-zone/fractal-codec-structured-clone
// CODEC axis instance — structured clone (IDENTITY). The wire unit is the
// envelope object itself; the channel's medium (a worker `MessagePort`)
// structured-clones it on transfer, so any clone-transferable value
// (TypedArrays, Maps, …) inside a Result survives without a JSON round-trip.
// Depends only on the transport kernel for the `Codec` interface.

import type { Codec } from '@rhi-zone/fractal-transport'

/**
 * Structured-clone codec: IDENTITY. The wire unit is the envelope object itself;
 * the channel's medium (a worker `MessagePort`) structured-clones it on transfer,
 * so any clone-transferable value (TypedArrays, Maps, …) inside a Result
 * survives without a JSON round-trip.
 */
export const structuredCloneCodec: Codec<unknown> = {
  encode: (value) => value,
  decode: (wire) => wire,
}
