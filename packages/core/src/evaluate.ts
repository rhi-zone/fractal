import type { Result, Context } from './result.ts'
import { err } from './result.ts'
import type { AnyNode } from './node.ts'
import type { Capability as CapabilityCombinator } from './combinators.ts'

/**
 * Walk the reflectable union and run it against an input. This is the reference
 * interpreter the Client uses; transport interpreters (HTTP) reuse the same
 * traversal but bind I/O at the edges.
 *
 * - leaf      → call `run`
 * - seq       → run left, thread its output into right (short-circuit on error)
 * - annotated → enforce the capability gate (if any) using granted caps, then
 *               run the child unchanged (annotation transparency on success)
 * - branch    → not callable as a single node; the caller must select a child
 */
export const evaluate = async (
  node: AnyNode,
  input: unknown,
  ctx: Context,
): Promise<Result<unknown, unknown>> => {
  if (ctx.signal?.aborted) return err({ code: 'aborted' })
  switch (node.tag) {
    case 'leaf':
      return node.run(input, ctx)
    case 'seq': {
      const left = await evaluate(node.left, input, ctx)
      if (!left.ok) return left
      return evaluate(node.right, left.value, ctx)
    }
    case 'annotated': {
      const cap = node.annotation.value as Partial<CapabilityCombinator<unknown, Record<string, unknown>>>
      if (typeof cap?.enforce === 'function') {
        const verdict = cap.enforce(ctx.caps, ctx.signal)
        if (!verdict.ok) return err(verdict.error)
      }
      return evaluate(node.child, input, ctx)
    }
    case 'branch':
      return err({ code: 'not_callable', message: 'branch is not directly callable; select a child' })
  }
}

/** A callable node (anything that is not a bare branch) becomes this at the edge. */
export type Callable<I, O, E> = (input: I, ctx?: Context) => Promise<Result<O, E>>
