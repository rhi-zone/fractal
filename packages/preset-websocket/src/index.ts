// @rhi-zone/fractal-preset-websocket
//
// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  CONVENIENCE SUGAR ONLY — NOT THE ONLY OR BLESSED WAY                      ║
// ║                                                                              ║
// ║  This preset is a thin saved `compose`/closure over the kernel assemblers.  ║
// ║  You can drop to raw `compose`/`attach` at any time to swap codec or        ║
// ║  protocol — no magic here, no lock-in.                                      ║
// ║                                                                              ║
// ║  Verbatim equivalents (copy-paste and adjust as needed):                    ║
// ║                                                                              ║
// ║    CLIENT:                                                                   ║
// ║      clientOver(node, compose(wsClientChannel(url), jsonCodec, correlation)) ║
// ║                                                                              ║
// ║    SERVER:                                                                   ║
// ║      wsServeBun((ch) => attach(tree, ch, jsonCodec, correlation, opts), opts)║
// ╚══════════════════════════════════════════════════════════════════════════════╝

import type { AnyNode, UClient } from '@rhi-zone/fractal-core'
import { clientOver, compose, attach, type DispatcherOptions } from '@rhi-zone/fractal-transport'
import { wsClientChannel, wsServeBun, type WsClientOptions, type ServeWsOptions, type WsServer } from '@rhi-zone/fractal-channel-websocket'
import { jsonCodec } from '@rhi-zone/fractal-codec-json'
import { correlation } from '@rhi-zone/fractal-protocol-correlation'

/**
 * Convenience preset: build a typed client over a WebSocket connection to `url`.
 *
 * Equivalent one-liner (use this directly to swap codec or protocol):
 *   `clientOver(node, compose(wsClientChannel(url), jsonCodec, correlation))`
 *
 * @param node  The fractal node tree that defines the API shape.
 * @param url   The WebSocket URL to connect to (e.g. `ws://localhost:3000`).
 * @param opts  Optional: inject a `WebSocket` constructor (non-browser/Bun envs).
 */
export const wsClient = <N extends AnyNode>(node: N, url: string, opts?: WsClientOptions): UClient<N> =>
  clientOver(node, compose(wsClientChannel(url, opts), jsonCodec, correlation))

/**
 * Convenience preset: start a Bun-native WebSocket server that attaches `tree`
 * to each incoming connection using JSON + correlation.
 *
 * Equivalent one-liner (use this directly to swap codec or protocol):
 *   `wsServeBun((ch) => attach(tree, ch, jsonCodec, correlation, opts), opts)`
 *
 * @param tree  The fractal node tree to serve.
 * @param opts  Server options (`port`, `hostname`) and dispatcher options (`grants`).
 */
export const serveWs = (tree: AnyNode, opts: ServeWsOptions & DispatcherOptions = {}): WsServer =>
  wsServeBun((ch) => attach(tree, ch, jsonCodec, correlation, opts), opts)
