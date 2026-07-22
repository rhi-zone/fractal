// packages/api-tree/src/index.ts — @rhi-zone/fractal-api-tree
//
// The function-core model base:
//   - The function category: plain functions `A => B` composed with compose/pipe.
//   - Result<T, E> — the fallible-value type — plus map/bind/match fold.
//   - Derived combinators: composeK (Kleisli) and collect (applicative record).
//
// Protocol-neutral routing (the former D-tree / path/param/group/methods/route)
// has been retired to the new Node/Op/Meta model in ./node.ts.
// Schema validators (str/num/bool/obj) are retired; use a real validation
// library (Standard Schema compatible) from the host instead.

// `api()` — the primary authoring-surface constructor — is re-exported
// here so it's reachable from the package root, alongside
// the rest of the Node/Op/Meta model which stays on "./node.ts" until the
// two modules are merged.
export { api, mergeMeta, op } from "./node.ts"

// `createDirectApi` — the zero-protocol-overhead projection: a nested proxy
// that calls tree handlers in-process (no HTTP, no serialization). See
// "./direct.ts" for the full doc.
export { createDirectApi } from "./direct.ts"
export type { AnyApi, DirectApi } from "./direct.ts"

// `TypedClient` — the remote-client analogue of `DirectApi`, parameterized
// over a projector-supplied `CallOpts` type for per-call transport options
// (e.g. HTTP's `{ timeout, signal }`). Lives here (not in
// http-api-projector) so it stays projector-agnostic — see "./typed-client.ts".
export type { TypedClient } from "./typed-client.ts"

// `TreeManifest` — flattens a Node tree into a map of dot-separated paths to
// each leaf's `{ input; output }` contract. Sibling to `TypedClient` above,
// but discards nesting entirely instead of preserving it — see
// "./tree-manifest.ts" for the full doc, including why an HTTP-specific
// manifest isn't implemented here.
export type { TreeManifest } from "./tree-manifest.ts"

// Page<T> — the pagination convention (CursorPage/OffsetPage/Page + runtime
// shape checks), sibling to StreamEffect<T> below. See "./page.ts" for the
// full doc.
export type { CursorPage, OffsetPage, Page } from "./page.ts"
export { isCursorPage, isOffsetPage, isPageShape } from "./page.ts"

// The input-source resolution mechanism — stores, sourceMap, and the
// assembler that resolves each handler param to a store + key. Extracted
// from the HTTP projector so CLI, MCP, and any future projector can share
// one pipeline instead of reimplementing it. Callers that need to report
// where a param came from consult the sourceMap directly — see "./input.ts"
// for the full doc.
export { assemble } from "./input.ts"
export type { ParamSource, SourceMap, Store, StoreRegistry, Stores } from "./input.ts"

// Dev tooling — the build-time extractor (extract.ts, TS source -> TypeRef)
// and the source-level api()/op() tree walker (tree.ts) it feeds — lives on
// "./extract" and "./tree" subpaths, NOT the package root: they pull in the
// TypeScript compiler, which the base runtime model has no reason to force
// on every consumer. The `fractal-api-tree` build/watch/stub/check CLI
// (cli.ts) wires them to @rhi-zone/fractal-type-ir's validator codegen.

// ============================================================================
// The function category — the base
// ============================================================================

export type Fn<A, B> = (a: A) => B;

/** Ordinary function composition: `compose(f)(g)` is `a => g(f(a))`. */
export const compose =
  <A, B>(f: Fn<A, B>) =>
  <C>(g: Fn<B, C>): Fn<A, C> =>
  (a) =>
    g(f(a));

/** Left-to-right value threading: `pipe(a, f, g)` is `g(f(a))`. */
export function pipe<A>(a: A): A;
export function pipe<A, B>(a: A, f: Fn<A, B>): B;
export function pipe<A, B, C>(a: A, f: Fn<A, B>, g: Fn<B, C>): C;
export function pipe<A, B, C, D>(
  a: A,
  f: Fn<A, B>,
  g: Fn<B, C>,
  h: Fn<C, D>,
): D;
export function pipe(a: unknown, ...fns: Fn<unknown, unknown>[]): unknown {
  return fns.reduce((acc, fn) => fn(acc), a);
}

// ============================================================================
// Result<T, E> — the fallible-value type
// ============================================================================

export type Result<T, E> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "err"; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ kind: "ok", value });
export const err = <E>(error: E): Result<never, E> => ({ kind: "err", error });

export const isOk = <T, E>(
  r: Result<T, E>,
): r is { kind: "ok"; value: T } => r.kind === "ok";
export const isErr = <T, E>(
  r: Result<T, E>,
): r is { kind: "err"; error: E } => r.kind === "err";

/**
 * Loose structural check: true when `v` matches the `Result` DU's shape at
 * runtime — `{kind:"ok",value}` or `{kind:"err",error}` — without requiring
 * its static type to already be known as `Result<T, E>`. For a dispatcher
 * that calls an erased `Handler` (return type widened to `any`/`unknown` —
 * e.g. after `wrapValidators` wraps it) and needs to tell whether the
 * returned value IS a `Result` before it can narrow with `isOk`/`isErr`.
 * Exact on `kind` (only `"ok"`/`"err"` match) so user data with an unrelated
 * `kind` field never false-positives.
 */
export function isResultShape(
  v: unknown,
): v is { kind: "ok"; value: unknown } | { kind: "err"; error: unknown } {
  if (typeof v !== "object" || v === null || !("kind" in v)) return false;
  const kind = (v as { kind: unknown }).kind;
  return kind === "ok" || kind === "err";
}

/** Map the success value; pass an error through untouched. */
export const map = <T, E, U>(r: Result<T, E>, f: (t: T) => U): Result<U, E> =>
  r.kind === "ok" ? ok(f(r.value)) : r;

/** Monadic bind: run `f` on the success value, short-circuit on error. The
 *  primitive Kleisli composition is built from. */
export const bind = <T, E, U>(
  r: Result<T, E>,
  f: (t: T) => Result<U, E>,
): Result<U, E> => (r.kind === "ok" ? f(r.value) : r);

/** Fold a Result into a single value by matching both arms. The final encode
 *  stage `Result<T, E> => Response` is exactly `match(r, { ok, err })`. */
export const match = <T, E, R>(
  r: Result<T, E>,
  arms: { ok: (t: T) => R; err: (e: E) => R },
): R => (r.kind === "ok" ? arms.ok(r.value) : arms.err(r.error));

// ============================================================================
// StreamEffect<T> — tagged values an async-generator handler can yield
// ============================================================================

/**
 * Progress effect: a handler yields this to report incremental progress
 * without emitting a data chunk. Provenance-blind — the same shape is
 * yielded whether the projector will render it as SSE, an MCP
 * `notifications/progress`, or a CLI stderr line; each projector decides how
 * (or whether) to surface it.
 */
export type StreamProgress = {
  readonly kind: "progress";
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
};

/**
 * Chunk effect: a handler yields this to emit one piece of streamed data.
 * `T` defaults to `unknown` because a handler's chunk type is generally
 * inferred from its generator's yield type, not annotated here.
 */
export type StreamChunk<T = unknown> = {
  readonly kind: "chunk";
  readonly data: T;
};

/** Open DU of stream effects — progress and chunk today, extensible by
 *  adding another `kind`-tagged member without touching existing arms. */
export type StreamEffect<T = unknown> = StreamProgress | StreamChunk<T>;

/**
 * Loose structural check: true when `v` matches a recognized `StreamEffect`
 * shape at runtime, mirroring `isResultShape`'s role for `Result`. Exact on
 * `kind` (only `"progress"`/`"chunk"` match) so a handler's own chunk data
 * with an unrelated `kind` field never false-positives — same reasoning as
 * `isResultShape`. Detection is opt-in at the projector-preset level (see
 * `docs/design/middleware-and-caller-context.md`), not automatic sniffing
 * of every yielded value.
 */
export function isStreamEffect(value: unknown): value is StreamEffect {
  if (typeof value !== "object" || value === null || !("kind" in value))
    return false;
  const kind = (value as { kind: unknown }).kind;
  return kind === "progress" || kind === "chunk";
}

// ============================================================================
// DetectionOptions — shared opt-in config for projector return-value sniffing
// ============================================================================

/**
 * Opt-in configuration, shared by every projector preset (HTTP, MCP, CLI),
 * for which return-value protocols get auto-detected on a handler's output.
 * `result` gates `isResultShape` unwrapping; `streaming` gates
 * `AsyncIterable` detection AND interpretation of yielded `StreamEffect`
 * tags (`isStreamProgress`/`isStreamChunk`) — with streaming off, an async
 * iterable is never drained specially, it's just an ordinary return value.
 * Both default to `true` at every call site for backwards compatibility —
 * a consumer opts OUT only when its own data legitimately collides with one
 * of these shapes (see `docs/design/middleware-and-caller-context.md`).
 *
 * `ResponseOverride` (HTTP-only, `packages/http-api-projector/src/route.ts`)
 * is deliberately NOT covered here — it's tagged with a `Symbol`, which is
 * structurally impossible for user data to collide with, so it's always
 * detected.
 */
export type DetectionOptions = {
  readonly result?: boolean;
  readonly streaming?: boolean;
};

/** True when `value` is specifically a `StreamProgress` effect. */
export function isStreamProgress(value: unknown): value is StreamProgress {
  if (typeof value !== "object" || value === null || !("kind" in value))
    return false;
  return (value as { kind: unknown }).kind === "progress";
}

/** True when `value` is specifically a `StreamChunk` effect. */
export function isStreamChunk(value: unknown): value is StreamChunk {
  if (typeof value !== "object" || value === null || !("kind" in value))
    return false;
  return (value as { kind: unknown }).kind === "chunk";
}

// ============================================================================
// ErrorEncoder<E, R> — composable error-to-transport mapping
// ============================================================================

/**
 * Maps a transport-agnostic error value `E` (the `E` in `Result<T, E>`,
 * e.g. `{ kind: "notFound", message: "Book not found" }` — no transport
 * concepts baked in) to a transport-specific response `R` (HTTP status,
 * CLI exit code, MCP error code — see each projector's own
 * `HttpErrorEncoder`/`CliErrorEncoder`/`McpErrorEncoder`). Returns
 * `undefined` when this encoder doesn't recognize `error`, signaling the
 * caller to fall through to the next encoder (`composeErrorEncoders`) or the
 * projector's own default behavior.
 */
export type ErrorEncoder<E, R> = (error: E) => R | undefined

/**
 * Compose several `ErrorEncoder`s into one: tries each in order, returning
 * the first defined result. `undefined` when none matched — the signal for
 * a projector to fall back to its own default error response. The building
 * block every projector's `httpErrors`/`cliErrors`/`mcpErrors` helper
 * assembles internally from per-kind `matchKind` calls.
 */
export function composeErrorEncoders<E, R>(
  ...encoders: ErrorEncoder<E, R>[]
): (error: E) => R | undefined {
  return (error) => {
    for (const encoder of encoders) {
      const result = encoder(error)
      if (result !== undefined) return result
    }
    return undefined
  }
}

/**
 * Matches an error carrying a `kind` field (the open-DU convention this
 * codebase already uses for `Result`/`StreamEffect`/tree meta) equal to
 * `kind`, returning `response` on a match and `undefined` otherwise. `error`
 * is typed `unknown` — an `ErrorEncoder<unknown, R>` composes with any `E`
 * via `composeErrorEncoders`, since the match is a runtime shape check, not
 * a static narrowing of a specific error union.
 */
export function matchKind<R>(kind: string, response: R): ErrorEncoder<unknown, R> {
  return (error) => {
    if (
      error !== null &&
      typeof error === "object" &&
      "kind" in error &&
      (error as { kind: unknown }).kind === kind
    ) {
      return response
    }
    return undefined
  }
}

// ============================================================================
// Derived combinators — Kleisli + applicative. NEVER the base.
// ============================================================================

/** Kleisli composition over Result: `composeK(f)(g) = a => bind(f(a), g)`.
 *  Threads a Result through a fallible chain, short-circuiting on the first
 *  error. Derived from `compose` + `bind`. */
export const composeK =
  <A, B, E>(f: Fn<A, Result<B, E>>) =>
  <C>(g: Fn<B, Result<C, E>>): Fn<A, Result<C, E>> =>
  (a) =>
    bind(f(a), g);

/** The record / applicative combinator. Given a record of field-producers that
 *  each read a common input `I` and yield a `Result`, return one function that
 *  runs them all and collects their outputs into a record — short-circuiting on
 *  the FIRST failure. This is the `buildOptions` mechanism: run each field's
 *  producer, gather the typed values. */
export function collect<
  I,
  E,
  F extends Record<string, (i: I) => Result<unknown, E>>,
>(
  producers: F,
): (
  i: I,
) => Result<
  { [K in keyof F]: F[K] extends (i: I) => Result<infer V, E> ? V : never },
  E
> {
  const keys = Object.keys(producers);
  return (i) => {
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const r = producers[k]!(i);
      if (r.kind === "err") return r as Result<never, E>;
      out[k] = r.value;
    }
    return ok(
      out as {
        [K in keyof F]: F[K] extends (i: I) => Result<infer V, E> ? V : never;
      },
    );
  };
}
