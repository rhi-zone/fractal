// @rhi-zone/fractal-rpc-dispatch/channel
// CHANNEL axis — one of the three orthogonal transport axes (channel × codec ×
// protocol). A Channel is the MEDIUM: it moves already-encoded wire units and
// owns MEDIUM-level framing (WebSocket native frames, MessagePort message
// boundaries, stdio line/length framing, HTTP request/response). It knows
// NOTHING about value encoding (that is the {@link Codec}) and NOTHING about
// call correlation/semantics (that is the {@link Protocol}).
//
//   send(wire)        : hand one encoded wire unit to the medium
//   onMessage(cb)     : the medium hands back one encoded wire unit at a time
//   close()           : tear the medium down
//
// The wire-unit type `W` is the medium's natural unit:
//   - `Channel<string>`  — WebSocket text frames, stdio line-framed text
//   - `Channel<unknown>` — a worker MessagePort (the unit is the cloned object)
//
// `W` MUST match the {@link Codec} it is composed with; `compose`/`attach`
// enforce the pairing at the type level.

/**
 * A duplex message medium that moves already-encoded wire units `W` and owns
 * medium-level framing. The ONLY surface a {@link Protocol} sees (after a
 * {@link Codec} is layered over it by `compose`).
 */
export interface Channel<W = unknown> {
  send(wire: W): void
  /** Register the wire-unit handler. Called once with each inbound wire unit. */
  onMessage(cb: (wire: W) => void): void
  close(): void
}

/**
 * The decoded view a {@link Protocol} consumes: a medium that moves DECODED
 * envelope objects (the {@link Codec} has been layered over a raw
 * {@link Channel}). Structurally identical to a `Channel<unknown>`, but named
 * separately to mark the layer: protocols never touch wire units, only envelopes.
 */
export interface MessageStream {
  send(msg: unknown): void
  onMessage(cb: (msg: unknown) => void): void
  close(): void
}
