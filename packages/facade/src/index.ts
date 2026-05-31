// @rhi-zone/fractal-facade
// Aggregator + user-facing entry point. Re-exports the whole transport surface
// (kernel + every codec / protocol / channel axis package) and ships the
// CONVENIENCE presets that bind axes into ready-made clients/servers.
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
} from '@rhi-zone/fractal-transport'

// ── codec axis instances ──────────────────────────────────────────────────────
export { jsonCodec } from '@rhi-zone/fractal-codec-json'
export { structuredCloneCodec } from '@rhi-zone/fractal-codec-structured-clone'

// ── protocol axis instances ───────────────────────────────────────────────────
export { correlation } from '@rhi-zone/fractal-protocol-correlation'

// ── channel axis instances + their ready-made clients/servers ─────────────────

// HTTP (request/response): server handlers + exchange + typed client.
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
export { httpExchange, httpTransport, httpClient } from '@rhi-zone/fractal-channel-http/client'
export type { HttpTransportOptions } from '@rhi-zone/fractal-channel-http/client'

// WebSocket (duplex correlation).
export { wsClient, wsServerChannel, serveWsBun } from '@rhi-zone/fractal-channel-websocket'
export type { WsClientOptions, WsServer, ServeWsOptions } from '@rhi-zone/fractal-channel-websocket'

// worker_threads MessagePort (duplex correlation, structured clone).
export { portChannel, portClient, servePort } from '@rhi-zone/fractal-channel-worker'
export type { MessagePortLike } from '@rhi-zone/fractal-channel-worker'

// stdio (duplex correlation, line-framed JSON).
export { stdioChannel, stdioClient, serveStdio } from '@rhi-zone/fractal-channel-stdio'
export type { StdioEnds, ReadableLike, WritableLike } from '@rhi-zone/fractal-channel-stdio'

// ── back-compat client aliases (formerly @rhi-zone/fractal-client) ─────────────
import { httpClient } from '@rhi-zone/fractal-channel-http/client'

/**
 * @deprecated Use {@link httpClient} — per-call headers are now the `meta?`
 * argument of every client method. Retained as an alias so existing call sites
 * keep working: `httpClientWithHeaders(tree, baseUrl)` ≡ `httpClient(tree, baseUrl)`.
 */
export const httpClientWithHeaders = httpClient

/** Back-compat option aliases. */
export type { HttpTransportOptions as HttpClientOptions } from '@rhi-zone/fractal-channel-http/client'
export type { HttpTransportOptions as HttpClientWithHeadersOptions } from '@rhi-zone/fractal-channel-http/client'
