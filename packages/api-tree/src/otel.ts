// packages/api-tree/src/otel.ts — @rhi-zone/fractal-api-tree/otel
//
// OpenTelemetry-COMPATIBLE tracing integration, kept dependency-free: this
// module defines structural mirrors of the handful of `@opentelemetry/api`
// interfaces the framework's tracing wiring actually calls (`Tracer`/`Span`/
// `SpanContext`/`SpanStatusCode`/`SpanKind`) instead of importing the real
// package. A consumer who DOES have `@opentelemetry/api` installed can pass
// its real `Tracer` (from `trace.getTracer(name)`) straight into
// `TracingIntegration.tracer` with no adapter — TypeScript's structural
// typing makes the real type assignable wherever these narrower interfaces
// are expected, same trick `context.ts`'s `CliContextShape`/`McpContextShape`
// use for the per-projector ALS context shapes. A consumer with NO real OTel
// SDK can hand-write a minimal object satisfying the same shape (a console
// exporter, a test double, …) — tracing here is opt-in and SDK-agnostic.
//
// Two pieces:
//   1. Types + W3C traceparent parse/format — protocol-neutral, no ALS.
//   2. `wrapTracing` — wires a span around every leaf handler's invocation,
//      the SAME mechanism `build.ts`'s `wrapValidators` uses to wire
//      generated validators onto a `Node` tree: walk once, wrap each leaf's
//      `handler`, before any protocol-specific projection runs. Covers HTTP,
//      CLI, MCP, and GraphQL with one implementation because all four
//      dispatch off (or project from) the same `Node` tree — see
//      `build.ts`'s module doc for why this level, not any one projector's
//      own middleware hook, is where a protocol-neutral cross-cutting
//      concern belongs.
//
// HTTP is the one surface with something MORE to do than any tree-wrap could
// give it: an incoming request carries real W3C `traceparent`/`tracestate`
// headers, and a response carries a real status code — neither is visible at
// the `Handler` level (`(input) => output`, no `Request`/`Response` in
// sight). `http-api-projector/src/extensions/tracing.ts` (client side) and
// its server-side counterpart in `http-api-projector/src/layers.ts` (not
// this package — protocol-specific) build directly on the types/helpers
// exported here (`parseTraceParent`/`formatTraceParent`/`runServerSpan`/
// `runClientSpan`/`getActiveSpan`) instead of duplicating them.

import { AsyncLocalStorage } from "node:async_hooks"
import type { Handler, Node } from "./node.ts"

// ============================================================================
// OTel-compatible types — structural mirrors of @opentelemetry/api
// ============================================================================

/** Mirrors @opentelemetry/api's `SpanAttributeValue`. */
export type OtelAttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[]

/** Mirrors @opentelemetry/api's `Attributes`. */
export type OtelAttributes = Record<string, OtelAttributeValue>

/** Mirrors @opentelemetry/api's `SpanStatusCode` enum values (structurally — a `const` object, not a TS `enum`, so no runtime dependency on the real package's enum object). */
export const OtelSpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 } as const
export type OtelSpanStatusCode = (typeof OtelSpanStatusCode)[keyof typeof OtelSpanStatusCode]

/** Mirrors @opentelemetry/api's `SpanKind` enum values. */
export const OtelSpanKind = { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 } as const
export type OtelSpanKind = (typeof OtelSpanKind)[keyof typeof OtelSpanKind]

/** Mirrors @opentelemetry/api's `SpanStatus`. */
export type OtelSpanStatus = {
  readonly code: OtelSpanStatusCode
  readonly message?: string
}

/**
 * W3C trace-context identifiers for one span. Mirrors @opentelemetry/api's
 * `SpanContext` — `traceId`/`spanId` are lowercase hex (32/16 chars),
 * `traceFlags` the single-byte flags field (bit 0 = sampled), matching the
 * `traceparent` header's own encoding (see `parseTraceParent`/
 * `formatTraceParent` below).
 */
export type OtelSpanContext = {
  readonly traceId: string
  readonly spanId: string
  readonly traceFlags: number
  readonly traceState?: string
  readonly isRemote?: boolean
}

export type OtelSpanOptions = {
  readonly kind?: OtelSpanKind
  readonly attributes?: OtelAttributes
}

/**
 * Structural mirror of @opentelemetry/api's `Span` — only the members this
 * package's own wiring calls. A real `Span` has more (events, links,
 * `updateName`, …); a real `Span` is still assignable here, and a hand-
 * written test double only needs to implement this subset.
 */
export interface OtelSpan {
  spanContext(): OtelSpanContext
  setAttribute(key: string, value: OtelAttributeValue): unknown
  setAttributes(attributes: OtelAttributes): unknown
  setStatus(status: OtelSpanStatus): unknown
  recordException(exception: unknown): unknown
  end(): void
  isRecording?(): boolean
}

/**
 * Structural mirror of @opentelemetry/api's `Tracer` — only `startSpan` and
 * the single- and options-taking `startActiveSpan` overloads. Deliberately
 * OMITS the real `Tracer`'s `context`-taking overload: this package never
 * constructs a real OTel `Context` object (that lives in `@opentelemetry/api`
 * itself, which this package doesn't depend on) — see `TracingIntegration`'s
 * `contextFromTraceParent` for how a consumer who DOES have the real SDK
 * bridges an extracted remote `SpanContext` into their own `Context` without
 * this package needing to know that type at all.
 *
 * `startActiveSpan` (not just `startSpan`) is the hook `runServerSpan`/
 * `runClientSpan` (below) build on: for a real OTel SDK it makes the started
 * span "active" via the SDK's OWN context manager (usually
 * `@opentelemetry/context-async-hooks`'s `AsyncHooksContextManager`) — so a
 * span started deeper in the call stack, inside `fn`, via `tracer.startSpan`
 * with no explicit context, correctly nests under it with zero extra wiring
 * from this package. This package's own `getActiveSpan()`/ALS (below) is a
 * SEPARATE, always-available fallback for the same "what span is active"
 * question, for consumers with a minimal tracer that has no context-manager
 * story of its own.
 */
export interface OtelTracer {
  startSpan(name: string, options?: OtelSpanOptions): OtelSpan
  startActiveSpan<T>(name: string, fn: (span: OtelSpan) => T): T
  startActiveSpan<T>(name: string, options: OtelSpanOptions, fn: (span: OtelSpan) => T): T
}

/**
 * Everything a projector's tracing wiring needs from a consumer, opt-in.
 * `tracer` is the only required field — pass a real `@opentelemetry/api`
 * `Tracer` (`trace.getTracer(name)`) or a hand-written compatible object.
 *
 * `contextFromTraceParent`, optional, bridges an extracted remote
 * `OtelSpanContext` (from an incoming request's `traceparent` header — see
 * `parseTraceParent`) into whatever the real SDK needs to parent a new span
 * under it — e.g. `(remote) => trace.setSpanContext(context.active(), remote)`
 * with `@opentelemetry/api`'s own `trace`/`context` imports, entirely on the
 * consumer's side (this package never imports `@opentelemetry/api`, so it
 * cannot build that `Context` value itself). Without it, an incoming remote
 * trace context is parsed and exposed (`getIncomingTraceContext`) but not
 * used to parent the new span — every server span starts as its own root,
 * still fully functional, just not linked to the caller's trace.
 */
export type TracingIntegration = {
  readonly tracer: OtelTracer
  readonly contextFromTraceParent?: (remote: OtelSpanContext) => void
}

// ============================================================================
// W3C Trace Context — https://www.w3.org/TR/trace-context/#traceparent-header
// ============================================================================

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i
const ALL_ZERO_TRACE_ID = "0".repeat(32)
const ALL_ZERO_SPAN_ID = "0".repeat(16)

/**
 * Parse a `traceparent` header value into an `OtelSpanContext`. Returns
 * `undefined` for a missing/malformed header, an invalid version (`"ff"` is
 * reserved by spec), or an all-zero trace-id/span-id (spec-invalid, and the
 * conventional "no trace context" sentinel) — same undefined-means-absent
 * convention used throughout this codebase (e.g. `extension.ts`'s
 * `decodeResponse`).
 */
export function parseTraceParent(header: string | null | undefined): OtelSpanContext | undefined {
  if (header == null) return undefined
  const match = TRACEPARENT_RE.exec(header.trim())
  if (match === null) return undefined
  const [, version, traceId, spanId, flags] = match as unknown as [string, string, string, string, string]
  if (version.toLowerCase() === "ff") return undefined
  const lowerTraceId = traceId.toLowerCase()
  const lowerSpanId = spanId.toLowerCase()
  if (lowerTraceId === ALL_ZERO_TRACE_ID || lowerSpanId === ALL_ZERO_SPAN_ID) return undefined
  return {
    traceId: lowerTraceId,
    spanId: lowerSpanId,
    traceFlags: Number.parseInt(flags, 16),
    isRemote: true,
  }
}

/** Format an `OtelSpanContext` as a `traceparent` header value (version `"00"`, per spec). */
export function formatTraceParent(ctx: OtelSpanContext): string {
  const flags = (ctx.traceFlags & 0xff).toString(16).padStart(2, "0")
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`
}

// ============================================================================
// Active-span ALS — this package's OWN "what span is active" tracking,
// independent of whatever context-propagation story (or lack of one) the
// consumer's real tracer has. Populated by `runServerSpan`/`runClientSpan`
// (below); read via `getActiveSpan()` by any downstream code (a leaf
// handler, an extension) that wants to start a child span.
// ============================================================================

const activeSpanStorage = new AsyncLocalStorage<OtelSpan>()

/** The span `runServerSpan`/`runClientSpan` currently has active, or `undefined` outside any of them. */
export function getActiveSpan(): OtelSpan | undefined {
  return activeSpanStorage.getStore()
}

function recordFailure(span: OtelSpan, error: unknown): void {
  span.recordException(error)
  span.setStatus({
    code: OtelSpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  })
}

/**
 * Run `fn` inside a new span named `name` — sync or async, either way
 * ending the span exactly once, with `OK`/`ERROR` status set from whether
 * `fn` threw (sync) or its returned promise rejected (async), and
 * `getActiveSpan()` returning this span for the duration. Shared by
 * `runServerSpan` and `runClientSpan` below; the only difference between
 * them is `SpanKind` and whether an incoming remote trace context is
 * consulted.
 */
function runSpan<T>(
  tracer: OtelTracer,
  name: string,
  options: OtelSpanOptions,
  fn: (span: OtelSpan) => T | Promise<T>,
): T | Promise<T> {
  return tracer.startActiveSpan(name, options, (span) =>
    activeSpanStorage.run(span, () => {
      let result: T | Promise<T>
      try {
        result = fn(span)
      } catch (error) {
        recordFailure(span, error)
        span.end()
        throw error
      }
      if (result instanceof Promise) {
        return result.then(
          (value) => {
            span.setStatus({ code: OtelSpanStatusCode.OK })
            span.end()
            return value
          },
          (error: unknown) => {
            recordFailure(span, error)
            span.end()
            throw error
          },
        ) as Promise<T>
      }
      span.setStatus({ code: OtelSpanStatusCode.OK })
      span.end()
      return result
    }),
  )
}

/**
 * Start a SERVER-kind span for one handler invocation, optionally parented
 * to an incoming request's extracted remote trace context (see
 * `TracingIntegration.contextFromTraceParent`), and run `fn` inside it. Ends
 * the span and sets its status from `fn`'s outcome (see `runSpan`).
 */
export function runServerSpan<T>(
  integration: TracingIntegration,
  name: string,
  attributes: OtelAttributes,
  incomingTraceParent: OtelSpanContext | undefined,
  fn: (span: OtelSpan) => T | Promise<T>,
): T | Promise<T> {
  if (incomingTraceParent !== undefined) integration.contextFromTraceParent?.(incomingTraceParent)
  return runSpan(integration.tracer, name, { kind: OtelSpanKind.SERVER, attributes }, fn)
}

/** Start a CLIENT-kind span for one outgoing call and run `fn` inside it. Ends the span and sets its status from `fn`'s outcome (see `runSpan`). */
export function runClientSpan<T>(
  integration: TracingIntegration,
  name: string,
  attributes: OtelAttributes,
  fn: (span: OtelSpan) => T | Promise<T>,
): T | Promise<T> {
  return runSpan(integration.tracer, name, { kind: OtelSpanKind.CLIENT, attributes }, fn)
}

// ============================================================================
// wrapTracing — wires a SERVER span around every leaf handler's invocation.
// Mirrors build.ts's `wrapValidators` exactly (see that module's doc for why
// this belongs at the `Node` level): walk once, wrap each leaf's `handler`,
// never mutate `node`, always return a fresh tree. A leaf with `handler ===
// undefined` (a branch) passes through untouched.
// ============================================================================

/**
 * Wrap one leaf handler so its invocation runs inside its own server span —
 * name `${projectorType}:${path.join("/")}` (or just the joined path when
 * `projectorType` is omitted), attributes `operation.name` (joined path) and
 * `projector.type` (when given). Path segments follow the same convention
 * `build.ts`'s `wrapValidators` uses (a `fallback` segment renders as
 * `:name`), so span names for the same tree are consistent across whichever
 * of `wrapValidators`/`wrapTracing` a caller also uses.
 */
function wrapHandler(
  handler: Handler,
  integration: TracingIntegration,
  path: readonly string[],
  projectorType: string | undefined,
): Handler {
  const operationName = path.join("/")
  const spanName = projectorType !== undefined ? `${projectorType}:${operationName}` : operationName
  const attributes: OtelAttributes = {
    "operation.name": operationName,
    ...(projectorType !== undefined ? { "projector.type": projectorType } : {}),
  }
  return (input: unknown) =>
    runServerSpan(integration, spanName, attributes, undefined, () => handler(input))
}

export type WrapTracingOptions = {
  /**
   * Tagged onto every span's `projector.type` attribute and its name prefix
   * (e.g. `"http"`, `"cli"`, `"mcp"`, `"graphql"`) — pass the same tree
   * through `wrapTracing` once per projector it's handed to (mirroring
   * `wrapValidators`'s own per-projector `validators` call sites) so each
   * surface's spans are distinguishable. Omit to leave both unset.
   */
  readonly projectorType?: string
}

/**
 * Walk `node`, wiring each leaf's handler through `runServerSpan` — see the
 * module doc above for why this lives at the `Node` level rather than on
 * any one protocol's own middleware hook. Call once per projector a given
 * tree is handed to (each with its own `WrapTracingOptions.projectorType`),
 * BEFORE any protocol-specific projection runs — same call-site convention
 * `wrapValidators` already established:
 *
 * ```ts
 * const traced = wrapTracing(tree, { tracer }, { projectorType: "http" })
 * createFetch(traced, opts)
 * ```
 *
 * Never mutates `node`; always returns a fresh tree.
 */
export function wrapTracing(
  node: Node,
  integration: TracingIntegration,
  options: WrapTracingOptions = {},
  path: readonly string[] = [],
): Node {
  const handler = node.handler !== undefined
    ? wrapHandler(node.handler, integration, path, options.projectorType)
    : undefined
  const children = node.children !== undefined
    ? Object.fromEntries(
        Object.entries(node.children).map(([key, child]) => [
          key,
          wrapTracing(child, integration, options, [...path, key]),
        ]),
      )
    : undefined
  const fallback = node.fallback !== undefined
    ? {
        name: node.fallback.name,
        subtree: wrapTracing(node.fallback.subtree, integration, options, [...path, `:${node.fallback.name}`]),
      }
    : undefined
  return {
    ...(handler !== undefined ? { handler } : {}),
    ...(children !== undefined ? { children } : {}),
    ...(fallback !== undefined ? { fallback } : {}),
    meta: node.meta,
  }
}
