import { ok, err } from './result.ts'
import type { AnyNode, InputOf, OutputOf, ErrorOf, Leaf } from './node.ts'
import {
  branch,
  capability,
  identity,
  leaf,
  withCapability,
  type AnnotatedNode,
  type BranchNode,
  type Chainable,
  type LeafNode,
  type SeqNode,
} from './combinators.ts'

// Presets are INSTANCES built purely from primitives, not new node variants.

/** A typed authentication error contributed by the auth capability. */
export interface UnauthorizedError {
  readonly code: 'unauthorized'
}

/** The pre-opened handle the auth capability requires. */
export type AuthCaps = {
  readonly auth: { readonly user: string | null }
}

/**
 * PRESET — withAuth. A capability (type-preserving) that injects an
 * `unauthorized` error and requires an `auth` handle. Built from `capability` +
 * `withCapability`; core is not edited to introduce it.
 */
export const withAuth = <Child extends AnyNode>(child: Child): AnnotatedNode<Child, UnauthorizedError, AuthCaps> =>
  withCapability(
    capability<UnauthorizedError, AuthCaps>('auth', {
      // No granted handle, or no user on it, ⇒ unauthorized (capability security:
      // absence of a valid grant denies, never throws).
      enforce: (caps) =>
        caps.auth?.user ? { ok: true } : { ok: false, error: { code: 'unauthorized' } },
    }),
    child,
  )

/** A typed rate-limit error contributed by the rate-limit capability. */
export interface RateLimitedError {
  readonly code: 'rate_limited'
}

/** The pre-opened handle the rate-limit capability requires. */
export type RateLimitCaps = {
  readonly limiter: { take(): boolean }
}

/**
 * PRESET — withRateLimit. An independent capability with its OWN error type,
 * proving error widening needs no central map.
 */
export const withRateLimit = <Child extends AnyNode>(child: Child): AnnotatedNode<Child, RateLimitedError, RateLimitCaps> =>
  withCapability(
    capability<RateLimitedError, RateLimitCaps>('rate-limit', {
      enforce: (caps) =>
        caps.limiter.take() ? { ok: true } : { ok: false, error: { code: 'rate_limited' } },
    }),
    child,
  )

/** A typed validation error contributed by a `validated` seq stage. */
export interface ValidationError {
  readonly code: 'invalid'
  readonly message: string
}

/**
 * PRESET — validated. A type-CHANGING `seq` stage `unknown -> T` whose error
 * joins the union. Validation is a seq stage, NOT a capability (it changes the
 * type). Returns a leaf you `.then` in front of a stage that consumes `T`.
 */
export const validated = <T>(
  parse: (input: unknown) => Result<T, ValidationError>,
): LeafNode<unknown, T, ValidationError, Record<string, unknown>> =>
  leaf<unknown, T, ValidationError>((input) => parse(input))

import type { Result } from './result.ts'

/**
 * PRESET — route. Sugar over `branch`: groups named sub-routes. Identical to
 * `branch` but documents intent at HTTP/RPC seams.
 */
export const route = <C extends Record<string, AnyNode>>(children: C): BranchNode<C> => branch(children)

/**
 * PRESET — get. A read leaf. Sugar over `leaf` to mark a CRUD read at the seam.
 */
export const get = <I = unknown, O = unknown, E = never, Caps extends Record<string, unknown> = Record<string, unknown>>(
  run: (input: I, ctx: { readonly caps: Caps; readonly signal?: AbortSignal }) => Result<O, E> | Promise<Result<O, E>>,
): LeafNode<I, O, E, Caps> => leaf<I, O, E, Caps>(run)

export { ok, err, identity }
export type { Chainable, LeafNode, SeqNode, AnnotatedNode }
export type { Leaf, AnyNode, InputOf, OutputOf, ErrorOf }
