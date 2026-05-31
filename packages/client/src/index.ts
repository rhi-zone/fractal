// @rhi-zone/fractal-client
// Client surface over the unified transport core. Two implementations of the
// same derived `UClient<Tree>` type:
//   1. `client`     — in-process reference interpreter (core.evaluate / clientOver)
//   2. `httpClient` — fetch-based HTTP transport (clientOver(node, httpTransport))
//
// The runtime Proxy and the Transport contract now live in rpc-dispatch; the
// HTTP transport lives in @rhi-zone/fractal-http/client. This package re-exports
// them as the stable client entry point.
//
// `httpClientWithHeaders` is retained as an ALIAS of `httpClient`: per-call
// headers are now just the `meta?` slot of every client method
// (`call(input, meta)` → meta entries become request headers), so the dedicated
// "with headers" variant is no longer a separate code path.

// In-process client + derived types from core.
export { client } from '@rhi-zone/fractal-core'
export type { Client, UClient, ClientOptions, Meta } from '@rhi-zone/fractal-core'

// The transport core: the Proxy builder and the Transport contract.
export { clientOver } from '@rhi-zone/fractal-rpc-dispatch'
export type { Transport } from '@rhi-zone/fractal-rpc-dispatch'

// The HTTP transport + typed HTTP client.
export { httpClient, httpTransport } from '@rhi-zone/fractal-http/client'
export type { HttpTransportOptions } from '@rhi-zone/fractal-http/client'

import { httpClient } from '@rhi-zone/fractal-http/client'

/**
 * @deprecated Use {@link httpClient} — per-call headers are now the `meta?`
 * argument of every client method. Retained as an alias so existing call sites
 * keep working: `httpClientWithHeaders(tree, baseUrl)` ≡ `httpClient(tree, baseUrl)`,
 * and `api.method(input, { authorization: 'Bearer x' })` threads those entries
 * as request headers.
 */
export const httpClientWithHeaders = httpClient

/** Back-compat option aliases. */
export type { HttpTransportOptions as HttpClientOptions } from '@rhi-zone/fractal-http/client'
export type { HttpTransportOptions as HttpClientWithHeadersOptions } from '@rhi-zone/fractal-http/client'
