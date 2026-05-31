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
