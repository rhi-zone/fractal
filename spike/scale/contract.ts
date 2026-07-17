// spike/scale/contract.ts — DECOUPLED typed-client prototypes.
//
// Two ways to derive a typed client WITHOUT the router threading a growing
// `Routes` tuple on every chained call:
//
//   C1  ClientOfContract<typeof contract>  — map a declared contract OBJECT
//       (tRPC-style). The object's type is inferred once at the literal; the
//       mapped type walks its keys. No per-call accumulation.
//
//   C2  buildClient([defineRoute(...), ...]) — opt-in accumulation. Each route
//       is an independent descriptor; the tuple is formed ONLY at this one call.
//
// Both reuse fractal-api-tree's per-route type machinery (PathParams, BodyOf-style
// output recovery) so the derived client matches the coupled one's ergonomics.

import type { PathParams, StandardSchema } from "@rhi-zone/fractal-api-tree"

// Recover a validated node's phantom input/output, else a plain handler's return.
type NodeInput<H> = H extends { readonly meta: { readonly __input?: infer I } }
  ? [I] extends [undefined] ? never : I
  : never
type NodeOutput<H> = H extends { readonly meta: { readonly __output?: infer O } }
  ? [O] extends [undefined]
    ? H extends (...a: never[]) => infer R ? Awaited<R> : unknown
    : O
  : H extends (...a: never[]) => infer R ? Awaited<R> : unknown

// Unwrap a phantom-typed Response (`json<T>` carries `__body`) to its domain T.
type BodyOf<O> =
  [O] extends [never] ? never
  : O extends { readonly __body?: infer T }
    ? [T] extends [undefined] ? O : T
    : O

type HasParams<P extends string> = keyof PathParams<P> extends never ? false : true
type HasInput<I> = [I] extends [never] ? false : true

type CallArgs<P extends string, I> =
  (HasParams<P> extends true ? { params: PathParams<P> } : Record<never, never>)
  & (HasInput<I> extends true ? { body: I } : Record<never, never>)

type CallSig<P extends string, I, O> =
  keyof CallArgs<P, I> extends never
    ? () => Promise<BodyOf<O>>
    : (args: CallArgs<P, I>) => Promise<BodyOf<O>>

// ---------------------------------------------------------------------------
// C1 — contract object:  { "/users/:id": { get: handler, post: node } }
// ---------------------------------------------------------------------------

/** A contract object: pattern -> method (lowercase) -> handler/node. */
export type Contract = {
  readonly [pattern: string]: {
    readonly [method: string]: unknown
  }
}

/** Map a contract object's type to the typed client surface. The pattern key is
 *  a string literal `P`; the per-method handler's input/output are recovered.
 *  No accumulation: this is one mapped type over the object's own keys. */
export type ClientOfContract<C> = {
  readonly [P in Extract<keyof C, string>]: {
    readonly [M in Extract<keyof C[P], string>]:
      CallSig<P, NodeInput<C[P][M]>, NodeOutput<C[P][M]>>
  }
}

// ---------------------------------------------------------------------------
// C2 — opt-in accumulation via defineRoute + buildClient
// ---------------------------------------------------------------------------

/** An independent route descriptor (no chained router involved). */
export interface RouteDesc<M extends string, P extends string, I, O> {
  readonly method: M
  readonly pattern: P
  readonly __input?: I
  readonly __output?: O
}

/** Build one route descriptor, recovering input/output from the handler/node. */
export function defineRoute<M extends string, P extends string, H>(
  method: M,
  pattern: P,
  _handler: H,
): RouteDesc<M, P, NodeInput<H>, NodeOutput<H>> {
  return { method, pattern } as RouteDesc<M, P, NodeInput<H>, NodeOutput<H>>
}

type Patterns<T extends readonly RouteDesc<string, string, unknown, unknown>[]> =
  T[number]["pattern"]

/** The typed client surface for an opt-in tuple of route descriptors. */
export type ClientOfDescs<T extends readonly RouteDesc<string, string, unknown, unknown>[]> = {
  readonly [P in Patterns<T>]: {
    readonly [D in Extract<T[number], { pattern: P }> as Lowercase<D["method"]>]:
      D extends RouteDesc<string, string, infer I, infer O> ? CallSig<P, I, O> : never
  }
}

/** Accumulate the tuple ONLY here, then expose the typed client. */
export function buildClient<const T extends readonly RouteDesc<string, string, unknown, unknown>[]>(
  _routes: T,
): ClientOfDescs<T> {
  return new Proxy({}, {}) as ClientOfDescs<T>
}

// silence unused-import lint for StandardSchema (re-exported convenience)
export type { StandardSchema }
