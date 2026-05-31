// @rhi-zone/fractal-channel-worker
// CHANNEL axis instance — worker_threads MessagePort. A persistent-duplex medium
// that moves whole objects and structured-clones them on transfer, so it owns
// "framing" by message boundary. Wrapped as a `Channel<unknown>` and paired with
// the IDENTITY `structuredCloneCodec` (no JSON), any clone-transferable value
// (TypedArrays, Maps, …) inside a Result survives. Composed with the
// `correlation` protocol via the kernel's `compose` / `attach`.
//
//   channel → `portChannel(port)`               (the pure Channel<unknown>)
//
// Covers both `node:worker_threads` MessagePort and the web `MessageChannel`
// port.
//
// AXIS PURITY: this package depends on the transport KERNEL ONLY. It picks NO
// codec and NO protocol. Self-compose at the call site (this IS the preset):
//
//   client : clientOver(node, compose(portChannel(port), structuredCloneCodec, correlation))
//   server : attach(tree, portChannel(port), structuredCloneCodec, correlation, opts)

import type { Channel } from '@rhi-zone/fractal-transport'

/**
 * The MessagePort surface used here — covers both `node:worker_threads`
 * MessagePort and the web `MessageChannel` port. Only the members we touch are
 * declared (avoids @types/node). `on('message', …)` (Node) and
 * `addEventListener('message', …)` (web) are both supported.
 */
export interface MessagePortLike {
  postMessage(value: unknown): void
  on?(event: 'message', cb: (value: unknown) => void): void
  addEventListener?(event: 'message', cb: (ev: { data: unknown }) => void): void
  start?(): void
  close?(): void
}

/**
 * Wrap a {@link MessagePortLike} as a {@link Channel}<unknown>: the medium moves
 * whole objects and structured-clones them on transfer, so it owns "framing" by
 * message boundary. Paired with the identity {@link structuredCloneCodec} (no
 * JSON), any clone-transferable value (TypedArrays, Maps, …) inside a Result
 * survives.
 */
export const portChannel = (port: MessagePortLike): Channel<unknown> => ({
  send(msg) {
    port.postMessage(msg)
  },
  onMessage(cb) {
    if (typeof port.on === 'function') {
      port.on('message', (value) => cb(value))
    } else if (typeof port.addEventListener === 'function') {
      port.addEventListener('message', (ev) => cb(ev.data))
    }
    port.start?.()
  },
  close() {
    port.close?.()
  },
})
