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

import type { Meta } from "@rhi-zone/fractal-api-tree/node"
import type { JsonSchema } from "@rhi-zone/fractal-api-tree/extract"

/** A fetch-shaped function: takes a `Request`, returns a `Response`. */
export type FetchImpl = (req: Request) => Promise<Response>

/**
 * Context handed to `decodeResponse` alongside the raw `Response` — the
 * original `Request` that produced it, a `refetch` hook to issue FURTHER
 * requests through the same composed fetch pipeline (retry/timeout/etc.
 * still apply), and the leaf's own resolved `meta` (its `HttpRoute` method
 * entry's `meta` — the same bag `op(fn, ...)` accumulated, see node.ts).
 *
 * `refetch` is what lets an extension whose decoded value needs MORE than
 * one HTTP round-trip (e.g. `pagination()`'s auto-advance to the next page,
 * see extensions/pagination.ts) build and issue a follow-up `Request` later
 * — lazily, from inside the value it hands back — instead of every
 * `decodeResponse` call being limited to the single `res` already in hand
 * (which is all `streaming()`, the first consumer of this hook, ever
 * needed).
 */
export type DecodeContext = {
  readonly request: Request
  readonly refetch: FetchImpl
  readonly meta: Meta
  /**
   * The `SchemaMap` key identifying this operation (e.g. `"books_bookId_read"`
   * — see `@rhi-zone/fractal-api-tree/tree`'s `extractToolSchemas`), when the
   * client was built with enough information to recover it. Only
   * `createClient(node, ...)` can (it walks the raw `Node` tree once, same
   * trick `buildHandlerNames` already uses for member names — see
   * `client.ts`'s `buildCodegenNameMap`); `createClientFromRoute` has no
   * `Node` to derive it from, so this is `undefined` there — same degradation
   * already documented for co-located member names. Lets an extension (e.g.
   * `extensions/validation.ts`) look up this operation's own entry in a
   * `SchemaMap` without re-deriving tree-position naming itself.
   */
  readonly codegenName?: string | undefined
}

/**
 * Codegen-side interpreter contribution: how an extension modifies the
 * emitted source. `wrap` receives a source-level EXPRESSION that evaluates
 * to the current fetch-impl value and must return a new expression wrapping
 * it (e.g. `` `__withRetry(${innerExpr}, {"maxRetries":3})` ``) — the
 * source-text analogue of `wrapFetch`. Optional: a codegen contribution that
 * only cares about `streamingCall` (see below) has nothing to wrap.
 * `helpers` (optional) is a block of top-level declarations (functions/
 * types) either hook depends on; emitted once per distinct extension,
 * deduplicated by exact string content.
 *
 * `streamingCall` (optional) is a SEPARATE axis from `wrap`: it doesn't wrap
 * the fetch call, it replaces the entire generated OPERATION body for
 * operations whose output schema is tagged `x-stream` (see
 * `@rhi-zone/fractal-type-ir`'s `toJsonSchema`) — the streaming shape needs
 * a synchronously-returned `AsyncIterable`, not a `Promise` wrapping one
 * more `fetch` call, so it can't be expressed as a wrapper around
 * `__request`'s existing expression the way `wrap` is. See
 * `extensions/streaming.ts` for the one extension that implements it.
 */
export type ClientExtensionCodegen = {
  readonly wrap?: (innerExpr: string) => string
  readonly helpers?: string
  readonly streamingCall?: (args: StreamingCallArgs) => string
  /**
   * Wraps the expression for ONE operation's decoded result — the per-
   * operation analogue of `wrap` (which wraps the fetch impl once for the
   * whole client). `innerExpr` evaluates to `Promise<unknown>` (the
   * operation's `__request(...)` call, or an earlier extension's own
   * `wrapResult`); `codegenName` is the same `SchemaMap`-key naming
   * `attachOperation` already resolved for this operation (see
   * `OperationEntry.codegenName`), letting an extension look up its own
   * per-operation constant (emitted via `resultHelpers` below) by name. E.g.
   * `extensions/validation.ts` turns `__request(...)` into
   * `__request(...).then((v) => __validate(v, __SCHEMA_books_bookId_read, "throw"))`.
   * Optional: most extensions (retry, timeout, errors) only need `wrap`.
   */
  readonly wrapResult?: (innerExpr: string, codegenName: string) => string
  /**
   * Emits helper declarations that need the FULL list of operations up
   * front — e.g. one schema constant per operation — computed once codegen
   * has walked the whole tree, unlike `helpers` (emitted with no knowledge
   * of operations at all) or `wrapResult` (one operation at a time).
   * `undefined` when this extension has nothing to emit (e.g. no operation
   * has an output schema to validate).
   */
  readonly resultHelpers?: (operations: readonly CodegenOperationInfo[]) => string | undefined
}

/**
 * Per-operation facts codegen has already resolved by the time result-
 * shaping runs (`render`'s `entries`, via `attachOperation`) — handed to
 * `ClientExtensionCodegen.resultHelpers` so an extension can emit one
 * constant per operation without re-deriving codegen names/schemas itself.
 */
export type CodegenOperationInfo = {
  readonly codegenName: string
  readonly responseSchema?: JsonSchema
}

/**
 * Inputs `ClientExtensionCodegen.streamingCall` needs to emit a call
 * expression for one streaming operation — the same facts `codegen.ts`'s
 * `nodeRuntimeLiteral` already has in scope for the non-streaming
 * `__request(...)` call, passed across the extension boundary as source-text
 * expressions/literals rather than live values (codegen has no live values,
 * only the source it's building).
 */
export type StreamingCallArgs = {
  /** Expression evaluating to the client's base URL (e.g. `"baseUrl"`). */
  readonly baseUrlExpr: string
  /** Expression evaluating to the composed fetch impl (e.g. `"fetchImpl"`). */
  readonly fetchExpr: string
  /** Expression evaluating to the base headers record, if any (e.g. `"headers"`). */
  readonly headersExpr: string
  /** Uppercase HTTP verb, e.g. `"GET"`. */
  readonly method: string
  /** Template-literal BODY (no surrounding backticks) for the request path, e.g. `` /books/${encodeURIComponent(bookId)} ``. */
  readonly pathLiteral: string
  /** Expression evaluating to the request input, or `"undefined"` when the operation takes none. */
  readonly inputExpr: string
  /** Expression evaluating to the client's base timeout, if any. */
  readonly baseTimeoutExpr: string
  /** Expression evaluating to the client's base abort signal, if any. */
  readonly baseSignalExpr: string
  /** Expression evaluating to this call's per-call `CallOptions`, if any. */
  readonly callOptsExpr: string
}

/**
 * Result of a runtime response decoder (see `ClientExtension.decodeResponse`
 * below): `{ value }` when the extension fully decoded `res` itself.
 * A dedicated wrapper (rather than returning `value | undefined` directly)
 * because `undefined` is itself a legitimate decoded value (e.g. an SSE
 * stream's `event: done` frame with no payload) — same reasoning
 * `isStreamEffect`'s `kind`-tag check documents for not letting a
 * legitimate value collide with the "not handled" signal.
 */
export type DecodedResponse = { readonly value: unknown }

/**
 * An extension to the HTTP client, usable by both `createClient`/
 * `createClientFromRoute` (runtime, via `wrapFetch`/`decodeResponse`) and
 * `generateClient`/`generateClientFromNode` (codegen, via `codegen`). Every
 * hook is optional — an extension that only makes sense at runtime (e.g. one
 * capturing live metrics) can omit `codegen`; the codegen path skips it
 * silently, same as an interpreter that doesn't recognize a DU variant.
 */
export type ClientExtension = {
  /** Identifies the extension in error messages / debugging. Not required to be unique. */
  readonly name: string
  /** Runtime interpreter: wraps the fetch implementation the client calls. */
  readonly wrapFetch?: (inner: FetchImpl) => FetchImpl
  /**
   * Runtime interpreter: decodes a raw `Response` BEFORE the client's
   * default JSON/text body decode (`client.ts`'s `makeCaller`) runs. Returns
   * `{ value }` to fully own decoding this response — skipping BOTH the
   * default decode and the default `res.ok` → `ClientError` check (e.g. an
   * SSE stream response is always `200 OK` at the HTTP layer; a failed
   * stream reports through the returned `AsyncIterable` itself, not the
   * initial response status) — or `undefined` to decline, falling through
   * to the next extension's `decodeResponse` (composition order: same as
   * `wrapFetch`, first-listed tried first) or, if none claim it, the
   * client's default decode. Mirrors `@rhi-zone/fractal-api-tree`'s
   * `ErrorEncoder`/`composeErrorEncoders` undefined-means-fall-through
   * convention, applied to response decoding instead of error mapping.
   *
   * `ctx` (`DecodeContext`, above) is the second parameter — existing
   * extensions written against the original single-argument shape (e.g.
   * `streaming()`) stay valid unchanged, since a function declared with
   * fewer parameters than a call site passes is ordinary, safe JS/TS.
   */
  readonly decodeResponse?: (res: Response, ctx: DecodeContext) => DecodedResponse | undefined
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

/**
 * Try each extension's `decodeResponse` in order (same order as
 * `wrapFetch`/`composeFetch` — first-listed tried first), returning the
 * first `{ value }` result. `undefined` when no extension's
 * `decodeResponse` claims `res` (including when `extensions` is empty/
 * undefined), signaling the caller (`client.ts`'s `makeCaller`) to run its
 * own default JSON/text decode.
 */
export function composeDecodeResponse(
  res: Response,
  ctx: DecodeContext,
  extensions: readonly ClientExtension[] | undefined,
): DecodedResponse | undefined {
  if (extensions === undefined) return undefined
  for (const ext of extensions) {
    const result = ext.decodeResponse?.(res, ctx)
    if (result !== undefined) return result
  }
  return undefined
}

/**
 * Find the first extension in `extensions` contributing a `streamingCall`
 * (see `ClientExtensionCodegen`) — codegen only needs one, since it's a
 * static per-operation emission decision, not a composable wrapper chain
 * like `wrap`/`decodeResponse`. `undefined` when none does (including when
 * `extensions` is empty/undefined), signaling `codegen.ts` to emit every
 * operation as a plain `Promise<T>`-returning `__request(...)` call, even
 * one whose output schema is tagged `x-stream`.
 */
export function findStreamingCall(
  extensions: readonly ClientExtension[] | undefined,
): ((args: StreamingCallArgs) => string) | undefined {
  if (extensions === undefined) return undefined
  for (const ext of extensions) {
    const call = ext.codegen?.streamingCall
    if (call !== undefined) return call
  }
  return undefined
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
    return ext.codegen.wrap?.(inner) ?? inner
  }, innerExpr)
  return { expr, helpers: [...helperSet] }
}

/**
 * Compose a list of extensions' `codegen.wrapResult` hooks around ONE
 * operation's result expression, outermost-first (same order as
 * `composeCodegenFetch`). Extensions without `wrapResult` are skipped.
 * Returns `innerExpr` unchanged when `extensions` is empty or undefined.
 */
export function composeCodegenResult(
  innerExpr: string,
  codegenName: string,
  extensions: readonly ClientExtension[] | undefined,
): string {
  if (extensions === undefined || extensions.length === 0) return innerExpr
  return extensions.reduceRight((inner, ext) => ext.codegen?.wrapResult?.(inner, codegenName) ?? inner, innerExpr)
}

/**
 * Collect every extension's `codegen.resultHelpers` output (given the full
 * operation list), deduplicated in encounter order. `[]` when no extension
 * contributes any (including when `extensions` is empty/undefined).
 */
export function collectResultHelpers(
  operations: readonly CodegenOperationInfo[],
  extensions: readonly ClientExtension[] | undefined,
): readonly string[] {
  if (extensions === undefined) return []
  const out: string[] = []
  for (const ext of extensions) {
    const helper = ext.codegen?.resultHelpers?.(operations)
    if (helper !== undefined) out.push(helper)
  }
  return out
}
