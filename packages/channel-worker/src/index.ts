// @rhi-zone/fractal-channel-worker
// CHANNEL axis instance — worker_threads MessagePort. A persistent-duplex medium
// that moves whole objects and structured-clones them on transfer, so it owns
// "framing" by message boundary. Wrapped as a `Channel<unknown>` and paired with
// the IDENTITY `structuredCloneCodec` (no JSON), any clone-transferable value
// (TypedArrays, Maps, …) inside a Result survives. Composed with the
// `correlation` protocol via the kernel's `compose` / `attach`.
//
//   channel → `portChannel(port)`               (the pure Channel<unknown>)
//   client  → `portClient(node, port)`          server → `servePort(tree, port, …)`
//
// Covers both `node:worker_threads` MessagePort and the web `MessageChannel`
// port.
//
// NOTE (axis purity): the pure CHANNEL (`portChannel`) depends on the kernel
// ONLY; `portClient`/`servePort` CONVENIENCE presets additionally pick the codec
// (`@rhi-zone/fractal-codec-structured-clone`) and protocol
// (`@rhi-zone/fractal-protocol-correlation`) — intrinsic to a ready-made preset.

import {
  attach,
  compose,
  clientOver,
  type Channel,
  type DispatcherOptions,
} from '@rhi-zone/fractal-transport'
import { correlation } from '@rhi-zone/fractal-protocol-correlation'
import { structuredCloneCodec } from '@rhi-zone/fractal-codec-structured-clone'
import type { AnyNode, UClient } from '@rhi-zone/fractal-core'

/** Options for a worker server attach (capability grants). */
type AttachOptions = DispatcherOptions

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

/** Build a typed client over a {@link MessagePortLike} (structured clone). */
export const portClient = <N extends AnyNode>(node: N, port: MessagePortLike): UClient<N> =>
  clientOver(node, compose(portChannel(port), structuredCloneCodec, correlation))

/** Attach a node tree to a {@link MessagePortLike} as the server. Returns a detach fn. */
export const servePort = (
  tree: AnyNode,
  port: MessagePortLike,
  options: AttachOptions = {},
): (() => void) => attach(tree, portChannel(port), structuredCloneCodec, correlation, options)
