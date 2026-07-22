// packages/api-tree/src/typed-client.ts — @rhi-zone/fractal-api-tree
//
// TypedClient<N> — the fully typed shape a *remote* (out-of-process) client
// projects from a `Node` tree's own type. Sibling to `DirectApi<N>`
// (direct.ts), which does the same computation for the zero-protocol
// in-process proxy. The two diverge in exactly one place: a remote call
// carries transport-specific per-call options (HTTP's `{ timeout, signal }`,
// a future gRPC deadline, etc.) that an in-process call has no use for — so
// `TypedClient` takes a second type parameter, `CallOpts`, threaded onto
// every leaf's callable as an optional second argument. This module knows
// nothing about HTTP; `CallOpts` is supplied by whichever projector builds
// the client (see packages/http-api-projector/src/client.ts's `createClient`,
// which instantiates `TypedClient<N, CallOptions>`).
//
// Mirrors `DirectApi`'s three Node shapes (leaf / branch / both) and its
// `Slugs` accumulator for fallback-captured params — see that module's doc
// for the full rationale; repeated here only where the two actually differ.
//
// See:
//   packages/api-tree/src/direct.ts               — DirectApi<N>, the in-process analogue
//   packages/api-tree/src/node.ts                  — Node, Handler, fallback, isLeaf
//   packages/http-api-projector/src/client.ts     — createClient, CallOptions

import type { Handler, Node } from "./node.ts"

/**
 * The fully typed shape of a remote client built from a `Node` tree.
 *
 * - Callable part: present only when `N["handler"]` is a concrete function
 *   type. Accumulated `Slugs` (fallback-captured param names) are
 *   subtracted from the handler's input, same as `DirectApi` — a client
 *   caller never re-supplies a value already bound by
 *   `.someSlug("value")` on the way down. When the remaining input has no
 *   required keys, the input argument itself becomes optional (`input?:`)
 *   rather than disappearing outright, so an options-only call
 *   (`fn(undefined, opts)`) stays possible when `CallOpts` is non-`never`.
 *   The result is `Promise<Awaited<R>>` so an already-async handler doesn't
 *   double-wrap.
 * - Children part: each child key maps to `TypedClient` of that child's own
 *   node type, recursively, threading `CallOpts` and `Slugs` through
 *   unchanged.
 * - Fallback part: `fallback.name`'s literal string becomes the key, whose
 *   value is `(slugValue: string) => TypedClient<subtree, CallOpts, Slugs | Name>`.
 *
 * The three parts intersect (`&`), matching a co-located node (handler AND
 * children) becoming callable AND carrying child members.
 *
 * `CallOpts` defaults to `never`: with no projector-specific options type
 * supplied, every leaf's optional second parameter can only ever be
 * omitted — there is no generic "some options object" to accept, so `never`
 * (rather than e.g. `unknown`) keeps a bare `TypedClient<N>` from accepting
 * arbitrary junk as a second argument.
 */
export type TypedClient<N extends Node, CallOpts = never, Slugs extends string = never> =
  // Callable part — subtract accumulated slug keys from handler input
  (N extends { readonly handler: infer H extends Handler }
    ? H extends (input: infer I) => infer R
      ? keyof Omit<I, Slugs> extends never
        ? (input?: undefined, opts?: CallOpts) => Promise<Awaited<R>>
        : (input: Omit<I, Slugs>, opts?: CallOpts) => Promise<Awaited<R>>
      : never
    : unknown)
  // Children part — pass CallOpts/slugs through
  & (N extends { readonly children: infer C extends Readonly<Record<string, Node>> }
    ? { readonly [K in keyof C]: TypedClient<C[K], CallOpts, Slugs> }
    : unknown)
  // Fallback part — accumulate the fallback name into Slugs for the subtree
  & (N extends { readonly fallback: { readonly name: infer Name extends string; readonly subtree: infer S extends Node } }
    ? { readonly [K in Name]: (slugValue: string) => TypedClient<S, CallOpts, Slugs | Name> }
    : unknown)
