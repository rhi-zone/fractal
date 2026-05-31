import type { Result, Context } from './result.ts'
import type { AnyNode, Branch, InputOf, OutputOf, ErrorOf } from './node.ts'
import { evaluate } from './evaluate.ts'

/**
 * Derive a typed client from a node tree:
 *   branch  → a nested object of clients (one per child key)
 *   leaf / seq / annotated → a callable (input) => Promise<Result<O, E>>
 * The error type includes capability-injected errors, because ErrorOf already
 * carries them (capabilities widen the union at the node type level).
 */
export type Client<N> =
  N extends Branch<infer C>
    ? { readonly [K in keyof C]: Client<C[K]> }
    : N extends AnyNode
      ? (input: InputOf<N>) => Promise<Result<OutputOf<N>, ErrorOf<N>>>
      : never

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
    return (input: unknown): Promise<Result<unknown, unknown>> => evaluate(current, input, options.ctx)
  }
  // ONE boundary cast: the dynamically-built structure conforms to Client<N>.
  return build(node) as Client<N>
}
