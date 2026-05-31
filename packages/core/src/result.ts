/**
 * Result is the universal handler return. Errors are values, never thrown — so
 * the error union is part of the type and capabilities can widen it statically.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

/** Construct a success Result. */
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })

/** Construct an error Result. */
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

/** A Context carries PRE-OPENED capability handles. Handlers never acquire by name. */
export interface Context<Caps extends Record<string, unknown> = Record<string, unknown>> {
  readonly caps: Caps
  readonly signal?: AbortSignal
}

/**
 * The ONLY code in the tree. Everything else is reflectable structure.
 * A handler maps input + context to a Result, sync or async.
 */
export type Handler<I, O, E, Caps extends Record<string, unknown>> = (
  input: I,
  ctx: Context<Caps>,
) => Result<O, E> | Promise<Result<O, E>>

/**
 * A streaming handler maps input + context to an async stream of Results.
 * Each yielded element is a `Result<O, E>` — so a per-item error widens the
 * SAME element type a capability widens (no separate stream error channel).
 * Implemented as an async generator; the interpreter honors `ctx.signal` for
 * cancellation by ceasing to pull from the iterator when aborted.
 */
export type StreamHandler<I, O, E, Caps extends Record<string, unknown>> = (
  input: I,
  ctx: Context<Caps>,
) => AsyncIterable<Result<O, E>>
