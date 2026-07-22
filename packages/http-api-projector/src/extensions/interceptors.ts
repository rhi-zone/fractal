// packages/http-api-projector/src/extensions/interceptors.ts — @rhi-zone/fractal-http-api-projector
//
// Built-in `ClientExtension`: pre-request / post-response / on-error hooks —
// the degenerate case of `wrapFetch` that calls `inner` exactly once (see
// extension.ts's module doc). Enables auth-header injection, logging,
// metrics, request/response transformation, etc., without writing a
// `wrapFetch` from scratch.
//
// Runtime-only: hooks are arbitrary functions, and codegen emits SOURCE TEXT
// (see extension.ts's `ClientExtensionCodegen`) — a function value has no
// general textual representation codegen could embed. This is a genuine
// design fork (not a shortcut): serializing hooks into generated source
// would need either (a) restricting hooks to a serializable expression
// language, or (b) requiring the user to author a source-code snippet
// instead of a JS function, changing what "configuring an extension" means.
// Left open — pick a direction only if/when a concrete codegen use case
// needs it; documented as a next step, not implemented speculatively.

import type { ClientExtension, FetchImpl } from "../extension.ts"

export type InterceptorsOptions = {
  /** Runs before the request is sent; return the request to send (transformed or as-is). */
  readonly onRequest?: (req: Request) => Request | Promise<Request>
  /** Runs after a response is received; return the response to hand back (transformed or as-is). */
  readonly onResponse?: (res: Response, req: Request) => Response | Promise<Response>
  /** Runs when `inner` throws (network error, abort, etc.). The original error is always rethrown afterward. */
  readonly onError?: (err: unknown, req: Request) => void
}

/**
 * Pre-request / post-response / on-error hook extension.
 *
 * @example
 * createClient(node, {
 *   baseUrl,
 *   extensions: [interceptors({
 *     onRequest: (req) => new Request(req, { headers: { ...req.headers, Authorization: `Bearer ${token}` } }),
 *     onResponse: (res) => { console.log(res.status); return res },
 *   })],
 * })
 */
export function interceptors(options: InterceptorsOptions = {}): ClientExtension {
  const wrapFetch = (inner: FetchImpl): FetchImpl => async (req: Request): Promise<Response> => {
    const finalReq = options.onRequest !== undefined ? await options.onRequest(req) : req
    try {
      const res = await inner(finalReq)
      return options.onResponse !== undefined ? await options.onResponse(res, finalReq) : res
    } catch (err) {
      options.onError?.(err, finalReq)
      throw err
    }
  }

  return { name: "interceptors", wrapFetch }
}
