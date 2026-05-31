// @rhi-zone/fractal-facade
// Aggregator + user-facing entry point. Re-exports the whole transport surface:
// the kernel (interfaces + assemblers) + every codec / protocol / channel axis
// package. It exposes the PURE per-axis pieces (channels, codecs, protocols) and
// the kernel assemblers (`compose` / `attach` / `composeRequestResponse` /
// `serveExchange` / `clientOver`); there are NO preset packages — the saved
// `compose(...)` one-liner IS the preset. Each medium's one-liner:
//
//   ws     : clientOver(node, compose(wsClientChannel(url), jsonCodec, correlation))
//            wsServeBun((ch) => attach(tree, ch, jsonCodec, correlation, opts), { port })
//   worker : clientOver(node, compose(portChannel(port), structuredCloneCodec, correlation))
//            attach(tree, portChannel(port), structuredCloneCodec, correlation, opts)
//   stdio  : clientOver(node, compose(stdioChannel(ends), jsonCodec, correlation))
//            attach(tree, stdioChannel(ends), jsonCodec, correlation, opts)
//   http   : clientOver(node, composeRequestResponse(httpExchange(baseUrl), jsonCodec))
//            serveBun(tree, opts) / serveNode(tree, opts) / toWebHandler(tree, opts)
//
// Dependency direction: facade → { kernel, all codecs, all protocols, all
// channels } → core. This is the only package that depends on every axis at
// once; the per-axis packages stay independent.

// ── core (node algebra + combinators + in-process client) ─────────────────────
export {
  ok,
  err,
  evaluate,
  evaluateStream,
  client,
  leaf,
  streamLeaf,
  branch,
  annotate,
  capability,
  withCapability,
  identity,
  withAuth,
  withRateLimit,
  validated,
  route,
  get,
} from '@rhi-zone/fractal-core'
export type {
  Result,
  Context,
  Handler,
  StreamHandler,
  Callable,
  Client,
  UClient,
  ClientOptions,
  Meta,
  Annotation,
  NodeMeta,
  Leaf,
  StreamLeaf,
  LeafMode,
  Branch,
  Annotated,
  Seq,
  AnyNode,
  InputOf,
  OutputOf,
  ErrorOf,
  ModeOf,
  CapsOf,
  Chainable,
  Capability,
  LeafNode,
  StreamLeafNode,
  BranchNode,
  SeqNode,
  AnnotatedNode,
  UnauthorizedError,
  AuthCaps,
  RateLimitedError,
  RateLimitCaps,
  ValidationError,
} from '@rhi-zone/fractal-core'

// ── transport kernel (interfaces + assemblers + dispatcher + clientOver) ───────
export {
  dispatcher,
  clientOver,
  compose,
  attach,
  composeRequestResponse,
  serveExchange,
} from '@rhi-zone/fractal-transport'
export type {
  Transport,
  DispatchRequest,
  DispatchOutcome,
  DispatcherOptions,
  CapGrant,
  Channel,
  MessageStream,
  Codec,
  Protocol,
  Exchange,
  ExchangeResponse,
  EncodedRequest,
  EncodedOutcome,
} from '@rhi-zone/fractal-transport'

// ── codec axis instances ──────────────────────────────────────────────────────
export { jsonCodec } from '@rhi-zone/fractal-codec-json'
export { structuredCloneCodec } from '@rhi-zone/fractal-codec-structured-clone'

// ── protocol axis instances ───────────────────────────────────────────────────
export { correlation } from '@rhi-zone/fractal-protocol-correlation'

// ── channel axis instances (PURE channels + medium server factories) ──────────
// No preset packages: compose the pure channel with a codec + protocol via the
// kernel assemblers (see the one-liners in the module header).

// HTTP (request/response). `httpExchange` is the pure CHANNEL; `serve` /
// `toWebHandler` / `serveBun` / `serveNode` are the codec-parameterized server
// handlers (default JSON, pass any `Codec<string>` via `options.codec`).
export { serve, outcomeStatus, defaultErrorStatus, buildDispatcher, toDispatchRequest } from '@rhi-zone/fractal-channel-http'
export type { HttpRequestLike, HttpResponseLike, ServeOptions } from '@rhi-zone/fractal-channel-http'
// The HTTP-flavoured CapGrant (`(req: HttpRequestLike) => handle`), exported
// under a distinct name so it does not collide with the kernel's dispatch
// `CapGrant` (`(req: DispatchRequest) => handle`).
export type { CapGrant as HttpCapGrant } from '@rhi-zone/fractal-channel-http'
export { toWebHandler, NDJSON_CONTENT_TYPE } from '@rhi-zone/fractal-channel-http/web'
export type { WebHandlerOptions } from '@rhi-zone/fractal-channel-http/web'
export { serveBun } from '@rhi-zone/fractal-channel-http/bun'
export type { BunServer, BunServeOptions } from '@rhi-zone/fractal-channel-http/bun'
export { serveNode } from '@rhi-zone/fractal-channel-http/node'
export type { NodeServer, NodeServeOptions } from '@rhi-zone/fractal-channel-http/node'
export { httpExchange } from '@rhi-zone/fractal-channel-http/client'
export type { HttpTransportOptions } from '@rhi-zone/fractal-channel-http/client'

// WebSocket: pure client channel + pure Bun server factory.
export { wsClientChannel, wsServerChannel, wsServeBun } from '@rhi-zone/fractal-channel-websocket'
export type { WsClientOptions, WsServer, ServeWsOptions } from '@rhi-zone/fractal-channel-websocket'

// WebSocket preset: convenience wsClient + serveWs (sugar over compose/attach — not the only way).
export { wsClient, serveWs } from '@rhi-zone/fractal-preset-websocket'

// worker_threads MessagePort: pure channel.
export { portChannel } from '@rhi-zone/fractal-channel-worker'
export type { MessagePortLike } from '@rhi-zone/fractal-channel-worker'

// stdio: pure channel.
export { stdioChannel } from '@rhi-zone/fractal-channel-stdio'
export type { StdioEnds, ReadableLike, WritableLike } from '@rhi-zone/fractal-channel-stdio'
