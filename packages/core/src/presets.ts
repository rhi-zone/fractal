import { ok, err } from './result.ts'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { AnyNode, InputOf, OutputOf, ErrorOf, Leaf } from './node.ts'
import {
  annotate,
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
 * The reflectable value carried by a `kind:'schema'` annotation. It has NO
 * `enforce` gate, so every interpreter walks past it transparently (the schema
 * is inert runtime data). A future OpenAPI walker reads `role` + `schema`.
 */
export interface SchemaAnnotationValue {
  readonly role: 'input' | 'output'
  readonly schema: StandardSchemaV1 | object
}

/**
 * PRIMITIVE (lower-level) — check. A type-CHANGING `seq` stage `unknown -> T`
 * built from a raw parse function whose error joins the union. This is the
 * raw-parse capability the old `validated` provided; it is now a distinct,
 * unannotated leaf you `.then` in front of a stage that consumes `T`.
 */
export const check = <T>(
  parse: (input: unknown) => Result<T, ValidationError>,
): LeafNode<unknown, T, ValidationError, Record<string, unknown>> =>
  leaf<unknown, T, ValidationError>((input) => parse(input))

/**
 * PRESET — validated. A type-CHANGING `seq` stage `unknown -> InferOutput<S>`
 * driven by a Standard Schema. The validating leaf is wrapped in a
 * `kind:'schema'` annotation (role:'input') so the schema is reflectable runtime
 * data; the annotation has NO `enforce` gate, so it is inert at runtime and
 * every interpreter walks it transparently. `validate` may be sync OR async, so
 * the result is always awaited.
 */
export const validated = <S extends StandardSchemaV1>(
  schema: S,
): AnnotatedNode<
  LeafNode<unknown, StandardSchemaV1.InferOutput<S>, ValidationError, Record<string, unknown>>,
  never,
  Record<string, never>
> =>
  annotate(
    { kind: 'schema', value: { role: 'input', schema } satisfies SchemaAnnotationValue },
    leaf<unknown, StandardSchemaV1.InferOutput<S>, ValidationError>(async (input) => {
      const r = await schema['~standard'].validate(input)
      return r.issues
        ? err({ code: 'invalid', message: r.issues.map((i) => i.message).join('; ') })
        : ok(r.value)
    }),
  )

/**
 * PRESET — returns. A symmetric, DOC-ONLY output-schema annotation. It does NOT
 * validate at runtime and preserves the I/O/E of its child exactly (role:'output'
 * annotation with no `enforce`). A future OpenAPI walker reads it as the response
 * schema.
 */
export const returns = <S extends StandardSchemaV1, Child extends AnyNode>(
  schema: S,
  child: Child,
): AnnotatedNode<Child, never, Record<string, never>> =>
  annotate({ kind: 'schema', value: { role: 'output', schema } satisfies SchemaAnnotationValue }, child)

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
