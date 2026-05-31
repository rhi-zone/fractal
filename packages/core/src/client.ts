import type { Result, Context } from './result.ts'
import type { AnyNode, Branch, InputOf, OutputOf, ErrorOf, ModeOf } from './node.ts'
import { evaluate, evaluateStream } from './evaluate.ts'

/**
 * Runtime mirror of {@link ModeOf}: a node streams iff its effective tail leaf
 * carries `mode: 'stream'`. Sees through `seq` (tail = right), `annotated`
 * (tail = child); a `branch` is never directly callable, so 'unary' is fine.
 */
const runtimeMode = (node: AnyNode): 'unary' | 'stream' => {
  switch (node.tag) {
    case 'leaf':
      return (node as { mode?: string }).mode === 'stream' ? 'stream' : 'unary'
    case 'seq':
      return runtimeMode(node.right)
    case 'annotated':
      return runtimeMode(node.child)
    case 'branch':
      return 'unary'
  }
}

/**
 * Open per-call metadata threaded alongside the input. Transports (next step)
 * map this onto headers / envelope fields; in core it is carried in the method
 * TYPES and is otherwise inert. Optional on every call.
 */
export type Meta = Record<string, unknown>

/**
 * Derive a typed client from a node tree, mode-aware (the "U" = unified, covers
 * both unary and streaming leaves):
 *   branch         → a nested object of clients (one per child key)
 *   streaming leaf → (input, meta?) => AsyncIterable<Result<O, E>>
 *   unary  leaf/seq/annotated → (input, meta?) => Promise<Result<O, E>>
 * The error type includes capability-injected errors, because ErrorOf already
 * carries them (capabilities widen the union at the node type level); a stream's
 * per-item Result therefore also carries the widened error union.
 */
export type UClient<N> =
  N extends Branch<infer C>
    ? { readonly [K in keyof C]: UClient<C[K]> }
    : N extends AnyNode
      ? ModeOf<N> extends 'stream'
        ? (input: InputOf<N>, meta?: Meta) => AsyncIterable<Result<OutputOf<N>, ErrorOf<N>>>
        : (input: InputOf<N>, meta?: Meta) => Promise<Result<OutputOf<N>, ErrorOf<N>>>
      : never

/**
 * Derive a typed client from a node tree. `Client` is the UNARY-shaped alias of
 * {@link UClient}: for a tree of only unary leaves the two are identical, and
 * the method shape is the historical `(input, meta?) => Promise<Result<O,E>>`
 * (the optional `meta?` arg is additive — existing zero/one-arg call sites stay
 * assignable). Prefer {@link UClient} for trees that contain streaming leaves.
 */
export type Client<N> = UClient<N>

/** Options for {@link client}: the context to thread into every call. */
export interface ClientOptions<Caps extends Record<string, unknown>> {
  readonly ctx: Context<Caps>
}

/**
 * Build a runtime client over a tree. Branches become Proxy objects whose keys
 * resolve to child clients; callable nodes become functions that run via the
 * reference interpreter. Exactly ONE boundary cast bridges the dynamic Proxy to
 * the derived `Client<N>` type.
 */
export const client = <N extends AnyNode>(node: N, options: ClientOptions<Record<string, unknown>>): Client<N> => {
  const build = (current: AnyNode): unknown => {
    if (current.tag === 'branch') {
      const children = current.children as Record<string, AnyNode>
      return new Proxy(
        {},
        {
          get: (_t, prop: string | symbol) => {
            if (typeof prop !== 'string' || !(prop in children)) return undefined
            const child = children[prop]
            return child === undefined ? undefined : build(child)
          },
          has: (_t, prop) => typeof prop === 'string' && prop in children,
          ownKeys: () => Object.keys(children),
          getOwnPropertyDescriptor: (_t, prop) =>
            typeof prop === 'string' && prop in children
              ? { enumerable: true, configurable: true }
              : undefined,
        },
      )
    }
    if (runtimeMode(current) === 'stream') {
      // meta is inert in core (threaded by transports next step); accepted here
      // so the runtime shape matches the UClient method type.
      return (input: unknown, _meta?: Meta): AsyncIterable<Result<unknown, unknown>> =>
        evaluateStream(current, input, options.ctx)
    }
    return (input: unknown, _meta?: Meta): Promise<Result<unknown, unknown>> => evaluate(current, input, options.ctx)
  }
  // ONE boundary cast: the dynamically-built structure conforms to Client<N>.
  return build(node) as Client<N>
}
