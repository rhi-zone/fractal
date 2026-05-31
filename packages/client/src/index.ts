// @rhi-zone/fractal-client
// Two client implementations over the same Client<Tree> derived type:
//   1. `client`      — in-process reference interpreter (core.evaluate)
//   2. `httpClient`  — fetch-based HTTP transport, mirrors the interpreter's
//                      path/method/body contract exactly
//
// The derived `Client<N>` type lives in core; this package only provides the
// transport implementations.

export { client } from '@rhi-zone/fractal-core'
export type { Client, ClientOptions } from '@rhi-zone/fractal-core'

import type { AnyNode, Branch, InputOf, OutputOf, ErrorOf, Result } from '@rhi-zone/fractal-core'

/** Options accepted by `httpClient` and `httpClientWithHeaders`. */
export interface HttpClientOptions {
  /**
   * The fetch implementation to use for requests. Defaults to `globalThis.fetch`.
   * Inject a custom implementation to run the client in environments without a
   * global `fetch`, or to mock requests in tests.
   */
  fetch?: typeof globalThis.fetch
}

/**
 * Build an HTTP client over a node tree. The Proxy mirrors the same shape as
 * `client()` but issues `fetch` calls following the HTTP interpreter contract:
 *
 *   branch key   → URL path segment  (each level appends one segment)
 *   leaf input   → POST body as JSON  (`Content-Type: application/json`)
 *   200 body     → { ok: true,  value: O }  (unwrapped from the server's Result)
 *   non-200 body → { ok: false, error: E }
 *
 * Only the path mapping is the contract; method is always POST so the body is
 * always sent. (The interpreter's `serve` reads `req.body` regardless of method.)
 *
 * `baseUrl` should be e.g. `http://127.0.0.1:3000` (no trailing slash).
 *
 * Pass `opts.fetch` to inject a custom fetch implementation; defaults to
 * `globalThis.fetch` (available in Node 20+, Bun, Deno, browsers).
 */
export const httpClient = <N extends AnyNode>(
  node: N,
  baseUrl: string,
  opts?: HttpClientOptions,
): HttpClient<N> => {
  const fetchFn = opts?.fetch ?? globalThis.fetch
  const build = (current: AnyNode, pathSoFar: string): unknown => {
    if (current.tag === 'branch') {
      const children = current.children as Record<string, AnyNode>
      return new Proxy(
        {},
        {
          get: (_t, prop: string | symbol) => {
            if (typeof prop !== 'string' || !(prop in children)) return undefined
            const child = children[prop]
            return child === undefined
              ? undefined
              : build(child, `${pathSoFar}/${prop}`)
          },
          has: (_t, prop) => typeof prop === 'string' && prop in children,
          ownKeys: () => Object.keys(children),
          getOwnPropertyDescriptor: (_t, prop) =>
            typeof prop === 'string' && prop in children
              ? { enumerable: true, configurable: true }
              : undefined,
        },
      )
    }
    // Callable node: issue a POST to the accumulated path with the input as JSON body.
    return async (input: unknown): Promise<Result<unknown, unknown>> => {
      const url = `${baseUrl}${pathSoFar}`
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      const json = await res.json() as unknown
      if (res.ok) {
        return { ok: true, value: json } as Result<unknown, unknown>
      }
      return { ok: false, error: json } as Result<unknown, unknown>
    }
  }
  return build(node, '') as HttpClient<N>
}

/** Options accepted by `httpClientWithHeaders`. */
export interface HttpClientWithHeadersOptions extends HttpClientOptions {}

/**
 * Build an HTTP client over a node tree, with per-request extra headers.
 * Identical to `httpClient` but each call accepts an optional `headers` record
 * that is merged into the request (useful for Authorization tokens in tests).
 *
 * Pass `opts.fetch` to inject a custom fetch implementation; defaults to
 * `globalThis.fetch`.
 */
export const httpClientWithHeaders = <N extends AnyNode>(
  node: N,
  baseUrl: string,
  opts?: HttpClientWithHeadersOptions,
): HttpClientWithHeaders<N> => {
  const fetchFn = opts?.fetch ?? globalThis.fetch
  const build = (current: AnyNode, pathSoFar: string): unknown => {
    if (current.tag === 'branch') {
      const children = current.children as Record<string, AnyNode>
      return new Proxy(
        {},
        {
          get: (_t, prop: string | symbol) => {
            if (typeof prop !== 'string' || !(prop in children)) return undefined
            const child = children[prop]
            return child === undefined
              ? undefined
              : build(child, `${pathSoFar}/${prop}`)
          },
          has: (_t, prop) => typeof prop === 'string' && prop in children,
          ownKeys: () => Object.keys(children),
          getOwnPropertyDescriptor: (_t, prop) =>
            typeof prop === 'string' && prop in children
              ? { enumerable: true, configurable: true }
              : undefined,
        },
      )
    }
    return async (input: unknown, extraHeaders?: Record<string, string>): Promise<Result<unknown, unknown>> => {
      const url = `${baseUrl}${pathSoFar}`
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...extraHeaders },
        body: JSON.stringify(input),
      })
      const json = await res.json() as unknown
      if (res.ok) {
        return { ok: true, value: json } as Result<unknown, unknown>
      }
      return { ok: false, error: json } as Result<unknown, unknown>
    }
  }
  return build(node, '') as HttpClientWithHeaders<N>
}

/**
 * Derived Client type for HTTP transport: same shape as Client<N> but the
 * callable form also accepts an optional extra-headers argument.
 */
export type HttpClient<N> =
  N extends Branch<infer C>
    ? { readonly [K in keyof C]: HttpClient<C[K]> }
    : N extends AnyNode
      ? (input: InputOf<N>) => Promise<Result<OutputOf<N>, ErrorOf<N>>>
      : never

export type HttpClientWithHeaders<N> =
  N extends Branch<infer C>
    ? { readonly [K in keyof C]: HttpClientWithHeaders<C[K]> }
    : N extends AnyNode
      ? (input: InputOf<N>, headers?: Record<string, string>) => Promise<Result<OutputOf<N>, ErrorOf<N>>>
      : never
