// packages/http-api-projector/src/extension.ts — @rhi-zone/fractal-http-api-projector
//
// Extension API for the HTTP client — shared by BOTH the runtime Proxy
// client (client.ts's `createClient`/`createClientFromRoute`) and the
// standalone codegen (codegen.ts's `generateClient`/`generateClientFromNode`).
//
// One `ClientExtension` value, two interpreters:
//   - runtime:  `composeFetch`        wraps the fetch FUNCTION
//   - codegen:  `composeCodegenFetch` wraps the fetch EXPRESSION (source text)
// Same shape, consumed differently — the "extensible DU + interpreter"
// pattern (docs/design/design-philosophy.md), applied to client middleware
// instead of routing/type-IR. Fractal's own built-in extensions
// (extensions/retry.ts, extensions/timeout.ts, extensions/interceptors.ts)
// are ordinary `ClientExtension` values — there is no privileged internal
// API a user-authored extension can't also use.
//
// Deliberately NOT a fixed hook enum (separate beforeRequest/afterResponse/
// onError callback slots): that would force every extension to implement
// every slot, and would force composition order to be "run all `before`
// hooks, then fetch once, then run all `after` hooks" — which can't express
// retry (needs to re-run the ENTIRE inner fetch, arbitrarily many times, not
// just observe around a single call). Instead an extension wraps the
// underlying fetch, the same middleware shape `layers.ts`'s
// `autoMethodLayer`/`corsLayer` already use on the server side. A
// beforeRequest/afterResponse interceptor is the degenerate case of a
// wrapper that calls `inner` exactly once — see extensions/interceptors.ts.
//
// Composition order: `extensions[0]` is the OUTERMOST wrapper. Reading
// `extensions: [retry(), interceptors()]` top-to-bottom names outer-to-inner
// (retry sees interceptors' effects on every attempt), matching the reading
// order a user would expect and mirroring `layers.ts`'s wrap direction.
//
// See:
//   packages/http-api-projector/src/client.ts   — runtime client; ClientOptions.extensions
//   packages/http-api-projector/src/codegen.ts  — codegen; CodegenOptions.extensions
//   packages/http-api-projector/src/layers.ts   — the server-side analogue this mirrors

/** A fetch-shaped function: takes a `Request`, returns a `Response`. */
export type FetchImpl = (req: Request) => Promise<Response>

/**
 * Codegen-side interpreter contribution: how an extension modifies the
 * emitted source. `wrap` receives a source-level EXPRESSION that evaluates
 * to the current fetch-impl value and must return a new expression wrapping
 * it (e.g. `` `__withRetry(${innerExpr}, {"maxRetries":3})` ``) — the
 * source-text analogue of `wrapFetch`. `helpers` (optional) is a block of
 * top-level declarations (functions/types) the `wrap` expression depends on;
 * emitted once per distinct extension, deduplicated by exact string content.
 */
export type ClientExtensionCodegen = {
  readonly wrap: (innerExpr: string) => string
  readonly helpers?: string
}

/**
 * An extension to the HTTP client, usable by both `createClient`/
 * `createClientFromRoute` (runtime, via `wrapFetch`) and `generateClient`/
 * `generateClientFromNode` (codegen, via `codegen`). Either hook is
 * optional — an extension that only makes sense at runtime (e.g. one
 * capturing live metrics) can omit `codegen`; the codegen path skips it
 * silently, same as an interpreter that doesn't recognize a DU variant.
 */
export type ClientExtension = {
  /** Identifies the extension in error messages / debugging. Not required to be unique. */
  readonly name: string
  /** Runtime interpreter: wraps the fetch implementation the client calls. */
  readonly wrapFetch?: (inner: FetchImpl) => FetchImpl
  /** Codegen interpreter: contributes to the emitted client source. */
  readonly codegen?: ClientExtensionCodegen
}

// ============================================================================
// Runtime interpreter
// ============================================================================

/**
 * Compose a list of extensions' `wrapFetch` hooks around a base
 * `FetchImpl`, outermost-first (see module doc). Extensions without a
 * `wrapFetch` are skipped. Returns `fetchImpl` unchanged when `extensions`
 * is empty or undefined — no wrapper overhead when no extensions are used.
 */
export function composeFetch(fetchImpl: FetchImpl, extensions: readonly ClientExtension[] | undefined): FetchImpl {
  if (extensions === undefined || extensions.length === 0) return fetchImpl
  return extensions.reduceRight((inner, ext) => ext.wrapFetch?.(inner) ?? inner, fetchImpl)
}

// ============================================================================
// Codegen interpreter
// ============================================================================

/**
 * Compose a list of extensions' `codegen.wrap` hooks around a base source
 * expression, outermost-first (see module doc). Extensions without a
 * `codegen` hook are skipped (they only affect the runtime client). Returns
 * `innerExpr` unchanged (and no helpers) when `extensions` is empty or
 * undefined — codegen output is byte-for-byte unchanged from the
 * no-extensions case.
 */
export function composeCodegenFetch(
  innerExpr: string,
  extensions: readonly ClientExtension[] | undefined,
): { readonly expr: string; readonly helpers: readonly string[] } {
  if (extensions === undefined || extensions.length === 0) return { expr: innerExpr, helpers: [] }
  const helperSet = new Set<string>()
  const expr = extensions.reduceRight((inner, ext) => {
    if (ext.codegen === undefined) return inner
    if (ext.codegen.helpers !== undefined) helperSet.add(ext.codegen.helpers)
    return ext.codegen.wrap(inner)
  }, innerExpr)
  return { expr, helpers: [...helperSet] }
}
