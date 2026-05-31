// @rhi-zone/fractal-transport/codec
// CODEC axis — one of the three orthogonal transport axes (channel × codec ×
// protocol). A Codec is the value↔wire encoding, extracted OUT of the channels:
// channels move already-encoded wire units and own medium-level framing; the
// Codec alone knows how a protocol envelope (a plain object) becomes the wire
// unit a channel transports, and back.
//
//   encode: protocol envelope (object) → wire unit (string | bytes | object …)
//   decode: wire unit → protocol envelope (object)
//
// The wire-unit type `W` is the codec's choice and MUST match the channel it is
// composed with (a `Channel<string>` pairs with a `Codec<string>`; a
// `Channel<unknown>` pairs with the identity `Codec<unknown>`). `compose`
// enforces this pairing at the type level.
//
// This kernel module declares ONLY the `Codec` interface. Concrete codec
// instances live in their own per-axis packages:
//   - `@rhi-zone/fractal-codec-json`              → jsonCodec
//   - `@rhi-zone/fractal-codec-structured-clone`  → structuredCloneCodec

/**
 * A Codec converts a protocol envelope (a plain value/object) to and from the
 * wire unit `W` that a {@link import('./channel.ts').Channel} transports.
 *
 *   - `W = string` for textual encodings (JSON) carried over text frames /
 *     line framing.
 *   - `W = unknown` for the identity codec (structured clone): the wire unit IS
 *     the object, so no encoding happens — the medium (a MessagePort) clones it.
 *   - RESERVED `W = Uint8Array` for binary encodings (Cap'n Proto, Protobuf,
 *     FlatBuffers, MessagePack) — a new `Codec<Uint8Array>` in its own package.
 */
export interface Codec<W = unknown> {
  encode(value: unknown): W
  decode(wire: W): unknown
}
