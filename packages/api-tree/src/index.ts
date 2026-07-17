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
