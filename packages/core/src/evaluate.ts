import type { Result, Context } from './result.ts'
import { err } from './result.ts'
import type { AnyNode, StreamLeaf } from './node.ts'
import type { Capability as CapabilityCombinator } from './combinators.ts'

/** True when a leaf node carries `mode: 'stream'` (absent mode ⇒ unary). */
const isStreamLeaf = (node: AnyNode): node is StreamLeaf<unknown, unknown, unknown, Record<string, unknown>> =>
  node.tag === 'leaf' && (node as { mode?: string }).mode === 'stream'

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
      if (isStreamLeaf(node)) {
        // A stream leaf is not unary-callable; callers must use evaluateStream.
        return err({ code: 'not_unary', message: 'leaf is streaming; use evaluateStream' })
      }
      // node is a unary Leaf here; the StreamLeaf branch returned above. The
      // type guard cannot subtract StreamLeaf (both share tag:'leaf'), so the
      // run signature is the unary Handler at runtime — call it as such.
      return (node.run as import('./result.ts').Handler<unknown, unknown, unknown, Record<string, unknown>>)(input, ctx)
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
    case 'methods': {
      // No HTTP method in core's Context: select the designated default verb.
      const child = node.verbs[node.defaultVerb]
      if (child === undefined) {
        return err({ code: 'not_callable', message: `methods node has no verb '${node.defaultVerb}'` })
      }
      return evaluate(child, input, ctx)
    }
    case 'branch':
      return err({ code: 'not_callable', message: 'branch is not directly callable; select a child' })
  }
}

/**
 * Stream interpreter — the streaming sibling of {@link evaluate}. Yields the
 * elements of a streaming node as `Result<O, E>` values.
 *
 * - leaf(stream) → pull the handler's AsyncIterable
 * - annotated    → enforce the capability gate once; on deny, yield the error and
 *                  stop (capability×stream: EAdd lands in the per-item union); on
 *                  pass, stream the child unchanged (annotation transparency)
 * - seq          → run the unary head via `evaluate`, thread its output into the
 *                  streaming tail (short-circuit: a head error is yielded once)
 * - branch       → not callable as a single node; yield a not_callable error
 *
 * Cancellation: before each pull the loop checks `ctx.signal?.aborted` and stops
 * yielding when aborted (the generator simply returns). Per the seq-non-tail
 * rule, only the tail of a seq may stream; a non-tail stream is unsupported.
 */
export async function* evaluateStream(
  node: AnyNode,
  input: unknown,
  ctx: Context,
): AsyncIterable<Result<unknown, unknown>> {
  if (ctx.signal?.aborted) return
  switch (node.tag) {
    case 'leaf': {
      if (!isStreamLeaf(node)) {
        // Treat a unary leaf in a stream position as a single-element stream.
        yield await (node.run as import('./result.ts').Handler<unknown, unknown, unknown, Record<string, unknown>>)(input, ctx)
        return
      }
      for await (const item of node.run(input, ctx)) {
        if (ctx.signal?.aborted) return
        yield item
      }
      return
    }
    case 'seq': {
      const left = await evaluate(node.left, input, ctx)
      if (!left.ok) {
        yield left
        return
      }
      yield* evaluateStream(node.right, left.value, ctx)
      return
    }
    case 'annotated': {
      const cap = node.annotation.value as Partial<CapabilityCombinator<unknown, Record<string, unknown>>>
      if (typeof cap?.enforce === 'function') {
        const verdict = cap.enforce(ctx.caps, ctx.signal)
        if (!verdict.ok) {
          yield err(verdict.error)
          return
        }
      }
      yield* evaluateStream(node.child, input, ctx)
      return
    }
    case 'methods': {
      const child = node.verbs[node.defaultVerb]
      if (child === undefined) {
        yield err({ code: 'not_callable', message: `methods node has no verb '${node.defaultVerb}'` })
        return
      }
      yield* evaluateStream(child, input, ctx)
      return
    }
    case 'branch':
      yield err({ code: 'not_callable', message: 'branch is not directly callable; select a child' })
      return
  }
}

/** A callable node (anything that is not a bare branch) becomes this at the edge. */
export type Callable<I, O, E> = (input: I, ctx?: Context) => Promise<Result<O, E>>
